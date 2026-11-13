// ===== SUPABASE EDGE FUNCTION: pbm-audit =====
// 2026-11-13 Kalshi order reconciliation for the watchdog (replaces pbm-kalshi's audit_orders).
// Old check skipped ANY Kalshi order on a market that already had an app bet, so a second buy on the same
// market (e.g. WAS 11/12: app bet #114 + a buy in the Kalshi app) was never flagged. This one matches by
// Kalshi order id. Only parlay combo markets (KXMVE..., accepted quotes) still match by market.
// Read-only: never places, changes or cancels anything. Cron token required.
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-pbm-cron" };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });
const ENV = (Deno.env.get("KALSHI_ENV") ?? "prod").toLowerCase();
const BASE = ENV === "demo" ? "https://external-api.demo.kalshi.co" : "https://api.elections.kalshi.com";
const PREFIX = "/trade-api/v2";

// ---------- key handling (RSA PKCS#1, RSA PKCS#8, or Ed25519 PKCS#8) ----------
function pemBytes(pem: string) {
  const b64 = pem.replace(/-----[^-]+-----/g, "").replace(/\\n/g, "").replace(/\s+/g, "");
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}
function derLen(n: number) {
  if (n < 0x80) return [n];
  const out: number[] = [];
  while (n > 0) { out.unshift(n & 0xff); n >>= 8; }
  return [0x80 | out.length, ...out];
}
function pkcs1ToPkcs8(p1: Uint8Array) {
  const algo = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  const oct = [0x04, ...derLen(p1.length)];
  const body = [0x02, 0x01, 0x00, ...algo, ...oct];
  const total = body.length + p1.length;
  const out = new Uint8Array(1 + derLen(total).length + total);
  out.set([0x30, ...derLen(total), ...body]);
  out.set(p1, out.length - p1.length);
  return out;
}
let signer: ((msg: Uint8Array) => Promise<ArrayBuffer>) | null = null;
async function getSigner() {
  if (signer) return signer;
  const pem = Deno.env.get("KALSHI_PRIVATE_KEY");
  if (!pem || !Deno.env.get("KALSHI_API_KEY_ID")) throw new Error("Kalshi is not connected: add KALSHI_API_KEY_ID and KALSHI_PRIVATE_KEY secrets");
  const raw = pemBytes(pem);
  const der = pem.includes("BEGIN RSA PRIVATE KEY") ? pkcs1ToPkcs8(raw) : raw;
  try {
    const k = await crypto.subtle.importKey("pkcs8", der, { name: "RSA-PSS", hash: "SHA-256" }, false, ["sign"]);
    signer = (m) => crypto.subtle.sign({ name: "RSA-PSS", saltLength: 32 }, k, m);
  } catch {
    const k = await crypto.subtle.importKey("pkcs8", der, { name: "Ed25519" }, false, ["sign"]);
    signer = (m) => crypto.subtle.sign({ name: "Ed25519" }, k, m);
  }
  return signer;
}

async function kalshiGet(path: string) {
  let last: any = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const sign = await getSigner();
    const ts = Date.now().toString();
    const full = PREFIX + path;
    const sig = await sign(new TextEncoder().encode(ts + "GET" + full.split("?")[0]));
    const r = await fetch(BASE + full, { headers: {
      "KALSHI-ACCESS-KEY": Deno.env.get("KALSHI_API_KEY_ID")!, "KALSHI-ACCESS-TIMESTAMP": ts,
      "KALSHI-ACCESS-SIGNATURE": btoa(String.fromCharCode(...new Uint8Array(sig))) } });
    const text = await r.text();
    let data: any = null; try { data = JSON.parse(text); } catch { data = { raw: text }; }
    last = { status: r.status, ok: r.ok, data };
    if (r.status !== 429) return last;
    await new Promise((res) => setTimeout(res, 800 * (attempt + 1) + Math.floor(Math.random() * 600)));
  }
  return last;
}
async function pages(path: string, key: string) {
  const out: any[] = []; let cursor = ""; let res: any = null;
  for (let p = 0; p < 5; p++) {
    res = await kalshiGet(`${path}${path.includes("?") ? "&" : "?"}limit=200${cursor ? "&cursor=" + cursor : ""}`);
    if (!res.ok) return { ok: false, status: res.status, rows: out };
    out.push(...(res.data?.[key] ?? []));
    cursor = res.data?.cursor; if (!cursor) break;
  }
  return { ok: true, status: 200, rows: out };
}

async function audit(sb: any, hours: number) {
  const minTs = Math.floor(Date.now() / 1000 - hours * 3600);
  const o = await pages(`/portfolio/orders?min_ts=${minTs}`, "orders");
  const f = await pages(`/portfolio/fills?min_ts=${minTs}`, "fills");
  if (!o.ok && !f.ok) return { ok: false, error: `Kalshi did not answer (orders ${o.status}, fills ${f.status})` };
  const { data: bets } = await sb.from("my_bets").select("external_order_id,ticker,placed_at,market").eq("book", "Kalshi")
    .gte("placed_at", new Date(Date.now() - (hours + 24 * 14) * 3600e3).toISOString());
  const ids = new Set<string>(), comboTickers = new Set<string>();
  const manual: { ticker: string; at: number }[] = [];   // bets typed in by hand (placed in the Kalshi app, no order id)
  for (const b of bets ?? []) {
    const id = String(b.external_order_id ?? "");
    if (id.startsWith("kalshi-app-manual")) { if (b.ticker) manual.push({ ticker: String(b.ticker), at: new Date(b.placed_at).getTime() }); continue; }
    if (id) ids.add(id);
    if (b.ticker && (b.market === "parlay" || String(b.ticker).startsWith("KXMVE"))) comboTickers.add(String(b.ticker));
  }
  const unknown = new Map<string, any>();
  for (const x of [...o.rows, ...f.rows]) {
    const id = String(x.order_id ?? ""); const t = String(x.ticker ?? x.market_ticker ?? "");
    if (!id || ids.has(id) || unknown.has(id)) continue;
    if (t && comboTickers.has(t)) continue;
    const at = x.created_time ?? x.ts ?? null;
    const atMs = at ? (typeof at === "number" ? at * 1000 : new Date(at).getTime()) : NaN;
    if (manual.some((m) => m.ticker === t && Math.abs(m.at - atMs) < 45 * 60e3)) continue;   // already logged by hand
    unknown.set(id, { order_id: id, ticker: t, side: x.side ?? null, action: x.action ?? null, status: x.status ?? "filled",
      contracts: Number(x.count_fp ?? x.count ?? x.fill_count_fp ?? x.fill_count ?? x.initial_count_fp ?? x.initial_count ?? 0),
      price: x.yes_price_dollars ?? x.yes_price ?? null, at });
  }
  return { ok: true, checked: o.rows.length + f.rows.length, unknown: [...unknown.values()] };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const tok = req.headers.get("x-pbm-cron");
    const { data: cfg } = await sb.from("private_config").select("value").eq("key", "cron_token").single();
    if (!tok || !cfg || cfg.value !== tok) return json({ ok: false, error: "not authorized" }, 401);
    const body = await req.json().catch(() => ({}));
    return json(await audit(sb, Math.min(24 * 7, Math.max(1, Number(body.hours ?? 26)))));
  } catch (e) { return json({ ok: false, error: String(e) }, 500); }
});
