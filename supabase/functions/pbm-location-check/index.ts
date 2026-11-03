// ===== SUPABASE EDGE FUNCTION: pbm-location-check =====
// Tells Michael by email when his Kalshi location check is verified again.
// Kalshi has no "is my location OK" endpoint, so while a check cycle is open (the Tuesday reminder
// or a location-refused bet sets kalshi_status.location.last_alert_at) this sends ONE tiny test order
// every 15 minutes: buy 1 YES contract at 1¢, immediate-or-cancel, on a market whose cheapest seller is
// well above 1¢ - so it cannot fill and cancels instantly. Worst case it costs 1¢.
// The test order is NEVER written to my_bets (so it can't trip the repeat-bet block or show as a bet),
// and it skips combo and politics markets. Cron only (x-pbm-cron).
import { createClient } from "npm:@supabase/supabase-js@2";

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
const ENV = (Deno.env.get("KALSHI_ENV") ?? "prod").toLowerCase();
const BASE = ENV === "demo" ? "https://external-api.demo.kalshi.co" : "https://api.elections.kalshi.com";
const PREFIX = "/trade-api/v2";
const CYCLE_HOURS = 30;          // stop checking 30 h after the reminder
const ASSUME_GOOD_AFTER_H = 4;   // never saw it expire but orders keep going through 4 h after the reminder -> it's good

function pemBytes(pem: string) {
  const b64 = pem.replace(/-----[^-]+-----/g, "").replace(/\\n/g, "").replace(/\s+/g, "");
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}
function derLen(n: number) { if (n < 0x80) return [n]; const o: number[] = []; while (n > 0) { o.unshift(n & 0xff); n >>= 8; } return [0x80 | o.length, ...o]; }
function pkcs1ToPkcs8(p1: Uint8Array) {
  const algo = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  const body = [0x02, 0x01, 0x00, ...algo, 0x04, ...derLen(p1.length)];
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
  try {
    const k = await crypto.subtle.importKey("pkcs8", der, { name: "RSA-PSS", hash: "SHA-256" }, false, ["sign"]);
    signer = (m) => crypto.subtle.sign({ name: "RSA-PSS", saltLength: 32 }, k, m);
  } catch {
    const k = await crypto.subtle.importKey("pkcs8", der, { name: "Ed25519" }, false, ["sign"]);
    signer = (m) => crypto.subtle.sign({ name: "Ed25519" }, k, m);
  }
  return signer;
}
async function kalshi(method: string, path: string, body?: unknown) {
  const sign = await getSigner();
  const ts = Date.now().toString();
  const full = PREFIX + path;
  const sig = await sign(new TextEncoder().encode(ts + method + full.split("?")[0]));
  const r = await fetch(BASE + full, {
    method,
    headers: {
      "KALSHI-ACCESS-KEY": Deno.env.get("KALSHI_API_KEY_ID")!, "KALSHI-ACCESS-TIMESTAMP": ts,
      "KALSHI-ACCESS-SIGNATURE": btoa(String.fromCharCode(...new Uint8Array(sig))), "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const t = await r.text();
  let d: any = null; try { d = JSON.parse(t); } catch { d = { raw: t.slice(0, 300) }; }
  return { ok: r.ok, status: r.status, data: d };
}
const isLocationErr = (d: unknown) => /location_attestation/i.test(JSON.stringify(d ?? ""));
const dollars = (d: any, c: any) => (d != null ? Number(d) : c != null ? Number(c) / 100 : 0);

// A liquid, non-sports, non-politics market whose cheapest seller is 10¢+ (so a 1¢ buy can't fill).
async function probeMarket() {
  let cursor = "";
  for (let page = 0; page < 6; page++) {
    const r = await kalshi("GET", `/markets?status=open&mve_filter=exclude&limit=500${cursor ? "&cursor=" + encodeURIComponent(cursor) : ""}`);
    const ms = (r.data?.markets ?? []).filter((m: any) => {
      const t = String(m.ticker), ask = dollars(m.yes_ask_dollars, m.yes_ask);
      return !/^(KXMVE|SENATE|GOV|KXMAYOR|HOUSE|PRES)/.test(t) && ask >= 0.10 && ask < 1;
    });
    if (ms.length) {
      ms.sort((a: any, b: any) => Number(b.volume_24h_fp ?? b.volume_24h ?? 0) - Number(a.volume_24h_fp ?? a.volume_24h ?? 0));
      return ms[0].ticker;
    }
    cursor = r.data?.cursor;
    if (!cursor) break;
  }
  return null;
}

async function emailOwner(sb: any, subject: string, title: string, html: string) {
  const { data: o } = await sb.from("app_members").select("user_id").eq("role", "owner").limit(1).maybeSingle();
  const { data: cfg } = await sb.from("private_config").select("value").eq("key", "cron_token").single();
  if (!o?.user_id || !cfg?.value) return false;
  const r = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/pbm-email`, {
    method: "POST", headers: { "Content-Type": "application/json", "x-pbm-cron": cfg.value },
    body: JSON.stringify({ action: "send", kind: "auto_bets", user_id: o.user_id, subject, title, html }),
  });
  return r.ok;
}
const etTime = (d: Date) => d.toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "2-digit" });

Deno.serve(async (req) => {
  try {
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: cfg } = await sb.from("private_config").select("value").eq("key", "cron_token").single();
    if (!cfg?.value || req.headers.get("x-pbm-cron") !== cfg.value) return json({ ok: false, error: "not allowed" }, 401);
    const body = await req.json().catch(() => ({}));

    const { data: loc } = await sb.from("kalshi_status").select("*").eq("key", "location").maybeSingle();
    const { data: probe } = await sb.from("kalshi_status").select("*").eq("key", "location_probe").maybeSingle();
    const now = new Date();
    const start = loc?.last_alert_at ? new Date(loc.last_alert_at) : null;
    if (!body.force) {
      if (!start || now.getTime() - start.getTime() > CYCLE_HOURS * 3600e3) return json({ ok: true, skipped: "no open check" });
      if (probe?.ok_at && new Date(probe.ok_at) >= start) return json({ ok: true, skipped: "already verified this cycle" });
    }

    const ticker = await probeMarket();
    if (!ticker) return json({ ok: false, error: "no test market found" });
    const r = await kalshi("POST", "/portfolio/events/orders", {
      ticker, side: "bid", count: "1.00", price: "0.01", time_in_force: "immediate_or_cancel",
      self_trade_prevention_type: "taker_at_cross", client_order_id: crypto.randomUUID(),
    });

    // Tell the security watchdog this is our own test order, so its alert says "Test order to keep Kalshi alive".
    const oid = r.data?.order?.order_id ?? r.data?.order_id;
    if (oid) await sb.from("watchdog_alerts").upsert({ key: `loctest:${oid}`, kind: "note", title: "PBM location test order", detail: ticker, resolved_at: now.toISOString() });

    if (!r.ok && isLocationErr(r.data)) {
      await sb.from("kalshi_status").upsert({ key: "location_probe", ok: false, failed_at: now.toISOString(), last_alert_at: start?.toISOString() ?? null, detail: `test order refused for location at ${etTime(now)}` });
      await sb.from("kalshi_status").update({ ok: false, failed_at: now.toISOString() }).eq("key", "location");
      return json({ ok: true, location: "expired", ticker });
    }
    if (!r.ok) return json({ ok: false, error: `test order error ${r.status}: ${JSON.stringify(r.data).slice(0, 200)}`, ticker });

    // Kalshi accepted the order -> location is good right now
    const sawFail = !!(probe?.failed_at && start && new Date(probe.failed_at) >= start);
    const oldEnough = start && now.getTime() - start.getTime() >= ASSUME_GOOD_AFTER_H * 3600e3;
    if (!sawFail && !oldEnough && !body.force) return json({ ok: true, location: "ok (not expired yet) - keep checking", ticker });

    const good = new Date(now.getTime() + 7 * 864e5);
    const html = sawFail
      ? `Your Kalshi location check is <b>verified</b> &#10003;. Play Book Matrix bets are working again - yours, Tyler's and the Auto Better's.<br><br>Confirmed ${etTime(now)} ET. It's good for 7 days (until about ${etTime(good)} ET).`
      : `Kalshi is accepting orders, so your location check is <b>good</b> &#10003;. Play Book Matrix bets are working - yours, Tyler's and the Auto Better's.<br><br>Confirmed ${etTime(now)} ET.`;
    const sent = await emailOwner(sb, "Kalshi location verified ✓", "Location verified", html);
    await sb.from("kalshi_status").upsert({ key: "location_probe", ok: true, ok_at: now.toISOString(), failed_at: probe?.failed_at ?? null, last_alert_at: start?.toISOString() ?? null, detail: `verified ${etTime(now)} ET${sent ? ", email sent" : ", EMAIL FAILED"}` });
    await sb.from("kalshi_status").update({ ok: true, ok_at: now.toISOString(), detail: `verified ${etTime(now)} ET by test order; good ~7 days` }).eq("key", "location");
    return json({ ok: true, location: "verified", emailed: sent, ticker, fill: r.data?.order?.fill_count_fp ?? r.data?.fill_count_fp ?? null });
  } catch (err) {
    return json({ ok: false, error: String(err instanceof Error ? err.message : err) }, 500);
  }
});
