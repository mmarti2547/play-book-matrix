// ===== SUPABASE EDGE FUNCTION: pbm-fill-check =====
// 2026-11-03 Parlay fill check. Kalshi combo (parlay) orders can be "accepted" without ever filling; the app used to log
// them as placed and then grade them from the box score (Nov 2: a $228 "win" that never existed on Kalshi).
// Every 5 min: for Kalshi parlays placed in the last 14 days, read Kalshi FILLS for the combo market (read-only GETs).
//  - fills found  -> record real contracts and real cost (kalshi_cost incl. fees), fill_status 'filled'
//  - no fills 10+ min after placing -> fill_status 'not_filled', status 'not_filled', result 'void', stake 0, payout 0
// Never places, cancels or sells anything. Auth: x-pbm-cron. body {dry_run:true} reports without writing.
import { createClient } from "npm:@supabase/supabase-js@2";

const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } });
const ENV = (Deno.env.get("KALSHI_ENV") ?? "prod").toLowerCase();
const BASE = ENV === "demo" ? "https://external-api.demo.kalshi.co" : "https://api.elections.kalshi.com";
const PREFIX = "/trade-api/v2";

function pemBytes(pem: string) {
  const b64 = pem.replace(/-----[^-]+-----/g, "").replace(/\\n/g, "").replace(/\s+/g, "");
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}
function derLen(n: number) { if (n < 0x80) return [n]; const out: number[] = []; while (n > 0) { out.unshift(n & 0xff); n >>= 8; } return [0x80 | out.length, ...out]; }
function pkcs1ToPkcs8(p1: Uint8Array) {
  const algo = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  const oct = [0x04, ...derLen(p1.length)];
  const body = [0x02, 0x01, 0x00, ...algo, ...oct];
  const total = body.length + p1.length;
  const out = new Uint8Array(1 + derLen(total).length + total);
  out.set([0x30, ...derLen(total), ...body]); out.set(p1, out.length - p1.length); return out;
}
let signer: ((m: Uint8Array) => Promise<ArrayBuffer>) | null = null;
async function getSigner() {
  if (signer) return signer;
  const pem = Deno.env.get("KALSHI_PRIVATE_KEY")!;
  const raw = pemBytes(pem);
  const der = pem.includes("BEGIN RSA PRIVATE KEY") ? pkcs1ToPkcs8(raw) : raw;
  try { const k = await crypto.subtle.importKey("pkcs8", der, { name: "RSA-PSS", hash: "SHA-256" }, false, ["sign"]); signer = (m) => crypto.subtle.sign({ name: "RSA-PSS", saltLength: 32 }, k, m); }
  catch { const k = await crypto.subtle.importKey("pkcs8", der, { name: "Ed25519" }, false, ["sign"]); signer = (m) => crypto.subtle.sign({ name: "Ed25519" }, k, m); }
  return signer;
}
async function kget(path: string) {
  const sign = await getSigner();
  const ts = Date.now().toString(); const full = PREFIX + path;
  const sig = await sign(new TextEncoder().encode(ts + "GET" + full.split("?")[0]));
  for (let i = 0; i < 3; i++) {
    const r = await fetch(BASE + full, { headers: { "KALSHI-ACCESS-KEY": Deno.env.get("KALSHI_API_KEY_ID")!, "KALSHI-ACCESS-TIMESTAMP": ts, "KALSHI-ACCESS-SIGNATURE": btoa(String.fromCharCode(...new Uint8Array(sig))) } });
    if (r.status === 429) { await new Promise((res) => setTimeout(res, 700 * (i + 1))); continue; }
    const t = await r.text(); let d: any = null; try { d = JSON.parse(t); } catch { d = { raw: t }; }
    return { ok: r.ok, status: r.status, data: d };
  }
  return { ok: false, status: 429, data: null };
}
const num = (v: any) => (v == null || v === "" ? 0 : Number(v));
const dollars = (d: any, c: any) => (d != null && d !== "" ? Number(d) : c != null ? Number(c) / 100 : 0);

Deno.serve(async (req) => {
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const tok = req.headers.get("x-pbm-cron");
  const { data: cfg } = await sb.from("private_config").select("value").eq("key", "cron_token").single();
  if (!tok || !cfg || cfg.value !== tok) return json({ ok: false, error: "not authorized" }, 401);
  let body: any = {}; try { body = await req.json(); } catch { /* empty */ }
  const dry = body.dry_run === true;
  const since = new Date(Date.now() - 14 * 86400e3).toISOString();
  let q = sb.from("my_bets").select("id,user_id,pick,stake,contracts,status,result,payout,ticker,placed_at,fill_status")
    .eq("book", "Kalshi").eq("market", "parlay").gte("placed_at", since).not("ticker", "is", null).order("placed_at", { ascending: false }).limit(60);
  if (Array.isArray(body.ids) && body.ids.length) q = q.in("id", body.ids.map(Number));
  else q = q.or("fill_status.is.null,fill_status.eq.pending");
  const { data: bets, error } = await q;
  if (error) return json({ ok: false, error: error.message }, 500);
  const report: any[] = [];
  for (const b of bets ?? []) {
    const f = await kget(`/portfolio/fills?ticker=${encodeURIComponent(b.ticker)}&limit=100`);
    if (!f.ok) { report.push({ id: b.id, error: `fills ${f.status}` }); continue; }
    const fills = (f.data?.fills ?? []).filter((x: any) => x.ticker === b.ticker || x.market_ticker === b.ticker || !x.ticker);
    const buys = fills.filter((x: any) => x.action === "buy");
    const count = buys.reduce((s: number, x: any) => s + num(x.count_fp ?? x.count), 0);
    const cost = buys.reduce((s: number, x: any) => s + num(x.count_fp ?? x.count) * (x.side === "no" ? dollars(x.no_price_dollars, x.no_price) : dollars(x.yes_price_dollars, x.yes_price)) + dollars(x.fee_cost_dollars ?? x.fee_dollars, x.fee_cost ?? x.fee), 0);
    const ageMin = (Date.now() - new Date(b.placed_at).getTime()) / 60000;
    let patch: any = null, verdict: string;
    if (count > 0) {
      verdict = "filled";
      patch = { fill_status: "filled", fill_checked_at: new Date().toISOString(), kalshi_cost: +cost.toFixed(2), kalshi_contracts: count };
      if (Math.abs(count - num(b.contracts)) > 0.5) patch.contracts = count;
    } else if (ageMin >= 10) {
      verdict = "not_filled";
      patch = { fill_status: "not_filled", fill_checked_at: new Date().toISOString(), status: "not_filled", result: "void", payout: 0, kalshi_cost: 0, kalshi_contracts: 0, stake_logged: b.stake, stake: 0 };
    } else { verdict = "pending"; patch = { fill_status: "pending", fill_checked_at: new Date().toISOString() }; }
    report.push({ id: b.id, verdict, logged_stake: b.stake, logged_contracts: b.contracts, kalshi_contracts: count, kalshi_cost: +cost.toFixed(2), was: `${b.status}/${b.result}`, pick: String(b.pick).slice(0, 70) });
    if (!dry && patch) { const { error: e2 } = await sb.from("my_bets").update(patch).eq("id", b.id); if (e2) report[report.length - 1].write_error = e2.message; }
  }
  return json({ ok: true, dry_run: dry, checked: report.length, report });
});
