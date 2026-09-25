// ===== SUPABASE EDGE FUNCTION: pbm-kalshi =====
// Kalshi bridge for Play Book Matrix. Keys live only in Edge Function secrets
// (KALSHI_API_KEY_ID, KALSHI_PRIVATE_KEY, optional KALSHI_ENV=prod|demo, KALSHI_ALLOWED_EMAILS).
// Actions: status (balance), market (find the NFL game-winner market), order (ONLY with confirm:true).
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });

const ENV = (Deno.env.get("KALSHI_ENV") ?? "prod").toLowerCase();
const BASE = ENV === "demo" ? "https://external-api.demo.kalshi.co" : "https://api.elections.kalshi.com";
const PREFIX = "/trade-api/v2";
const MAX_ORDER_USD = Number(Deno.env.get("KALSHI_MAX_ORDER_USD") ?? "500"); // safety cap per order

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

async function kalshi(method: string, path: string, body?: unknown) {
  const sign = await getSigner();
  const ts = Date.now().toString();
  const full = PREFIX + path;
  const sig = await sign(new TextEncoder().encode(ts + method + full.split("?")[0]));
  const r = await fetch(BASE + full, {
    method,
    headers: {
      "KALSHI-ACCESS-KEY": Deno.env.get("KALSHI_API_KEY_ID")!,
      "KALSHI-ACCESS-TIMESTAMP": ts,
      "KALSHI-ACCESS-SIGNATURE": btoa(String.fromCharCode(...new Uint8Array(sig))),
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data: any = null;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { status: r.status, ok: r.ok, data };
}

// ---------- NFL game-winner market lookup ----------
const ALIAS: Record<string, string> = { LAR: "LA", JAC: "JAX", WSH: "WAS", LVR: "LV", ARZ: "ARI", GNB: "GB", KAN: "KC", NWE: "NE", NOR: "NO", SFO: "SF", TAM: "TB" };
const norm = (t: string) => ALIAS[t?.toUpperCase()] ?? t?.toUpperCase();
const MON = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

async function findMarkets(g: any) {
  const d = new Date(g.game_date_et + "T12:00:00Z");
  const dateCode = String(d.getUTCFullYear()).slice(2) + MON[d.getUTCMonth()] + String(d.getUTCDate()).padStart(2, "0");
  let cursor = "";
  for (let page = 0; page < 5; page++) {
    const r = await kalshi("GET", `/events?series_ticker=KXNFLGAME&status=open&with_nested_markets=true&limit=200${cursor ? "&cursor=" + cursor : ""}`);
    if (!r.ok) throw new Error(`Kalshi events ${r.status}: ${JSON.stringify(r.data).slice(0, 300)}`);
    for (const ev of r.data.events ?? []) {
      if (!String(ev.event_ticker).includes(dateCode)) continue;
      const mk = (ev.markets ?? []).map((m: any) => ({ ...m, team: norm(String(m.ticker).split("-").pop()!) }));
      const teams = new Set(mk.map((m: any) => m.team));
      if (teams.has(g.home_team) && teams.has(g.away_team)) {
        return {
          event_ticker: ev.event_ticker, title: ev.title,
          markets: mk.map((m: any) => ({
            ticker: m.ticker, team: m.team, name: m.yes_sub_title, status: m.status,
            yes_bid: Number(m.yes_bid_dollars ?? (m.yes_bid ?? 0) / 100),
            yes_ask: Number(m.yes_ask_dollars ?? (m.yes_ask ?? 0) / 100),
            last: Number(m.last_price_dollars ?? (m.last_price ?? 0) / 100),
          })),
        };
      }
    }
    cursor = r.data.cursor;
    if (!cursor) break;
  }
  return null;
}

const toAmerican = (p: number) => (p >= 0.5 ? -Math.round((100 * p) / (1 - p)) : Math.round((100 * (1 - p)) / p));

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const userSb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: u } = await userSb.auth.getUser();
    if (!u?.user) return json({ ok: false, error: "Sign in required" }, 401);
    const allowed = (Deno.env.get("KALSHI_ALLOWED_EMAILS") ?? "").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
    if (!allowed.includes((u.user.email ?? "").toLowerCase())) return json({ ok: false, error: "This account is not allowed to use Kalshi" }, 403);

    const body = await req.json().catch(() => ({}));
    const action = body.action ?? "status";
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    if (action === "status") {
      const r = await kalshi("GET", "/portfolio/balance");
      if (!r.ok) return json({ ok: false, connected: false, env: ENV, error: `Kalshi ${r.status}: ${JSON.stringify(r.data).slice(0, 300)}` }, 502);
      const cents = r.data.balance ?? null;
      return json({ ok: true, connected: true, env: ENV, balance_usd: cents == null ? null : cents / 100, max_order_usd: MAX_ORDER_USD });
    }

    const { data: g } = await sb.from("games").select("game_id,home_team,away_team,game_date_et").eq("game_id", body.game_id).single();
    if (!g) return json({ ok: false, error: "game not found" }, 404);

    if (action === "market") {
      const m = await findMarkets(g);
      return json({ ok: true, env: ENV, found: !!m, ...(m ?? {}) });
    }

    if (action === "order") {
      // Never trade without an explicit confirm from the user in the UI.
      if (body.confirm !== true) return json({ ok: false, error: "Order not placed: confirm:true is required" }, 400);
      const count = Math.floor(Number(body.count));
      const price = Number(body.limit_price);
      const team = norm(String(body.team ?? ""));
      if (!(count >= 1)) return json({ ok: false, error: "count must be at least 1 contract" }, 400);
      if (!(price >= 0.01 && price <= 0.99)) return json({ ok: false, error: "limit_price must be between 0.01 and 0.99" }, 400);
      const cost = +(count * price).toFixed(2);
      if (cost > MAX_ORDER_USD) return json({ ok: false, error: `Order cost $${cost} is above the $${MAX_ORDER_USD} safety cap` }, 400);
      const m = await findMarkets(g);
      const mk = m?.markets.find((x: any) => x.team === team);
      if (!mk) return json({ ok: false, error: `No open Kalshi market for ${team} in this game` }, 404);

      const client_order_id = body.client_order_id ?? crypto.randomUUID();
      const order = {
        ticker: mk.ticker, side: "yes", action: "buy", count, type: "limit",
        yes_price_dollars: price.toFixed(4), time_in_force: "good_till_canceled", client_order_id,
      };
      const r = await kalshi("POST", "/portfolio/orders", order);
      if (!r.ok) return json({ ok: false, error: `Kalshi rejected the order (${r.status}): ${JSON.stringify(r.data).slice(0, 400)}` }, 502);
      const o = r.data.order ?? r.data;

      const { data: bet, error } = await userSb.from("my_bets").insert({
        user_id: u.user.id, game_id: g.game_id, book: "Kalshi", market: "moneyline", pick: team,
        line: null, odds: toAmerican(price), stake: cost, status: o.status ?? "open",
        external_order_id: o.order_id ?? client_order_id,
      }).select().single();
      return json({ ok: true, env: ENV, ticker: mk.ticker, order: o, cost_usd: cost, logged_bet: bet ?? null, log_error: error?.message ?? null });
    }

    return json({ ok: false, error: "unknown action" }, 400);
  } catch (err) {
    return json({ ok: false, error: String(err instanceof Error ? err.message : err) }, 500);
  }
});
