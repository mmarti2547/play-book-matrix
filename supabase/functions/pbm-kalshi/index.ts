// ===== SUPABASE EDGE FUNCTION: pbm-kalshi =====
// Kalshi bridge for Play Book Matrix. Keys live only in Edge Function secrets
// (KALSHI_API_KEY_ID, KALSHI_PRIVATE_KEY, optional KALSHI_ENV=prod|demo, KALSHI_ALLOWED_EMAILS).
// Actions: status (balance), market (find the NFL game-winner market),
//          order (one bet) and checkout (a whole bet slip) - both ONLY with confirm:true.
//          combo_quote (live parlay price, no money) and combo_accept (buy it, ONLY with confirm:true).
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-pbm-cron",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });

const ENV = (Deno.env.get("KALSHI_ENV") ?? "prod").toLowerCase();
const BASE = ENV === "demo" ? "https://external-api.demo.kalshi.co" : "https://api.elections.kalshi.com";
const PREFIX = "/trade-api/v2";
const MAX_ORDER_USD = Number(Deno.env.get("KALSHI_MAX_ORDER_USD") ?? "500"); // safety cap per order
const MAX_CHECKOUT_USD = Number(Deno.env.get("KALSHI_MAX_CHECKOUT_USD") ?? "500"); // safety cap per checkout (whole slip)

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

// 2026-10-23 Kalshi rate limit (429 "too many requests"): opening the Bet Slip fires ~20 balance checks at once.
// GETs of balance/positions are reused for 10 seconds, and a 429 waits and retries (up to 3 tries) instead of failing.
const kCache = new Map<string, { at: number; v: any }>();
async function kalshi(method: string, path: string, body?: unknown) {
  const cacheable = method === "GET" && /^\/portfolio\/(balance|positions)/.test(path);
  if (cacheable) { const c = kCache.get(path); if (c && Date.now() - c.at < 10_000) return c.v; }
  let r: any = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    r = await kalshiOnce(method, path, body);
    if (r.status !== 429) break;
    await new Promise((res) => setTimeout(res, 600 * (attempt + 1) + Math.floor(Math.random() * 400)));
  }
  if (cacheable && r.ok) kCache.set(path, { at: Date.now(), v: r });
  if (!cacheable && method !== "GET") kCache.clear();   // money moved: next balance read is fresh
  return r;
}
// 2026-10-20 Kalshi's API location check (renewed in the Kalshi app every 7 days). When an order is refused for it:
// mark it, email the owner (at most every 6 hours) and show a plain message. The next order that goes through clears it.
const LOCATION_MSG = "Kalshi needs you to re-verify your location (it expires every 7 days). Open the Kalshi app or kalshi.com, allow location access, then try again.";
const isLocationErr = (data: unknown) => /location_attestation/i.test(JSON.stringify(data ?? ""));
const kErr = (what: string, status: number, data: unknown, n = 300) =>
  isLocationErr(data) ? LOCATION_MSG : `Kalshi rejected the ${what} (${status}): ${JSON.stringify(data).slice(0, n)}`;
async function noteLocation(ok: boolean) {
  try {
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    if (ok) { await sb.from("kalshi_status").update({ ok: true, ok_at: new Date().toISOString() }).eq("key", "location").eq("ok", false); return; }
    const { data: st } = await sb.from("kalshi_status").select("last_alert_at").eq("key", "location").maybeSingle();
    const now = new Date().toISOString();
    const alert = !st?.last_alert_at || Date.now() - new Date(st.last_alert_at).getTime() > 6 * 3600e3;
    await sb.from("kalshi_status").upsert({ key: "location", ok: false, failed_at: now, ...(alert ? { last_alert_at: now } : {}) });
    if (alert) {
      const { data: o } = await sb.from("app_members").select("user_id").eq("role", "owner").limit(1).maybeSingle();
      if (o?.user_id) await emailUser(sb, o.user_id, "Kalshi refused a bet - verify your location", "Verify your location in Kalshi",
        `Kalshi just refused a bet because the <b>location check for API trading has expired</b>. Until it's renewed, every bet from Play Book Matrix fails - yours, Tyler's and the Auto Better's.<br><br>
         On your phone: open the Kalshi app (or kalshi.com), allow location access, and it renews for 7 days. Then place the bet again.<br><br>
         <a href="https://kalshi.com" style="display:inline-block;padding:12px 18px;background:#22c55e;color:#04110a;font-weight:bold;border-radius:8px;text-decoration:none">Open Kalshi</a>`);
    }
  } catch (_) { /* never block betting logic */ }
}
async function kalshiOnce(method: string, path: string, body?: unknown) {
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
  if (!r.ok && /location_attestation/i.test(text)) await noteLocation(false);
  else if (r.ok && method === "POST" && /orders|accept/.test(path)) await noteLocation(true);
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

type Ctx = { sb: any; userSb: any; userId: string };
// 2026-10-12 shared Kalshi account: a member (Tyler) can only spend his own bankroll; the owner's spendable cash holds every member's bankroll back
async function memberRole(sb: any, userId: string): Promise<string | null> {
  const { data } = await sb.from("app_members").select("role").eq("user_id", userId).maybeSingle();
  return data?.role ?? null;
}
// 2026-10-19 members bet a share of THEIR OWN account (not the owner's dollar amounts): A+ 15%, A 10%, B+ 5%, B 3%, C 2% - never below $5,
// never above their own settings. Returns null for the owner (owner keeps his settings).
const MEMBER_PCT: Record<string, number> = { "A+": 0.15, A: 0.10, "B+": 0.05, B: 0.03, C: 0.02 };
async function memberValue(sb: any, userId: string): Promise<number | null> {
  if ((await memberRole(sb, userId)) !== "member") return null;
  const { data } = await sb.from("member_bankroll").select("available,open_stake").eq("user_id", userId).maybeSingle();
  return Math.max(0, Number(data?.available ?? 0) + Number(data?.open_stake ?? 0));
}
const scaleForMember = (g: string, base: number, mv: number | null) =>
  mv == null ? base : Math.min(base, Math.max(5, Math.floor(mv * (MEMBER_PCT[g] ?? 0.02))));
async function spendable(sb: any, userId: string, kalshiCash: number): Promise<number> {
  const role = await memberRole(sb, userId);
  const { data: rows } = await sb.from("member_bankroll").select("user_id,available");
  if (role === "member") {
    const me = (rows ?? []).find((r: any) => r.user_id === userId);
    return Math.max(0, Math.min(kalshiCash, Number(me?.available ?? 0)));
  }
  if (role === "research") return 0;
  const held = (rows ?? []).reduce((s: number, r: any) => s + Math.max(0, Number(r.available ?? 0)), 0);
  return Math.max(0, kalshiCash - held);
}

// Refuse to place the same bet twice (same market + side, or a parlay with the same legs) unless allow_duplicate:true.
async function findDuplicate(ctx: Ctx, q: { ticker?: string; side?: string; legs?: string[]; game_id?: string; market?: string }) {
  const since = new Date(Date.now() - 14 * 864e5).toISOString();
  let rows: any[] = [];
  if (q.legs?.length) {
    const want = [...q.legs].sort().join("|");
    const { data } = await ctx.sb.from("my_bets").select("id,stake,placed_at,legs,result,status")
      .eq("user_id", ctx.userId).eq("market", "parlay").gte("placed_at", since);
    rows = (data ?? []).filter((b: any) => Array.isArray(b.legs) &&
      b.legs.map((l: any) => l.ticker ?? l).sort().join("|") === want);
  } else if (q.ticker) {
    // Same game + same bet type + same team = the same bet, even at a different line (e.g. CHI +4.5 vs CHI +3.5)
    const { data: team } = q.game_id ? await ctx.sb.rpc("pbm_bet_team", { p_ticker: q.ticker, p_side: q.side ?? "yes", p_game_id: q.game_id }) : { data: null };
    const group = q.market === "alt_spread" ? "alt" : q.market === "moneyline" ? "ml" : "spread";
    const byIntent = team ? await ctx.sb.from("my_placed_bets").select("id,stake,placed_at,result,status,pick")
      .eq("user_id", ctx.userId).eq("intent_key", `${q.game_id}|${group}|${team}`) : { data: [] };
    const byTicker = await ctx.sb.from("my_bets").select("id,stake,placed_at,result,status,pick")
      .eq("user_id", ctx.userId).eq("ticker", q.ticker).eq("side", q.side ?? "yes").gte("placed_at", since);
    rows = [...(byIntent.data ?? []), ...(byTicker.data ?? [])];
  }
  const hit = rows.find((b: any) => b.result !== "void" && !["canceled", "not_placed"].includes(String(b.status)));
  if (!hit) return null;
  const at = new Date(hit.placed_at).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "2-digit" });
  return `Already placed${hit.pick ? ` ${hit.pick}` : ""} ${at} ($${Number(hit.stake).toFixed(2)}) - skipped so you don't double up`;
}

// Place ONE buy order (YES or NO side) after validating it belongs to the game. Never called without confirm:true.
async function placeOne(ctx: Ctx, item: any) {
  const { sb, userSb, userId } = ctx;
  const { data: g } = await sb.from("games").select("game_id,home_team,away_team,game_date_et,kickoff_utc").eq("game_id", item.game_id).single();
  if (!g) return { ok: false, error: "game not found" };
  if (new Date(g.kickoff_utc).getTime() <= Date.now()) return { ok: false, error: "game already started" };
  const count = Math.floor(Number(item.count));
  const price = Number(item.limit_price);
  const side = item.side === "no" ? "no" : "yes";
  if (!(count >= 1)) return { ok: false, error: "count must be at least 1 contract" };
  if (!(price >= 0.01 && price <= 0.99)) return { ok: false, error: "limit_price must be between 0.01 and 0.99" };
  const cost = +(count * price).toFixed(2);
  if (cost > MAX_ORDER_USD) return { ok: false, error: `Order cost $${cost} is above the $${MAX_ORDER_USD} per-order cap` };
  {
    const b0 = await kalshi("GET", "/portfolio/balance");
    if (b0.ok && b0.data.balance != null) {
      const mine = await spendable(sb, userId, b0.data.balance / 100);
      if (cost > mine + 1e-9) return { ok: false, error: `Order cost $${cost} is more than your available money $${mine.toFixed(2)}` };
    }
  }

  let ticker = "", market = "moneyline", pickLabel = String(item.label ?? item.team ?? "");
  if (item.ticker) {
    const t = String(item.ticker);
    if (!/^KXNFL(SPREAD|GAME)-/.test(t)) return { ok: false, error: "Only NFL game and spread contracts are allowed" };
    const r0 = await kalshi("GET", `/markets/${encodeURIComponent(t)}`);
    const x = r0.data?.market;
    if (!r0.ok || !x) return { ok: false, error: `Kalshi market ${t} not found` };
    if (!["active", "open"].includes(x.status)) return { ok: false, error: `Market ${t} is not open (${x.status})` };
    const { data: alt } = await sb.from("kalshi_alt_lines").select("game_id").eq("ticker", t).maybeSingle();
    const { data: km } = await sb.from("kalshi_markets").select("game_id").eq("game_id", g.game_id)
      .or(`home_ticker.eq.${t},away_ticker.eq.${t}`).maybeSingle();
    if (alt?.game_id !== g.game_id && !km) return { ok: false, error: "That contract is not for this game" };
    ticker = t;
    market = t.startsWith("KXNFLSPREAD") ? (item.source === "main_pick" ? "spread" : "alt_spread") : "moneyline";
    if (!pickLabel) pickLabel = `${side.toUpperCase()}: ${String(x.yes_sub_title ?? x.title ?? t)}`;
  } else {
    const team = norm(String(item.team ?? ""));
    const m = await findMarkets(g);
    const mk = m?.markets.find((x: any) => x.team === team);
    if (!mk) return { ok: false, error: `No open Kalshi market for ${team} in this game` };
    ticker = mk.ticker;
    if (!pickLabel) pickLabel = team;
  }

  if (item.allow_duplicate !== true) {
    const dup = await findDuplicate(ctx, { ticker, side, game_id: g.game_id, market });
    if (dup) return { ok: false, duplicate: true, error: dup };
  }
  const client_order_id = item.client_order_id ?? crypto.randomUUID();
  // Kalshi V2 orders are quoted from the YES side: "bid" = buy YES at price; buying NO at p = "ask" (sell YES) at 1 - p.
  const yesPrice = side === "yes" ? price : 1 - price;
  const order: any = { ticker, side: side === "yes" ? "bid" : "ask", count: count.toFixed(2),
    price: (Math.round(yesPrice * 100) / 100).toFixed(2), time_in_force: "good_till_canceled",
    self_trade_prevention_type: "taker_at_cross", client_order_id };
  if (item.post_only === true) order.post_only = true;   // limit mode: rest on the book under the ask, never take
  const r = await kalshi("POST", "/portfolio/events/orders", order);
  if (!r.ok) return { ok: false, location: isLocationErr(r.data), error: kErr("order", r.status, r.data) };
  const d = r.data.order ?? r.data;
  const filled = Number(d.fill_count ?? 0);
  const o = { order_id: d.order_id, status: filled >= count ? "filled" : filled > 0 ? "partially_filled" : "resting" };
  const { data: bet, error } = await userSb.from("my_bets").insert({
    user_id: userId, game_id: g.game_id, book: "Kalshi", market, pick: pickLabel,
    line: item.line ?? null, odds: toAmerican(price), stake: cost, status: o.status ?? "open",
    external_order_id: o.order_id ?? client_order_id, ticker, side, contracts: count, grade: item.grade ?? null, origin: item.origin ?? "manual",
    order_mode: item.order_mode ?? null, ask_at_order: item.ask_at_order ?? null,
  }).select().single();
  return { ok: true, ticker, side, count, limit_price: price, cost_usd: cost, status: o.status ?? null,
           order_id: o.order_id ?? null, logged_bet_id: bet?.id ?? null, log_error: error?.message ?? null };
}


// ---------- 2026-10-06: raw order helpers (limit-order fallback, cash-out). Kalshi V2 quotes everything from the YES side. ----------
// buy YES = bid at p · buy NO = ask at 1-p · sell YES = ask at p · sell NO = bid at 1-p
async function kalshiOrder(o: { ticker: string; side: "yes" | "no"; count: number; price: number; sell?: boolean; tif?: string; reduce_only?: boolean }): Promise<any> {
  const buyYesSide = (o.side === "yes") !== !!o.sell;
  const yesPrice = o.side === "yes" ? o.price : 1 - o.price;
  const body: any = { ticker: o.ticker, side: buyYesSide ? "bid" : "ask", count: Math.floor(o.count).toFixed(2),
    price: (Math.round(yesPrice * 100) / 100).toFixed(2), time_in_force: o.tif ?? "immediate_or_cancel",
    self_trade_prevention_type: "taker_at_cross", client_order_id: crypto.randomUUID() };
  if (o.reduce_only) body.reduce_only = true;
  const r = await kalshi("POST", "/portfolio/events/orders", body);
  if (!r.ok) return { ok: false, location: isLocationErr(r.data), error: kErr("order", r.status, r.data, 250) };
  const d = r.data.order ?? r.data;
  let fill = Number(d.fill_count_fp ?? d.fill_count ?? 0), remaining = Number(d.remaining_count_fp ?? d.remaining_count ?? 0);
  if (!(fill > 0) && d.order_id) {   // confirm from the order itself before treating it as unfilled
    const g = await kalshi("GET", `/portfolio/orders/${d.order_id}`);
    const x = g.data?.order;
    if (x) { fill = Number(x.fill_count_fp ?? x.fill_count ?? 0); remaining = Number(x.remaining_count_fp ?? x.remaining_count ?? 0); }
  }
  return { ok: true, order_id: d.order_id as string, fill, remaining, avg: d.average_fill_price != null ? Number(d.average_fill_price) : null };
}
async function kalshiCancel(orderId: string, ticker: string) {
  const r = await kalshi("DELETE", `/portfolio/events/orders/${encodeURIComponent(orderId)}?market_ticker=${encodeURIComponent(ticker)}`);
  return { ok: r.ok, reduced_by: Number(r.data?.reduced_by ?? 0), error: r.ok ? null : JSON.stringify(r.data).slice(0, 200) };
}
async function orderFilled(orderId: string) {
  const g = await kalshi("GET", `/portfolio/orders/${orderId}`);
  const x = g.data?.order;
  return x ? Number(x.fill_count_fp ?? x.fill_count ?? 0) : null;
}
// live price of one side of a market: what it costs to buy now (ask) and what it sells for now (bid)
async function sidePrices(ticker: string, side: "yes" | "no") {
  const m = await kalshi("GET", `/markets/${encodeURIComponent(ticker)}`);
  const x = m.data?.market;
  if (!m.ok || !x) return null;
  const yb = Number(x.yes_bid_dollars ?? (x.yes_bid ?? 0) / 100), ya = Number(x.yes_ask_dollars ?? (x.yes_ask ?? 0) / 100);
  return side === "yes" ? { ask: ya, bid: yb, status: x.status } : { ask: +(1 - yb).toFixed(2), bid: +(1 - ya).toFixed(2), status: x.status };
}

// ---------- Parlays (Kalshi "combos"): priced by RFQ, bought only after the user confirms the quoted price ----------
// Verified semantics: accepted_side names the MAKER's side being lifted. To BUY YES on the combo we accept "no",
// which books buy/yes at (1 - no_bid). After accepting we read our fills to confirm we hold YES.
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const dollars = (v: unknown) => (v == null || v === "" ? null : Number(v));

async function findCollection(eventTickers: string[]) {
  let cursor = "";
  for (let page = 0; page < 5; page++) {
    const r = await kalshi("GET", `/multivariate_event_collections?status=open&limit=200${cursor ? "&cursor=" + cursor : ""}`);
    if (!r.ok) throw new Error(`Kalshi collections ${r.status}: ${JSON.stringify(r.data).slice(0, 200)}`);
    const list = r.data.multivariate_contracts ?? r.data.multivariate_event_collections ?? r.data.collections ?? [];
    for (const c of list) {
      const evs: string[] = c.associated_event_tickers ?? (c.associated_events ?? []).map((e: any) => e.ticker ?? e.event_ticker);
      if (eventTickers.every((e) => evs.includes(e))) return c.collection_ticker;
    }
    cursor = r.data.cursor;
    if (!cursor) break;
  }
  return null;
}

async function comboLegs(sb: any, tickers: string[]) {
  if (tickers.length < 2 || tickers.length > 6) throw new Error("A parlay needs 2 to 6 legs");
  const { data: legs } = await sb.from("alt_lines_board").select("ticker,event_ticker,game_id,bet_label,our_prob,kickoff_utc").in("ticker", tickers);
  if (!legs || legs.length !== tickers.length) throw new Error("Every leg must be an open alt line on the board (one may have closed or started)");
  if (new Set(legs.map((l: any) => l.game_id)).size !== legs.length) throw new Error("Pick at most one leg per game");
  if (legs.some((l: any) => new Date(l.kickoff_utc).getTime() <= Date.now())) throw new Error("A leg's game has already started");
  return legs;
}

// 2026-10-10 Jamie's Pick: player-stat legs from the live board (jamie_legs). Games may already be in progress;
// two players from the same game are allowed, the same player twice is not. The board must be fresh (under 10 minutes).
async function jamieLegs(sb: any, tickers: string[], want: Record<string, string>) {
  if (tickers.length < 2 || tickers.length > 6) throw new Error("A parlay needs 2 to 6 legs");
  const { data: rows } = await sb.from("jamie_legs").select("ticker,game_id,player_key,label,side,our_prob,updated_at,game_state").in("ticker", tickers);
  if (!rows || rows.length !== tickers.length) throw new Error("A leg is no longer on the Jamie's Pick board - refresh and try again");
  if (new Set(rows.map((r: any) => r.player_key)).size !== rows.length) throw new Error("Pick at most one leg per player");
  if (rows.some((r: any) => Date.now() - new Date(r.updated_at).getTime() > 10 * 60e3)) throw new Error("The Jamie's Pick board is more than 10 minutes old - wait for the next update");
  if (rows.some((r: any) => r.game_state !== "in")) throw new Error("Jamie's Pick parlays are for games in progress only");
  // the side you're buying must still be the board's side for every leg (it can flip as the game goes)
  if (rows.some((r: any) => (want[r.ticker] ?? "yes") !== r.side)) throw new Error("The board changed for one of these legs - refresh and try again");
  return rows.map((r: any) => ({ ticker: r.ticker, event_ticker: String(r.ticker).split("-").slice(0, 2).join("-"), game_id: r.game_id,
    bet_label: r.label, fixed_label: r.label, our_prob: r.side === "no" ? 1 - Number(r.our_prob) : Number(r.our_prob), kickoff_utc: null, jamie_side: r.side }));
}

async function comboQuote(ctx: Ctx, body: any) {
  const tickers: string[] = [...new Set((body.legs ?? []).map((x: any) => String(x.ticker ?? x)))] as string[];
  const wantSide: Record<string, string> = {};
  for (const x of body.legs ?? []) if (x && typeof x === "object") wantSide[String(x.ticker)] = x.side === "no" ? "no" : "yes";
  const legs0 = body.source === "jamie" ? await jamieLegs(ctx.sb, tickers, wantSide) : await comboLegs(ctx.sb, tickers);
  // 2026-10-06: a leg may be the NO side (teasers: "underdog +7.5" = NO on "favorite wins by over 7.5"); default YES
  const sideOf: Record<string, string> = {};
  for (const x of body.legs ?? []) if (x && typeof x === "object" && x.side === "no") sideOf[String(x.ticker)] = "no";
  for (const l of legs0) if (l.jamie_side === "no") sideOf[l.ticker] = "no";   // Jamie legs carry their own side
  const legs = legs0.map((l: any) => sideOf[l.ticker] === "no"
    ? { ...l, side: "no", our_prob: +(1 - Number(l.our_prob)).toFixed(4), bet_label: l.fixed_label ?? `NOT ${l.bet_label}` } : { ...l, side: "yes" });
  const count = Math.floor(Number(body.count ?? 1));
  if (!(count >= 1)) throw new Error("count must be at least 1 contract");
  const collection = await findCollection(legs.map((l: any) => l.event_ticker));
  if (!collection) return { ok: false, error: "Kalshi doesn't offer these games as a combo yet (they're usually added closer to kickoff)" };
  const mk = await kalshi("POST", `/multivariate_event_collections/${collection}`, {
    selected_markets: legs.map((l: any) => ({ market_ticker: l.ticker, event_ticker: l.event_ticker, side: l.side })),
  });
  if (!mk.ok) return { ok: false, error: `Kalshi couldn't build this combo (${mk.status}): ${JSON.stringify(mk.data).slice(0, 250)}` };
  const market_ticker = mk.data.market_ticker;
  let rfq = await kalshi("POST", "/communications/rfqs", { market_ticker, contracts: count, rest_remainder: false });
  // 2026-10-25 Kalshi allows ONE open quote request per combo. An earlier "Bet this parlay" (or the other login on this
  // shared account) can leave one open -> 409 already_exists. Close our open request(s) for this combo and ask again once.
  if (!rfq.ok && rfq.status === 409) {
    const open = await kalshi("GET", `/communications/rfqs?status=open&limit=100`);
    for (const r of open.data?.rfqs ?? []) if (r.market_ticker === market_ticker && r.id) await kalshi("DELETE", `/communications/rfqs/${r.id}`);
    rfq = await kalshi("POST", "/communications/rfqs", { market_ticker, contracts: count, rest_remainder: false });
  }
  if (!rfq.ok) return { ok: false, error: rfq.status === 409 ? "Kalshi is still holding an earlier price request for this exact parlay - wait 30 seconds and press again"
    : `Kalshi quote request failed (${rfq.status}): ${JSON.stringify(rfq.data).slice(0, 250)}` };
  const rfq_id = rfq.data.id;
  let best: any = null, seen = 0, lastQ: any = null;
  for (let i = 0; i < 12 && !best; i++) {
    await sleep(2000);
    const q = await kalshi("GET", `/communications/quotes?rfq_id=${rfq_id}&rfq_user_filter=self&limit=50`);
    lastQ = { status: q.status, keys: Object.keys(q.data ?? {}), n: (q.data?.quotes ?? []).length };
    seen = Math.max(seen, (q.data?.quotes ?? []).length);
    for (const x of q.data?.quotes ?? []) {
      if (x.status && x.status !== "open") continue;
      const nb = dollars(x.no_bid_dollars);
      if (nb == null || nb <= 0 || nb >= 1) continue;
      const price = +(1 - nb).toFixed(4); // what we pay per YES contract
      if (!best || price < best.price) best = { quote_id: x.id, price, yes_bid: dollars(x.yes_bid_dollars), no_bid: nb };
    }
  }
  const fair = +legs.reduce((p: number, l: any) => p * Number(l.our_prob), 1).toFixed(4);
  if (!best) {
    const rq = await kalshi("GET", `/communications/rfqs/${rfq_id}`);
    console.log("no_quote", JSON.stringify({ market_ticker, count, seen, lastQ, rfq: rq.data?.rfq ?? rq.data }).slice(0, 1500));
    await kalshi("DELETE", `/communications/rfqs/${rfq_id}`);
    return { ok: false, error: "No one quoted this combo yet - try again closer to kickoff", market_ticker, our_prob: fair };
  }
  const fee = Math.ceil(0.07 * count * best.price * (1 - best.price) * 100) / 100;
  return { ok: true, env: ENV, rfq_id, quote_id: best.quote_id, market_ticker, count, price: best.price,
    cost_usd: +(count * best.price).toFixed(2), fee_usd: fee, total_usd: +(count * best.price + fee).toFixed(2),
    payout_usd: count, our_prob: fair, value: best.price < fair ? "good" : "no_value",
    legs: legs.map((l: any) => ({ ticker: l.ticker, label: l.bet_label, our_prob: l.our_prob, side: l.side })),
    expires_note: "Quotes move fast - accept within a few seconds or request a new one" };
}

async function comboAccept(ctx: Ctx, body: any) {
  const { rfq_id, quote_id } = body;
  const maxPrice = Number(body.max_price);
  if (!rfq_id || !quote_id || !(maxPrice > 0 && maxPrice < 1)) throw new Error("rfq_id, quote_id and max_price are required");
  const q = await kalshi("GET", `/communications/quotes/${quote_id}`);
  const x = q.data?.quote;
  if (!q.ok || !x) return { ok: false, error: "Quote not found - request a new one" };
  if (x.rfq_id !== rfq_id || x.status !== "open") return { ok: false, error: `Quote is no longer open (${x.status}) - request a new one` };
  const price = +(1 - Number(x.no_bid_dollars)).toFixed(4);
  if (price > maxPrice + 1e-9) return { ok: false, error: `Price moved to $${price} (you approved $${maxPrice}) - nothing placed` };
  const count = Math.floor(Number(x.contracts_fp ?? x.contracts ?? body.count));
  const cost = +(count * price).toFixed(2);
  if (cost > MAX_ORDER_USD) return { ok: false, error: `Parlay cost $${cost} is above the $${MAX_ORDER_USD} per-bet cap` };
  const bal = await kalshi("GET", "/portfolio/balance");
  const cash = bal.ok && bal.data.balance != null ? await spendable(ctx.sb, ctx.userId, bal.data.balance / 100) : null;
  if (cash != null && cost > cash) return { ok: false, error: `Parlay cost $${cost} is more than your available money $${cash.toFixed(2)}` };

  const acc = await kalshi("PUT", `/communications/rfqs/${rfq_id}/quotes/${quote_id}/accept`, { accepted_side: "no" });
  if (!acc.ok) return { ok: false, location: isLocationErr(acc.data), error: kErr("accept", acc.status, acc.data, 250) };
  let fills: any[] = [];
  for (let i = 0; i < 6 && !fills.length; i++) {
    await sleep(1500);
    const f = await kalshi("GET", `/portfolio/fills?ticker=${encodeURIComponent(x.market_ticker)}&limit=20`);
    fills = f.data?.fills ?? [];
  }
  const wrongSide = fills.some((f: any) => !(f.side === "yes" && f.action === "buy"));
  const filled = fills.reduce((s: number, f: any) => s + Number(f.count_fp ?? f.count ?? 0), 0);
  const legs = (body.legs ?? []).map((l: any) => l.label ?? l.ticker ?? l).join(" + ");
  const { data: bet, error } = await ctx.userSb.from("my_bets").insert({
    user_id: ctx.userId, game_id: body.game_id ?? null, book: "Kalshi", market: "parlay", pick: `${body.pick_prefix ?? "PARLAY"}: ${legs || x.market_ticker}`,
    odds: toAmerican(price), stake: cost, status: filled ? "filled" : "pending", external_order_id: quote_id,
    ticker: x.market_ticker, side: "yes", contracts: count, origin: body.origin ?? "manual",
    legs: (body.legs ?? []).map((l: any) => ({ ticker: l.ticker ?? l, label: l.label ?? null, game_id: l.game_id ?? null, side: l.side === "no" ? "no" : "yes" })),
  }).select().single();
  return { ok: !wrongSide, env: ENV, market_ticker: x.market_ticker, price, count, cost_usd: cost, filled_contracts: filled,
    status: filled ? "filled" : "accepted - waiting for Kalshi to confirm (check My Bets / Kalshi portfolio)",
    warning: wrongSide ? "WARNING: Kalshi booked a side other than BUY YES - check your Kalshi portfolio now" : null,
    fills: fills.map((f: any) => ({ side: f.side, action: f.action, count: f.count_fp ?? f.count, yes_price: f.yes_price_dollars ?? f.yes_price })),
    logged_bet_id: bet?.id ?? null, log_error: error?.message ?? null };
}

// ---------- Kalshi account value snapshots (hourly) for the Scorecard graph ----------
// 2026-10-13 read Kalshi's deposit list and let the database credit any deposit a member said he was making
async function syncDeposits(sb: any) {
  const r = await kalshi("GET", "/portfolio/deposits?limit=100");
  if (!r.ok) return { deposits_error: `${r.status} ${JSON.stringify(r.data).slice(0, 200)}` };
  const rows = (r.data?.deposits ?? []).map((d: any) => ({ id: String(d.id), amount: Number(d.amount_cents ?? 0) / 100, fee: Number(d.fee_cents ?? 0) / 100,
    status: d.status ?? null, type: d.type ?? null, created_at: d.created_ts ? new Date(Number(d.created_ts) * 1000).toISOString() : null,
    finalized_at: d.finalized_ts ? new Date(Number(d.finalized_ts) * 1000).toISOString() : null }));
  for (const x of rows) {   // never overwrite who a deposit was credited to
    const { data: ex } = await sb.from("kalshi_deposits").select("id").eq("id", x.id).maybeSingle();
    if (ex) await sb.from("kalshi_deposits").update({ status: x.status, finalized_at: x.finalized_at, fee: x.fee }).eq("id", x.id);
    else await sb.from("kalshi_deposits").insert(x);
  }
  const { data: m } = await sb.rpc("pbm_match_deposits");
  return { deposits_seen: rows.length, ...(m ?? {}) };
}
async function snapBalance(sb: any, bal?: any) {
  const { data: last } = await sb.from("kalshi_balance_log").select("at").order("at", { ascending: false }).limit(1).maybeSingle();
  if (last && Date.now() - new Date(last.at).getTime() < 55 * 60_000) return;
  const d = bal ?? (await kalshi("GET", "/portfolio/balance")).data;
  if (d?.balance == null) return;
  const cash = d.balance / 100, pv = (d.portfolio_value ?? 0) / 100;
  await sb.from("kalshi_balance_log").insert({ balance_usd: cash, portfolio_value_usd: pv, total_usd: +(cash + pv).toFixed(2) });
}

// ---------- Settle bets: read Kalshi order status + settlements and grade my_bets ----------
const cents = (v: any, c: any) => (v != null && v !== "" ? Number(v) : c != null ? Number(c) / 100 : null);
async function syncResults(sb: any) {
  const { data: bets } = await sb.from("my_bets").select("id,market,stake,status,result,external_order_id,ticker,side,contracts,legs,order_mode,game_id")
    .eq("book", "Kalshi").is("result", null).not("external_order_id", "is", null).limit(200);
  const out = { checked: 0, settled: 0, updated: 0 };
  for (const b of bets ?? []) {
    out.checked++;
    const patch: any = {};
    let ticker = b.ticker;
    if (b.market === "parlay") {
      if (!ticker) { const q = await kalshi("GET", `/communications/quotes/${b.external_order_id}`); ticker = q.data?.quote?.market_ticker ?? null; }
    } else {
      const o = await kalshi("GET", `/portfolio/orders/${b.external_order_id}`);
      const ord = o.data?.order;
      if (ord) {
        ticker = ticker ?? ord.ticker;
        const filled = Number(ord.fill_count_fp ?? ord.fill_count ?? 0), remaining = Number(ord.remaining_count_fp ?? ord.remaining_count ?? 0);
        const st = ord.status === "canceled" && filled === 0 ? "canceled" : remaining > 0 && filled > 0 ? "partially_filled"
          : remaining > 0 ? "resting" : "filled";
        // 2026-10-06: safety net - a limit order must never keep resting into a live game (it would only fill when the bet is going badly)
        if (b.order_mode === "limit" && remaining > 0 && b.game_id) {
          const { data: gk } = await sb.from("games").select("kickoff_utc").eq("game_id", b.game_id).maybeSingle();
          if (gk && new Date(gk.kickoff_utc).getTime() - Date.now() < 5 * 60e3) {
            const c = await kalshiCancel(b.external_order_id, ticker ?? b.ticker);
            const f2 = c.ok ? await orderFilled(b.external_order_id) : null;
            if (c.ok && f2 != null) {
              const px = Number(b.stake) / Number(b.contracts || 1), filled = f2;
              Object.assign(patch, filled > 0 ? { status: "filled", contracts: filled, stake: +(filled * px).toFixed(2) } : { status: "canceled", result: "void", contracts: 0, stake: 0 });
              if (Object.keys(patch).length) { await sb.from("my_bets").update(patch).eq("id", b.id); out.updated++; }
              continue;
            }
          }
        }
        if (st !== b.status) patch.status = st;
        if (st === "canceled") patch.result = "void";
        if (filled && !b.contracts) patch.contracts = filled;
      }
    }
    if (ticker && !b.ticker) patch.ticker = ticker;
    // Parlays: grade each leg from its own market as soon as that game is decided - one losing leg = parlay lost.
    if (b.market === "parlay" && Array.isArray(b.legs) && b.legs.length) {
      const legs = [];
      for (const l of b.legs) {
        const m = await kalshi("GET", `/markets/${encodeURIComponent(l.ticker)}`);
        const res = String(m.data?.market?.result ?? "").toLowerCase();
        const want = l.side === "no" ? "no" : "yes";   // teaser legs can be the NO side
        legs.push({ ...l, status: res === want ? "won" : (res === "yes" || res === "no") ? "lost" : "pending" });
      }
      patch.legs = legs;
      if (legs.some((l: any) => l.status === "lost")) {
        patch.result = "loss"; patch.payout = 0; patch.status = "lost_leg"; patch.settled_at = new Date().toISOString(); out.settled++;
      } else if (legs.every((l: any) => l.status === "won")) {
        // 2026-10-18: every leg won = the parlay won ($1 per contract), same as singles - don't wait for Kalshi's slower combo settlement
        patch.result = "win"; patch.payout = Number(b.contracts ?? 0); patch.status = "decided"; patch.settled_at = new Date().toISOString(); out.settled++;
      }
    } else if (ticker && b.side && b.contracts && !patch.result) {
      // Single bets: decide as soon as the market resolves (settlement can lag).
      const m = await kalshi("GET", `/markets/${encodeURIComponent(ticker)}`);
      const res = String(m.data?.market?.result ?? "").toLowerCase();
      if (res === "yes" || res === "no") {
        const won = res === b.side;
        patch.result = won ? "win" : "loss";
        patch.payout = won ? Number(b.contracts) : 0;
        patch.status = "decided"; patch.settled_at = new Date().toISOString(); out.settled++;
      }
    }
    if (ticker && !patch.result) {
      const s = await kalshi("GET", `/portfolio/settlements?ticker=${encodeURIComponent(ticker)}&limit=10`);
      const st = (s.data?.settlements ?? []).find((x: any) => x.ticker === ticker);
      if (st) {
        const revenue = cents(st.revenue_dollars, st.revenue) ?? 0;
        patch.payout = +revenue.toFixed(2);
        patch.result = revenue > Number(b.stake) + 0.001 ? "win" : revenue > 0 ? "push" : "loss";
        patch.status = "settled";
        patch.settled_at = st.settled_time ?? new Date().toISOString();
        out.settled++;
      }
    }
    if (Object.keys(patch).length) { await sb.from("my_bets").update(patch).eq("id", b.id); out.updated++; }
  }
  return out;
}

// ---------- AUTO TRADER (runs every 5 min from the schedule; only for users who switched it ON with their authenticator) ----------
async function emailUser(sb: any, userId: string, subject: string, title: string, html: string) {
  try {
    const { data: cfg } = await sb.from("private_config").select("value").eq("key", "cron_token").single();
    await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/pbm-email`, { method: "POST",
      headers: { "Content-Type": "application/json", "x-pbm-cron": cfg.value },
      body: JSON.stringify({ action: "send", kind: "auto_bets", user_id: userId, subject, title, html }) });
  } catch (_) { /* email must never block betting logic */ }
}
// Bet size by grade for each profile the user picks on the Auto Trader page (main picks, props AND parlays)
const PARLAY_PROFILES: Record<number, Record<"A+" | "A" | "B+", number>> = {
  1: { "A+": 100, "A": 50, "B+": 25 },
  2: { "A+": 50, "A": 25, "B+": 10 },
  3: { "A+": 25, "A": 10, "B+": 5 },
};
const PARLAY_SIZES = [100, 50, 25, 10, 5];
const profileFor = (st: any) => PARLAY_PROFILES[Number(st.bet_profile ?? st.parlay_profile)] ?? PARLAY_PROFILES[1];
const sizeFor = (want: number, fit: number) => PARLAY_SIZES.find((v) => v <= want && v <= fit) ?? 0;   // step down to the next size that fits
const tierFor = (tiers: number[], want: number, room: number) => {
  const t = [...tiers].sort((x, y) => y - x).filter((v) => v <= want && v <= room);
  return t.length ? t[0] : 0;
};
// 2026-10-13 low-funds email: 10 min before the Auto Better's window opens (kickoff-95m) and 20 min before it closes (kickoff-35m),
// if the user's money can't cover the picks it is about to bet, email once per checkpoint with a deposit button. Read-only - never bets.
async function fundsCheck(sb: any) {
  const out: any[] = [];
  const now = Date.now();
  const { data: users } = await sb.from("auto_trader_settings").select("*").eq("enabled", true);
  if (!users?.length) return out;
  const { data: games } = await sb.from("games").select("game_id,home_team,away_team,kickoff_utc")
    .gt("kickoff_utc", new Date(now + 15 * 60e3).toISOString()).lt("kickoff_utc", new Date(now + 100 * 60e3).toISOString()).order("kickoff_utc");
  if (!games?.length) return out;
  const ck = (g: any) => { const m = (new Date(g.kickoff_utc).getTime() - now) / 60e3; return m >= 90 && m < 100 ? "opens" : m >= 30 && m < 40 ? "closes" : null; };
  const hit = games.find((g: any) => ck(g));
  if (!hit) return out;
  const kind = ck(hit)!;
  const slateKick = new Date(hit.kickoff_utc).toISOString();
  // 2026-10-20 before the window: if Kalshi's location check is known to be expired, warn the owner once per checkpoint
  {
    const { data: loc } = await sb.from("kalshi_status").select("ok").eq("key", "location").maybeSingle();
    const { data: o } = await sb.from("app_members").select("user_id").eq("role", "owner").limit(1).maybeSingle();
    if (loc && loc.ok === false && o?.user_id) {
      const lkey = `location|${kind}|${slateKick}`;
      const { data: sentL } = await sb.from("funds_alerts").select("id").eq("user_id", o.user_id).eq("alert_key", lkey).maybeSingle();
      if (!sentL) {
        await emailUser(sb, o.user_id, "Auto Better can't bet - Kalshi location check expired", "Verify your location in Kalshi",
          `The Auto Better's betting window ${kind === "opens" ? "opens in about 10 minutes" : "closes in about 20 minutes"}, but Kalshi's location check for API trading has expired, so <b>no bets can go in</b> (yours or Tyler's).<br><br>
           Open the Kalshi app (or kalshi.com) on your phone and allow location access - it renews for 7 days.<br><br>
           <a href="https://kalshi.com" style="display:inline-block;padding:12px 18px;background:#22c55e;color:#04110a;font-weight:bold;border-radius:8px;text-decoration:none">Open Kalshi</a>`);
        await sb.from("funds_alerts").insert({ user_id: o.user_id, alert_key: lkey, need: 0, have: 0, short: 0 });
        out.push({ location_alert: lkey });
      }
    }
  }
  const bal = await kalshi("GET", "/portfolio/balance");
  if (!bal.ok || bal.data.balance == null) return out;
  for (const st of users) {
    const uid = st.user_id;
    const key = `${kind}|${slateKick}`;
    const { data: sent } = await sb.from("funds_alerts").select("id").eq("user_id", uid).eq("alert_key", key).maybeSingle();
    if (sent) continue;
    const prof = profileFor(st);
    const okGrade = (g: string) => g === "A+" || g === "A" || (g === "B+" && !!st.include_bplus) || (g === "B" && !!st.include_b) || (g === "C" && !!st.include_c);
    const mv = await memberValue(sb, uid);
    const stakeOf = (g: string) => scaleForMember(g, g === "B+" ? Number(st.max_bplus ?? 25) : g === "B" ? Number(st.max_b ?? 10) : g === "C" ? Number(st.max_c ?? 5)
      : g === "A+" && st.stake_aplus != null ? Number(st.stake_aplus) : g === "A" && st.stake_a != null ? Number(st.stake_a) : Number(prof[g as "A+" | "A"] ?? 0), mv);
    let need = 0; const picks: string[] = [];
    for (const g of games) {
      const { data: mp } = await sb.from("pick_kalshi_map").select("rating,on_kalshi,price,pick_label").eq("game_id", g.game_id).maybeSingle();
      if (!mp || !okGrade(mp.rating) || !mp.on_kalshi) continue;
      const { count } = await sb.from("my_bets").select("id", { count: "exact", head: true }).eq("user_id", uid).eq("game_id", g.game_id)
        .not("status", "in", "(not_placed,canceled)").neq("market", "parlay");
      if ((count ?? 0) > 0) continue;   // already bet this game
      need += stakeOf(mp.rating); picks.push(`${mp.pick_label ?? g.game_id} (${mp.rating}, $${stakeOf(mp.rating)})`);
    }
    if (need <= 0) continue;
    const have = await spendable(sb, uid, bal.data.balance / 100);
    if (have >= need) continue;
    const short = Math.ceil(need - have);
    const { data: m } = await sb.from("app_members").select("role").eq("user_id", uid).maybeSingle();
    const when = kind === "opens" ? "opens in about 10 minutes" : "closes in about 20 minutes";
    const btn = (href: string, label: string) => `<a href="${href}" style="display:inline-block;margin:6px 8px 6px 0;padding:12px 18px;background:#22c55e;color:#04110a;font-weight:bold;border-radius:8px;text-decoration:none">${label}</a>`;
    await emailUser(sb, uid, `Auto Better needs $${short} more in Kalshi`, `Your Auto Better needs $${short} more`,
      `Your Auto Better's betting window ${when}. It plans to bet <b>$${need.toFixed(0)}</b> but your available money is <b>$${have.toFixed(2)}</b>.<br><br>
       <b>Planned picks:</b><br>${picks.join("<br>")}<br><br>
       Add at least <b>$${short}</b> to Kalshi so these bets can go in. Without it, the Auto Better bets only what fits (or skips).<br><br>
       ${btn("https://kalshi.com", "Deposit in Kalshi")}${m?.role === "member" ? btn("https://playbookmatrix.com/auto-trader", "Tell Play Book Matrix (+ Deposit)") : ""}
       ${m?.role === "member" ? "<br><small>Press + Deposit in the app first, then deposit in Kalshi, so it is credited to your bankroll automatically.</small>" : ""}`);
    await sb.from("funds_alerts").insert({ user_id: uid, alert_key: key, need, have, short });
    out.push({ user: uid, emailed: key, short });
  }
  return out;
}
// ---------- 2026-10-26 cash-out: sell an open single bet back to Kalshi before the game ends ----------
// Live chance our bet still wins = Phi(cover margin / (13.45 x sqrt(minutes left / 60))) from the ESPN scoreboard.
// "Sell signal" = the market pays at least 5 points MORE than that chance while we're losing - selling then is a good trade, not a panic.
const ESPN_FIX: Record<string, string> = { WSH: "WAS", LAR: "LA" };
let espnCache: { at: number; games: any[] } | null = null;
async function espnBoard() {
  if (espnCache && Date.now() - espnCache.at < 30_000) return espnCache.games;
  const games: any[] = [];
  for (const host of ["https://site.web.api.espn.com", "https://site.api.espn.com"]) {
    try {
      const r = await fetch(`${host}/apis/site/v2/sports/football/nfl/scoreboard`, { headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" } });
      if (!r.ok) continue;
      const d = await r.json();
      for (const ev of d.events ?? []) {
        const c = ev.competitions?.[0]; if (!c) continue;
        const side = (h: string) => c.competitors?.find((x: any) => x.homeAway === h);
        const ab = (h: string) => { const a = String(side(h)?.team?.abbreviation ?? ""); return ESPN_FIX[a] ?? a; };
        const st = c.status ?? ev.status ?? {};
        games.push({ home: ab("home"), away: ab("away"), hs: Number(side("home")?.score ?? 0) || 0, as: Number(side("away")?.score ?? 0) || 0,
          state: st.type?.state ?? "pre", period: Number(st.period ?? 0), clock: Number(st.clock ?? 0), detail: st.type?.shortDetail ?? "" });
      }
      break;
    } catch (_) { /* try the other host */ }
  }
  espnCache = { at: Date.now(), games };
  return games;
}
const PhiN = (z: number) => { const t = 1 / (1 + 0.2316419 * Math.abs(z)); const d = 0.3989423 * Math.exp(-z * z / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return z > 0 ? 1 - p : p; };
async function liveChance(sb: any, bet: any) {
  const { data: g } = await sb.from("games").select("home_team,away_team").eq("game_id", bet.game_id).maybeSingle();
  if (!g) return null;
  const m = /\b([A-Z]{2,3})\s*(?:([+-]\s*\d+(?:\.\d+)?)|to win|ML)/i.exec(String(bet.pick ?? ""));
  if (!m) return null;
  const team = m[1].toUpperCase(); const spread = m[2] ? Number(m[2].replace(/\s/g, "")) : 0;
  if (team !== g.home_team && team !== g.away_team) return null;
  const e = (await espnBoard()).find((x) => x.home === g.home_team && x.away === g.away_team);
  if (!e || e.state === "pre") return { live: false };
  const ours = team === g.home_team ? e.hs : e.as, theirs = team === g.home_team ? e.as : e.hs;
  const margin = ours - theirs + spread;
  const left = e.state === "post" ? 0 : e.period > 4 ? 6 : Math.max(0, (4 - e.period) * 15 + e.clock / 60);
  const p = left <= 0 ? (margin > 0 ? 1 : margin < 0 ? 0 : 0.5) : PhiN(margin / (13.45 * Math.sqrt(Math.max(0.5, left) / 60)));
  return { live: e.state === "in", margin, minutes_left: +left.toFixed(1), p: +p.toFixed(3), score: `${g.away_team} ${e.as} - ${g.home_team} ${e.hs}`, detail: e.detail };
}
async function cashoutQuote(sb: any, bet: any) {
  if (!bet || bet.result || bet.market === "parlay" || !bet.ticker || !(Number(bet.contracts) > 0)) return { ok: false, error: "Not a cash-out-able bet" };
  if (["resting", "partially_filled"].includes(String(bet.status))) return { ok: false, error: "This limit order is still waiting to fill" };
  const sd = bet.side === "no" ? "no" : "yes";
  const sp = await sidePrices(bet.ticker, sd);
  if (!sp || !["active", "open"].includes(String(sp.status))) return { ok: false, error: "Kalshi isn't trading this market right now" };
  const c = Math.floor(Number(bet.contracts)), bid = Number(sp.bid);
  const fee = bid > 0 && bid < 1 ? Math.ceil(0.07 * c * bid * (1 - bid) * 100) / 100 : 0;
  const lc = await liveChance(sb, bet);
  const L: any = lc;
  const priceSignal = !!(L && L.live && L.p < 0.5 && bid >= L.p + 0.05 && L.minutes_left >= 2);
  // 2026-10-26 BLOWOUT exit (the TB 43 - CAR 13 rule): our live chance under 10% with 20+ game-minutes still left -> get out
  // while Kalshi still pays something (at 0% it pays ~1c). Needs a bid of 3c+ so the sale is worth the fee.
  const blowout = !!(L && L.live && L.p < 0.10 && L.minutes_left >= 20 && bid >= 0.03);
  return { ok: true, bet_id: bet.id, contracts: c, bid, value_usd: +(c * bid - fee).toFixed(2), fee_usd: fee, stake: Number(bet.stake),
    live: lc, sell_signal: priceSignal || blowout, price_signal: priceSignal, blowout };
}
async function cashoutSell(sb: any, bet: any, minPrice: number) {
  const q: any = await cashoutQuote(sb, bet);
  if (!q.ok) return q;
  if (!(q.bid > 0)) return { ok: false, error: "No buyer on Kalshi right now - nothing sold" };
  if (q.bid + 1e-9 < minPrice) return { ok: false, error: `Price dropped to ${Math.round(q.bid * 100)}¢ (you approved ${Math.round(minPrice * 100)}¢) - nothing sold` };
  const r = await kalshiOrder({ ticker: bet.ticker, side: bet.side === "no" ? "no" : "yes", count: q.contracts, price: q.bid, sell: true, tif: "fill_or_kill", reduce_only: true });
  if (!r.ok) return { ok: false, error: r.error };
  if (!(r.fill >= q.contracts)) return { ok: false, error: "Kalshi couldn't sell all of it at that price - nothing sold" };
  const proceeds = +(r.fill * q.bid - q.fee_usd).toFixed(2);
  await sb.from("my_bets").update({ status: "cashed_out", result: proceeds > Number(bet.stake) ? "win" : "loss", payout: proceeds,
    settled_at: new Date().toISOString() }).eq("id", bet.id);
  return { ok: true, sold: r.fill, price: q.bid, proceeds_usd: proceeds, stake: Number(bet.stake) };
}
async function autoRun(sb: any) {
  const { data: users } = await sb.from("auto_trader_settings").select("*").eq("enabled", true);
  const out: any[] = [];
  for (const st of users ?? []) {
    const uid = st.user_id; const ctx: Ctx = { sb, userSb: sb, userId: uid };
    const since = new Date(Date.now() - 7 * 864e5).toISOString();
    // 2026-10-11: your own A+ / A amounts (when set) also raise the per-game limit so they aren't cut back
    const tiers = (st.tiers ?? [10, 25, 50, 100]).map(Number); const maxGame = Math.max(...tiers, Number(st.stake_aplus ?? 0), Number(st.stake_a ?? 0));
    // --- guardrail: loss stop on auto bets settled in the last 7 days
    const { data: settled } = await sb.from("my_bets").select("stake,payout,result").eq("user_id", uid).eq("origin", "auto")
      .in("result", ["win", "loss", "push"]).gte("settled_at", since);
    const pnl = (settled ?? []).reduce((a: number, b: any) => a + Number(b.payout ?? 0) - Number(b.stake), 0);
    if (pnl <= -Number(st.loss_stop_usd)) {
      await sb.from("auto_trader_settings").update({ enabled: false, disabled_at: new Date().toISOString(), disabled_reason: `Loss stop hit: auto bets ${pnl.toFixed(2)} in 7 days` }).eq("user_id", uid);
      await emailUser(sb, uid, "Auto Trader switched OFF - loss stop reached", "Auto Trader stopped",
        `Your auto bets are down <b>$${Math.abs(pnl).toFixed(2)}</b> over the last 7 days, which reached your loss stop of $${st.loss_stop_usd}. The Auto Trader switched itself off. Turn it back on in the app (authenticator required) when you're ready.`);
      out.push({ user: uid, stopped: true }); continue;
    }
    // --- guardrail: ONE weekly budget for the NFL week (Tue 12:00 AM ET onward), counting every bet placed - yours and the Auto Trader's
    const etNow = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
    const wk = new Date(etNow); wk.setDate(etNow.getDate() - ((etNow.getDay() + 5) % 7)); wk.setHours(0, 0, 0, 0);
    const weekStart = new Date(wk.getTime() + (Date.now() - etNow.getTime())).toISOString();
    // Early Edge bets have their own small stakes and do NOT use the weekly budget
    const { data: spent } = await sb.from("my_bets").select("stake,pick,grade,market").eq("user_id", uid).gte("placed_at", weekStart)
      .or("result.is.null,result.neq.void").not("status", "in", "(not_placed,canceled)");   // open bets (result null) count too
    const isEE = (b: any) => /Early Edge/i.test(String(b.pick ?? "")) || /^EE-/.test(String(b.grade ?? ""));
    // Two budgets: main picks (weekly_cap_usd) and props + parlays (extras_cap_usd)
    const isExtra = (b: any) => b.market === "parlay" || b.market === "alt_spread";
    const isRoll = (b: any) => /Roll It/i.test(String(b.pick ?? ""));   // Roll It legs ride on their own money, outside both budgets
    const sumOf = (f: (b: any) => boolean) => (spent ?? []).filter((b: any) => !isEE(b) && !isRoll(b) && f(b)).reduce((a: number, b: any) => a + Number(b.stake), 0);
    let room = Number(st.weekly_cap_usd) - sumOf((b) => !isExtra(b));
    let xroom = Number(st.extras_cap_usd ?? 0) - sumOf(isExtra);
    const prof = profileFor(st);
    // 2026-10-10: grades the Auto Trader bets. A+ and A always; B+ / B / C only when switched on, each at its own max bet.
    const okGrade = (g: string) => g === "A+" || g === "A" || (g === "B+" && !!st.include_bplus) || (g === "B" && !!st.include_b) || (g === "C" && !!st.include_c);
    const mv = await memberValue(sb, uid);   // members: sized to their own account
    const gradeStake = (g: string) => scaleForMember(g, g === "B+" ? Number(st.max_bplus ?? 25) : g === "B" ? Number(st.max_b ?? 10) : g === "C" ? Number(st.max_c ?? 5)
      : g === "A+" && st.stake_aplus != null ? Number(st.stake_aplus) : g === "A" && st.stake_a != null ? Number(st.stake_a) : prof[g as "A+" | "A"], mv);
    // 2026-10-19 one game, one bet: a main pick and a Roll It leg never land on the same game
    const singleOn = async (gid: string, rollOnly: boolean) => {
      const { data } = await sb.from("my_bets").select("pick").eq("user_id", uid).eq("game_id", gid).neq("market", "parlay")
        .not("status", "in", "(not_placed,canceled)").or("result.is.null,result.neq.void");
      return (data ?? []).some((b: any) => !rollOnly || /Roll It/i.test(String(b.pick ?? "")));
    };
    // A+ / A use the profile's fixed sizes unless you typed your own amount; then it's your amount, or what fits
    const customStake = (g: string) => (g === "A+" && st.stake_aplus != null) || (g === "A" && st.stake_a != null);
    const bal = await kalshi("GET", "/portfolio/balance");
    let cash = bal.ok && bal.data.balance != null ? (await spendable(sb, uid, bal.data.balance / 100)) - 1 : 0;   // keep $1 buffer; your share of the shared account only
    if (cash < Math.min(...tiers)) { out.push({ user: uid, skipped: "not enough Kalshi cash" }); continue; }
    const zAcct = mv ?? (cash + 1);   // 2026-10-26 Z+ trial sizing base: members their own account, owner his available money   // weekly cap is checked per bet (Early Edge sits outside it)
    // --- games whose bet window is open now (kickoff-85m .. kickoff-15m) AND the injury agent has run after inactives
    const now = Date.now();
    const { data: games } = await sb.from("games").select("game_id,home_team,away_team,kickoff_utc")
      .gt("kickoff_utc", new Date(now + 15 * 60e3).toISOString()).lt("kickoff_utc", new Date(now + 85 * 60e3).toISOString());
    const { data: logged } = await sb.from("auto_trader_log").select("bet_key,status").eq("user_id", uid).gte("run_at", since);
    const done = new Set((logged ?? []).filter((l: any) => l.status === "placed" || l.status === "skipped").map((l: any) => l.bet_key));
    const log = (row: any) => sb.from("auto_trader_log").insert({ user_id: uid, ...row });
    // Never bet BOTH teams in one game: teams you already hold (singles and parlay legs, manual or auto) per game
    const held = new Map<string, Set<string>>();
    const heldTeams = async (gid: string) => {
      if (!held.has(gid)) {
        const { data } = await sb.rpc("pbm_game_teams_held", { p_user: uid, p_game_id: gid });
        held.set(gid, new Set(((data ?? []) as any[]).map((x: any) => typeof x === "string" ? x : x?.pbm_game_teams_held).filter(Boolean)));
      }
      return held.get(gid)!;
    };
    const teamOf = async (ticker: string, side: string, gid: string) => {
      const { data } = await sb.rpc("pbm_bet_team", { p_ticker: ticker, p_side: side, p_game_id: gid });
      return (data as string | null) ?? null;
    };
    // returns the team already held on the OTHER side of this game, or null if the bet is fine
    const otherSide = async (ticker: string, side: string, gid: string) => {
      const t = await teamOf(ticker, side, gid);
      if (!t) return null;
      const h = await heldTeams(gid);
      return [...h].find((x) => x !== t) ?? null;
    };
    const imp = Math.max(1, Number(st.limit_improve_cents ?? 2)) / 100;
    const placeSingle = async (g: any, kind: string, item: any, stake: number, key: string) => {
      // 2026-10-06 (1) limit orders: post under the ask and wait for a seller; the fallback sweep buys at the ask near kickoff
      if (st.limit_orders && ["main", "early_edge", "roll", "prop"].includes(kind) && Number(item.limit_price) - imp >= 0.02) {
        item = { ...item, ask_at_order: Number(item.limit_price), limit_price: +(Number(item.limit_price) - imp).toFixed(2), post_only: true, order_mode: "limit" };
      }
      const count = Math.floor(stake / Number(item.ask_at_order ?? item.limit_price));   // limit mode sizes at the ask: fallback never overspends
      if (count < 1) return;
      const opp = await otherSide(item.ticker, item.side ?? "yes", g.game_id);
      if (opp) {
        await log({ game_id: g.game_id, kind, pick: item.label, grade: item.grade, win_prob: item.win_prob, price: item.limit_price, stake,
          status: "skipped", reason: `You already have a bet on ${opp} in this game - won't bet the other side`, bet_key: key });
        return { ok: false, skipped: true };
      }
      const r: any = await placeOne(ctx, { ...item, count, origin: "auto" });
      if (r.ok) { const t = await teamOf(item.ticker, item.side ?? "yes", g.game_id); if (t) (await heldTeams(g.game_id)).add(t); }
      await log({ game_id: g.game_id, kind, pick: item.label, grade: item.grade, win_prob: item.win_prob, price: item.limit_price,
        stake: r.ok ? r.cost_usd : stake, status: r.ok ? "placed" : (r.duplicate ? "skipped" : "failed"), bet_id: r.logged_bet_id ?? null,
        reason: r.ok ? `Auto: ${kind} ${item.grade}` : r.error, bet_key: key });
      if (r.ok) {
        if (kind === "prop") xroom -= r.cost_usd; else if (kind !== "early_edge" && kind !== "roll") room -= r.cost_usd;   // Early Edge / Roll It sit outside both budgets
        cash -= r.cost_usd; noteBet(r.cost_usd, g.game_id);
        await emailUser(sb, uid, `${kind === "early_edge" ? "Early Edge - " : ""}Bet Placed: ${item.label} - $${r.cost_usd}`, `Bet Placed: ${item.label}`,
          `<b>${g.away_team} @ ${g.home_team}</b> · kickoff ${new Date(g.kickoff_utc).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "2-digit" })} ET<br>
           Bet: <b>${item.label}</b> (${kind}, grade ${item.grade}${item.win_prob ? `, ${Math.round(item.win_prob * 100)}% to win` : ""})<br>
           Stake: <b>$${r.cost_usd}</b> · ${count} contracts at ${Math.round(Number(item.limit_price) * 100)}¢ · pays $${count} if it wins<br>
           ${item.order_mode === "limit" ? `Limit order: posted ${Math.round(imp * 100)}¢ under the ${Math.round(item.ask_at_order * 100)}¢ asking price and waiting for a seller. Whatever isn't filled ${Number(st.limit_fallback_min ?? 25)} min before kickoff is bought at the asking price (never above ${Math.round(item.ask_at_order * 100)}¢).<br>` : ""}<br>
           ${kind === "prop" ? `Props &amp; parlays budget left: $${Math.max(0, xroom).toFixed(2)} of $${st.extras_cap_usd}` : kind === "early_edge" ? "Early Edge bets don't use your weekly budgets" : kind === "roll" ? "Roll It bets ride on the chain's own winnings, outside your weekly budgets" : `Main-picks budget left: $${Math.max(0, room).toFixed(2)} of $${st.weekly_cap_usd}`}.`);
      }
      return r;
    };
    // per-game cap counts every auto bet already on that game (early bets included)
    // a parlay's full stake counts toward EVERY game it has a leg in
    const { data: autoBets } = await sb.from("my_bets").select("stake,game_id,legs,result,market").eq("user_id", uid).eq("origin", "auto")
      .gte("placed_at", new Date(Date.now() - 14 * 864e5).toISOString());
    const ab: any[] = autoBets ?? [];
    const gameSpent = async (gid: string) => ab.filter((b: any) => b.result !== "void" &&
      (b.game_id === gid || (Array.isArray(b.legs) && b.legs.some((l: any) => l?.game_id === gid))))
      .reduce((a: number, b: any) => a + Number(b.stake), 0);
    const noteBet = (stake: number, gid: string | null, legs: any[] | null = null) => ab.push({ stake, game_id: gid, legs, result: null });
    // (1) limit-order fallback sweep - runs even if limit orders were switched off later, so no order is left hanging
    {
      const { data: lim } = await sb.from("my_bets").select("id,game_id,ticker,side,contracts,stake,external_order_id,ask_at_order,pick,status")
        .eq("user_id", uid).eq("order_mode", "limit").is("result", null).in("status", ["resting", "partially_filled", "open"]);
      for (const b of lim ?? []) {
        const { data: gk } = await sb.from("games").select("kickoff_utc").eq("game_id", b.game_id).maybeSingle();
        if (!gk || !b.contracts || !b.external_order_id) continue;
        const k = new Date(gk.kickoff_utc).getTime();
        const o = await kalshi("GET", `/portfolio/orders/${b.external_order_id}`);
        const ord = o.data?.order;
        if (!ord) continue;
        const filled = Number(ord.fill_count_fp ?? ord.fill_count ?? 0), remaining = Number(ord.remaining_count_fp ?? ord.remaining_count ?? 0);
        const limitPx = Number(b.stake) / Number(b.contracts);
        if (remaining <= 0) { if (filled > 0) await sb.from("my_bets").update({ status: "filled", contracts: filled, stake: +(filled * limitPx).toFixed(2) }).eq("id", b.id); continue; }
        if (now < k - Number(st.limit_fallback_min ?? 25) * 60e3) continue;     // still waiting for a seller
        const c = await kalshiCancel(b.external_order_id, b.ticker);
        if (!c.ok) { out.push({ user: uid, limit_cancel_failed: b.id, error: c.error }); continue; }
        const f2 = await orderFilled(b.external_order_id);          // fills can land between the read and the cancel
        if (f2 == null) continue;
        const filledC = f2, remainingC = Math.max(0, Number(b.contracts) - f2);
        let add = 0, addCost = 0, newId: string | null = null, askNow: number | null = null;
        if (k - now > 5 * 60e3) {
          const sp = await sidePrices(b.ticker, b.side === "no" ? "no" : "yes");
          askNow = sp?.ask ?? null;
          const cap = Number(b.ask_at_order ?? limitPx + imp);
          if (sp && sp.ask > 0 && sp.ask < 1 && sp.ask <= cap + 0.001) {
            const n = Math.min(remainingC, Math.floor((MAX_ORDER_USD - filledC * limitPx) / sp.ask), Math.floor(cash / sp.ask));
            const r = n >= 1 ? await kalshiOrder({ ticker: b.ticker, side: b.side === "no" ? "no" : "yes", count: n, price: sp.ask, tif: "immediate_or_cancel" }) : null;
            if (r?.ok && r.fill > 0) { add = r.fill; addCost = r.fill * sp.ask; newId = r.order_id; cash -= addCost; }
          }
        }
        const tot = filledC + add;
        await sb.from("my_bets").update(tot > 0
          ? { status: "filled", contracts: tot, stake: +(filledC * limitPx + addCost).toFixed(2), ...(filledC === 0 && newId ? { external_order_id: newId } : {}) }
          : { status: "canceled", result: "void", contracts: 0, stake: 0 }).eq("id", b.id);
        const msg = `${filledC} filled at ${Math.round(limitPx * 100)}¢ (limit)` + (add ? `, ${add} bought at the ${Math.round((askNow ?? 0) * 100)}¢ ask` : "") +
          (remainingC - add > 0 ? `, ${remainingC - add} not bought (ask ${askNow != null ? Math.round(askNow * 100) + "¢" : "unavailable"} was above the original ${Math.round(Number(b.ask_at_order ?? 0) * 100)}¢)` : "");
        await log({ game_id: b.game_id, kind: "limit", pick: b.pick, price: limitPx, stake: +(filledC * limitPx + addCost).toFixed(2), status: tot > 0 ? "placed" : "skipped",
          reason: `Limit order wrap-up: ${msg}`, bet_key: `limitfb|${b.id}` });
        await emailUser(sb, uid, `Limit order wrap-up: ${b.pick}`, "Limit order wrap-up", `<b>${b.pick}</b><br>${msg}.`);
      }
    }
    // (4) closing-line timing: if the app's A/A+ picks have historically gotten WORSE prices early (negative CLV), wait for late prices
    let clvWait = false;
    if (st.clv_timing) {
      const { data: cs } = await sb.from("clv_summary").select("bucket,n,avg_clv_pts").eq("source", "app_picks").in("bucket", ["A+", "A"]);
      const n = (cs ?? []).reduce((a: number, r: any) => a + Number(r.n), 0);
      const avg = n ? (cs ?? []).reduce((a: number, r: any) => a + Number(r.n) * Number(r.avg_clv_pts), 0) / n : 0;
      clvWait = n >= 8 && avg < 0;
    }
    const readyGames: any[] = [];   // games whose bet window is open and injury news is in
    for (const g of games ?? []) {
      const { data: ni } = await sb.from("news_intel").select("scanned_at").eq("game_id", g.game_id).maybeSingle();
      const inactives = new Date(g.kickoff_utc).getTime() - 90 * 60e3;
      if (!ni?.scanned_at || new Date(ni.scanned_at).getTime() < inactives) { out.push({ game: g.game_id, waiting: "injury agent not finished after inactives" }); continue; }
      let gameRoom = maxGame - await gameSpent(g.game_id);
      // main pick: A+ / A only, sized by grade
      const { data: mp } = await sb.from("pick_kalshi_map").select("*").eq("game_id", g.game_id).maybeSingle();
      if (mp && okGrade(mp.rating) && mp.on_kalshi && Number(mp.price) > 0.05 && Number(mp.price) < 0.95) {
        const key = `${g.game_id}|main`;
        // (4) CLV timing: when early prices have been worse than the close, hold the main pick until 30 min before kickoff
        const holdForClose = clvWait && new Date(g.kickoff_utc).getTime() - now > 30 * 60e3;
        if (!done.has(key) && holdForClose) out.push({ game: g.game_id, waiting: "CLV timing: betting closer to kickoff" });
        const rollHere = !done.has(key) && !holdForClose && await singleOn(g.game_id, true);
        if (rollHere && !done.has(`${key}|roll`)) { done.add(`${key}|roll`); await log({ game_id: g.game_id, kind: "main", pick: mp.pick_label, grade: mp.rating, price: Number(mp.price), stake: 0,
          status: "skipped", reason: "Roll It already has a bet on this game - one bet per game", bet_key: `${key}|roll` }); }
        if (!done.has(key) && !holdForClose && !rollHere) {
          const want = gradeStake(mp.rating);
          let stake = ["A+", "A"].includes(mp.rating) && !customStake(mp.rating) ? sizeFor(want, Math.min(room, cash, gameRoom))
            : (() => { const s0 = Math.floor(Math.min(want, room, cash, gameRoom)); return s0 >= 5 ? s0 : 0; })();   // B+/B/C: your max, or what fits
          let why = `No size fits: main-picks budget left $${room.toFixed(2)}, Kalshi cash $${cash.toFixed(2)}, room on this game $${gameRoom.toFixed(2)} (of $${maxGame})`;
          // (2) fractional Kelly: stake = bankroll x fraction x edge/(1-price), never above the grade size or any limit
          if (st.kelly_sizing) {
            const { data: bsk } = await sb.from("bet_sheet").select("ats_pick_prob").eq("game_id", g.game_id).maybeSingle();
            const p = Number(bsk?.ats_pick_prob), c = Number(mp.price);
            if (p > 0 && p < 1) {
              const f = (p - c) / (1 - c);
              const kelly = Math.floor(cash * f * Number(st.kelly_fraction ?? 0.25));
              stake = Math.max(0, Math.min(kelly, want, room, cash, gameRoom));
              if (stake < 5) { why = f <= 0 ? `Kelly sizing: no edge - model ${(p * 100).toFixed(1)}% vs price ${Math.round(c * 100)}¢`
                : kelly < 5 ? `Kelly sizing: stake $${kelly} is under the $5 minimum` : why; stake = 0; }
            } else { stake = 0; why = "Kelly sizing: no model cover probability for this pick yet"; }
          }
          if (stake) { const r = await placeSingle(g, "main", { game_id: g.game_id, ticker: mp.ticker, side: mp.side, limit_price: Number(mp.price),
              label: mp.pick_label, grade: mp.rating, source: "main_pick" }, stake, key); if (r?.ok) gameRoom -= r.cost_usd; }
          // 2026-10-05: never skip a main pick silently - record why once (the pick itself still retries every run)
          else if (!done.has(`${key}|nosize`)) { done.add(`${key}|nosize`); await log({ game_id: g.game_id, kind: "main", pick: mp.pick_label, grade: mp.rating, price: Number(mp.price), stake: want,
            status: "skipped", reason: why, bet_key: `${key}|nosize` }); }
        }
      } else if (mp && okGrade(mp.rating)) {
        const key = `${g.game_id}|main|unbettable`;
        if (!done.has(key)) { done.add(key); await log({ game_id: g.game_id, kind: "main", pick: mp.pick_label, grade: mp.rating, price: mp.price == null ? null : Number(mp.price), stake: 0,
          status: "skipped", reason: !mp.on_kalshi ? "No matching Kalshi spread line for this pick" : `Kalshi price ${mp.price} outside 5-95 cents`, bet_key: key }); }
      }
      // 2026-10-26 Z+ VALUE DOG trial (own switch, authenticator to turn on): our model's win chance beats Kalshi's price on an
      // underdog (under 50c) by 5+ points. Only on a game with no other bet. B rate: 3% of the account, never under $5.
      if (st.auto_zplus) {
        const zkey = `${g.game_id}|zplus`;
        const { data: zp } = await sb.from("zplus_board").select("*").eq("game_id", g.game_id).eq("open", true).eq("tier", "Z+").order("gap", { ascending: false }).limit(1).maybeSingle();
        if (zp && !done.has(zkey)) {
          if (await singleOn(g.game_id, false)) {
            done.add(zkey); await log({ game_id: g.game_id, kind: "zplus", pick: zp.pick_label, grade: "Z+", price: Number(zp.ask), stake: 0,
              status: "skipped", reason: "You already have a bet on this game - one bet per game", bet_key: zkey });
          } else {
            const sp = await sidePrices(zp.ticker, "yes");
            const ask = Number(sp?.ask ?? 0);
            if (!(ask > 0.05 && ask < 0.5 && Number(zp.model_prob) - ask >= 0.05)) out.push({ game: g.game_id, waiting: `Z+: live price ${Math.round(ask * 100)}c - gap under 5 pts now` });
            else {
              const want = Math.max(5, Math.floor(zAcct * 0.03));
              const stake = Math.floor(Math.min(want, room, cash, gameRoom, MAX_ORDER_USD));
              if (stake >= 5) {
                const r = await placeSingle(g, "zplus", { game_id: g.game_id, ticker: zp.ticker, side: "yes", limit_price: ask, label: zp.pick_label, grade: "Z+",
                  win_prob: Number(zp.model_prob) }, stake, zkey);
                if (r?.ok) gameRoom -= r.cost_usd;
              } else if (!done.has(`${zkey}|nosize`)) {
                done.add(`${zkey}|nosize`); await log({ game_id: g.game_id, kind: "zplus", pick: zp.pick_label, grade: "Z+", price: ask, stake: want,
                  status: "skipped", reason: `No size fits: main-picks budget left $${room.toFixed(2)}, Kalshi cash $${cash.toFixed(2)}, room on this game $${gameRoom.toFixed(2)}`, bet_key: `${zkey}|nosize` });
              }
            }
          }
        }
      }
      readyGames.push(g);
    }
    // parlays FIRST from the props & parlays budget (props only get what's left). Picked by VALUE, A+/A, no shared games:
    // same pbm_pick_parlays() the Bet Slip uses. parlay_legs 0 = app bundle, 2/3/4 = that size, 24 = 2-leg core + 4-leg long shot.
    if (st.include_parlays) {
      // 2026-10-05: count parlays actually held this NFL week (yours + auto), not the last 7 days of the log
      const parlaysThisWeek = (spent ?? []).filter((b: any) => b.market === "parlay" && !/^(TEASER|JAMIE)/i.test(String(b.pick ?? ""))).length;
      const parMax = Number(st.parlay_max_stake ?? 25), parAPlusOnly = (st.parlay_min_grade ?? "A+") === "A+";
      const { data: picked } = await sb.rpc("pbm_pick_parlays", { p_mode: Number(st.parlay_legs ?? 0), p_max: Number(st.max_parlays_week ?? 2), p_user: uid });
      const pb: any[] = picked ?? [];
      // money reserved for main picks not placed yet (a parlay leg must not squeeze out a later A/A+ main pick)
      const reservedMain = async (gid: string) => {
        if (done.has(`${gid}|main`)) return 0;
        const { data: mp } = await sb.from("pick_kalshi_map").select("rating,on_kalshi").eq("game_id", gid).maybeSingle();
        return mp && mp.on_kalshi && okGrade(mp.rating) ? gradeStake(mp.rating) : 0;
      };
      let n = parlaysThisWeek;
      for (const p of pb ?? []) {
        if (n >= Number(st.max_parlays_week)) break;
        const fk = new Date(p.first_kickoff).getTime();
        if (!(fk - now < 85 * 60e3 && fk - now > 15 * 60e3)) continue;
        const key = `parlay|${[...p.tickers].sort().join("|")}`;
        if (done.has(key)) continue;
        if (parAPlusOnly && p.parlay_grade !== "A+") continue;
        // size by the user's parlay profile and the parlay's grade, never above the parlay cap ($25); the stake counts toward every leg's game
        const want = Math.min(parMax, (prof[p.parlay_grade as "A+" | "A" | "B+"] ?? 0) * Number(p.stake_factor ?? 1));   // long shot = half size
        const legs = (p.leg_detail ?? []).map((l: any) => ({ ticker: l.ticker, label: l.bet_label, game_id: l.game_id }));
        let legRoom = Infinity;
        for (const l of legs) legRoom = Math.min(legRoom, maxGame - await gameSpent(l.game_id) - await reservedMain(l.game_id));
        const fit = Math.min(xroom, cash, legRoom);
        const stake = sizeFor(want, fit);
        if (!stake) { await log({ game_id: legs[0]?.game_id, kind: "parlay", pick: legs.map((l: any) => l.label).join(" + "), grade: p.parlay_grade,
            win_prob: Number(p.our_prob), price: Number(p.max_price_to_pay), stake: want, status: "skipped",
            reason: fit < 5 ? "no room: props & parlays budget, cash or $" + maxGame + " per-game limit" : "no size fits", bet_key: key }); continue; }
        const maxPrice = Number(p.max_price_to_pay);
        const count = Math.floor(stake / maxPrice);
        if (count < 1) continue;
        let r: any;
        // no leg may take the other side of a game you already hold
        let clash: string | null = null;
        for (const l of legs) { const o = await otherSide(l.ticker, "yes", l.game_id); if (o) { clash = `${l.label}: you already have a bet on ${o} in that game - won't bet the other side`; break; } }
        try {
          const dup = clash ? null : await findDuplicate(ctx, { legs: legs.map((l: any) => l.ticker) });
          if (clash) r = { ok: false, duplicate: true, error: clash };
          else if (dup) r = { ok: false, duplicate: true, error: dup };
          else {
            const q: any = await comboQuote(ctx, { legs: legs.map((l: any) => l.ticker), count });
            if (!q.ok) r = { ok: false, error: q.error };
            else if (q.price > maxPrice) { await kalshi("DELETE", `/communications/rfqs/${q.rfq_id}`); r = { ok: false, error: `Kalshi price ${q.price} above max ${maxPrice}` }; }
            else r = await comboAccept(ctx, { rfq_id: q.rfq_id, quote_id: q.quote_id, max_price: maxPrice, legs, game_id: legs[0]?.game_id, origin: "auto" });
          }
        } catch (e) { r = { ok: false, error: String(e) }; }
        const label = legs.map((l: any) => l.label).join(" + ");
        await log({ game_id: legs[0]?.game_id, kind: "parlay", pick: label, grade: p.parlay_grade, win_prob: Number(p.our_prob), price: maxPrice,
          stake: r.ok ? r.cost_usd : stake, status: r.ok ? "placed" : (r.duplicate ? "skipped" : "failed"), bet_id: r.logged_bet_id ?? null,
          reason: r.ok ? "Auto: parlay" : r.error, bet_key: key });
        if (r.ok) { n++; xroom -= r.cost_usd; cash -= r.cost_usd; noteBet(r.cost_usd, legs[0]?.game_id ?? null, legs);
          for (const l of legs) { const t = await teamOf(l.ticker, "yes", l.game_id); if (t) (await heldTeams(l.game_id)).add(t); }
          await emailUser(sb, uid, `Auto parlay placed - $${r.cost_usd}`, "Auto parlay placed",
            `<b>${label}</b><br>Grade ${p.parlay_grade}, ${Math.round(Number(p.our_prob) * 100)}% to win all legs<br>Stake <b>$${r.cost_usd}</b> · pays about $${r.count} if every leg wins.<br><br>Props &amp; parlays budget left: $${Math.max(0, xroom).toFixed(2)} of $${st.extras_cap_usd}.`); }
      }
    }
    // 2026-10-10 (J) Jamie's Pick parlays - OFF unless switched on. Only in-game (from the minute you set, default 35 = 3rd quarter),
    // only the board's current 4- or 5-leg parlay at your minimum grade, only if Kalshi's quote is at least 3 cents under our
    // chance of winning, at most N a day, from the props & parlays budget. Every bet is emailed.
    if (st.jamie_auto) {
      const nLegs = Number(st.jamie_legs ?? 4), after = Number(st.jamie_after_min ?? 35);
      const rank: Record<string, number> = { "A+": 3, A: 2, B: 1, PASS: 0 };
      const { data: jp } = await sb.from("jamie_parlays").select("*").eq("kind", "safe").eq("n_legs", nLegs).eq("relaxed", false).maybeSingle();   // never the Big Coin Flip, never a relaxed (weaker) parlay
      const dayStart = new Date(etNow); dayStart.setHours(0, 0, 0, 0);
      const { count: today, error: todayErr } = await sb.from("my_bets").select("id", { count: "exact", head: true }).eq("user_id", uid).eq("origin", "auto")
        .like("pick", "JAMIE%").gte("placed_at", new Date(dayStart.getTime() + (Date.now() - etNow.getTime())).toISOString());
      if (jp && !todayErr && today != null && (rank[jp.grade] ?? 0) >= (rank[st.jamie_min_grade ?? "A"] ?? 2) && (today ?? 0) < Number(st.jamie_max_day ?? 2)
          && Date.now() - new Date(jp.updated_at).getTime() < 6 * 60e3) {
        const legs = (jp.legs ?? []).map((l: any) => ({ ticker: l.ticker, label: l.label, game_id: l.game_id, side: l.side }));
        const key = `jamie|${legs.map((l: any) => `${l.ticker}:${l.side}`).sort().join("|")}`;
        const { data: lr } = await sb.from("jamie_legs").select("ticker,game_state,minutes_left").in("ticker", legs.map((l: any) => l.ticker));
        const lateEnough = (lr ?? []).length === legs.length && (lr ?? []).every((x: any) => x.game_state === "in" && 60 - Number(x.minutes_left) >= after);
        const tryKey = `${key}|try${Math.floor(Date.now() / 600e3)}`;   // at most one attempt per 10 minutes
        if (!done.has(key) && !done.has(tryKey) && lateEnough) {
          done.add(tryKey);
          const maxPrice = +(Number(jp.our_prob) - 0.03).toFixed(4);
          let legRoom = Infinity;   // same per-game limit as every other bet
          for (const l of legs) legRoom = Math.min(legRoom, maxGame - await gameSpent(l.game_id));
          const stake = Math.floor(Math.min(Number(st.jamie_stake ?? 10), xroom, cash, legRoom));
          const count = maxPrice > 0 ? Math.floor(stake / maxPrice) : 0;
          let r: any;
          if (stake < 1 || count < 1) r = { ok: false, skip: true, error: `no room: props & parlays budget $${xroom.toFixed(2)}, cash $${cash.toFixed(2)}, per-game room $${Math.max(0, legRoom).toFixed(2)}` };
          else {
            try {
              const dup = await findDuplicate(ctx, { legs: legs.map((l: any) => l.ticker) });
              if (dup) r = { ok: false, duplicate: true, error: dup };
              else {
                const q: any = await comboQuote(ctx, { legs, count, source: "jamie" });
                // price limit from the FRESHER of the two chances (the parlay row can be a few minutes older than the board)
                const maxP = Math.min(maxPrice, +(Number(q.our_prob ?? jp.our_prob) - 0.03).toFixed(4));
                if (!q.ok) r = { ok: false, skip: true, error: q.error };
                else if (q.price > maxP) { await kalshi("DELETE", `/communications/rfqs/${q.rfq_id}`); r = { ok: false, skip: true, error: `Kalshi price ${q.price} above our max ${maxP}` }; }
                else r = await comboAccept(ctx, { rfq_id: q.rfq_id, quote_id: q.quote_id, max_price: maxP, legs, game_id: legs[0]?.game_id, origin: "auto", pick_prefix: "JAMIE" });
              }
            } catch (e) { r = { ok: false, error: String(e) }; }
          }
          const label = legs.map((l: any) => l.label).join(" + ");
          // a failed quote is retried on later runs (not marked done); a placed or duplicate one is not
          await log({ game_id: legs[0]?.game_id, kind: "parlay", pick: `JAMIE: ${label}`, grade: jp.grade, win_prob: Number(jp.our_prob), price: maxPrice,
            stake: r.ok ? r.cost_usd : stake, status: r.ok ? "placed" : (r.duplicate || r.skip ? "skipped" : "failed"), bet_id: r.logged_bet_id ?? null,
            reason: r.ok ? `Auto: Jamie's Pick ${nLegs}-leg parlay` : r.error, bet_key: r.ok || r.duplicate ? key : tryKey });
          if (r.ok) { done.add(key); xroom -= r.cost_usd; cash -= r.cost_usd; noteBet(r.cost_usd, legs[0]?.game_id ?? null, legs);
            await emailUser(sb, uid, `Jamie's Pick parlay placed - $${r.cost_usd}`, "Jamie's Pick parlay placed",
              `<b>${legs.map((l: any) => l.label).join("<br>")}</b><br><br>Grade ${jp.grade}, ${Math.round(Number(jp.our_prob) * 100)}% to win all ${nLegs} legs (our estimate)<br>Stake <b>$${r.cost_usd}</b> at ${Math.round(r.price * 100)}¢ · pays about $${r.count} if every leg wins.<br><br>Props &amp; parlays budget left: $${Math.max(0, xroom).toFixed(2)} of $${st.extras_cap_usd}.`); }
        }
      }
    }
    // (3) teasers through 3 and 7 (Wong rules): favorites of 7.5-8.5 bought down to 1.5-2.5, underdogs of 1.5-2.5 bought up to 7.5-8.5.
    //     Two legs from different games, built as a Kalshi combo; bought only if our two-leg chance beats the quote by 2+ cents.
    if (st.teasers) {
      const tThisWeek = (spent ?? []).filter((b: any) => b.market === "parlay" && /^TEASER/i.test(String(b.pick ?? ""))).length;
      if (tThisWeek < Number(st.max_teasers_week ?? 1)) {
        const { data: wkg } = await sb.from("games").select("game_id,home_team,away_team,kickoff_utc,spread_line").is("home_score", null)
          .gt("kickoff_utc", new Date(now + 15 * 60e3).toISOString()).lt("kickoff_utc", new Date(now + 7 * 864e5).toISOString());
        const tl: any[] = [];
        for (const g of wkg ?? []) {
          const sl = Number(g.spread_line); if (!isFinite(sl) || sl === 0) continue;
          const fav = sl > 0 ? g.home_team : g.away_team, dog = sl > 0 ? g.away_team : g.home_team, pts = Math.abs(sl);
          let thr: number, side: "yes" | "no", label: string;
          if (pts >= 7.5 && pts <= 8.5) { thr = Math.floor(pts - 6 - 0.5) + 0.5; side = "yes"; label = `${fav} -${thr} (teased from -${pts})`; }
          else if (pts >= 1.5 && pts <= 2.5) { thr = Math.ceil(pts + 6 + 0.5) - 0.5; side = "no"; label = `${dog} +${thr} (teased from +${pts})`; }
          else continue;
          const { data: al } = await sb.from("alt_lines_board").select("ticker,our_prob,yes_bid,yes_ask").eq("game_id", g.game_id).eq("team", fav).eq("threshold", thr).maybeSingle();
          if (!al) continue;
          const p = side === "yes" ? Number(al.our_prob) : 1 - Number(al.our_prob);
          const price = side === "yes" ? Number(al.yes_ask) : +(1 - Number(al.yes_bid)).toFixed(2);
          if (!(p > 0 && p < 1 && price > 0 && price < 1)) continue;
          tl.push({ ticker: al.ticker, side, label, game_id: g.game_id, p, price, edge: p - price, k: new Date(g.kickoff_utc).getTime() });
        }
        tl.sort((a, b) => b.edge - a.edge);
        const pair = tl.filter((l) => l.edge > 0).slice(0, 2);
        const first = pair.length === 2 ? Math.min(pair[0].k, pair[1].k) : 0;
        if (pair.length === 2 && first - now < 85 * 60e3 && first - now > 15 * 60e3) {
          const key = `teaser|${pair.map((l) => l.ticker).sort().join("|")}`;
          const fair = pair[0].p * pair[1].p, maxPrice = +(fair - 0.02).toFixed(4);
          const stakeT = Math.min(Number(st.teaser_stake ?? 25), xroom, cash);
          const label = pair.map((l) => l.label).join(" + ");
          if (!done.has(key) && stakeT >= 5 && maxPrice > 0.05) {
            const count = Math.floor(stakeT / Math.max(maxPrice, pair[0].price * pair[1].price));
            let r: any;
            try {
              const legs = pair.map((l) => ({ ticker: l.ticker, side: l.side, label: l.label, game_id: l.game_id }));
              const clash = await (async () => { for (const l of legs) { const o = await otherSide(l.ticker, l.side, l.game_id); if (o) return `${l.label}: you already hold ${o} in that game`; } return null; })();
              if (clash) r = { ok: false, duplicate: true, error: clash };
              else if (count < 1) r = { ok: false, duplicate: true, error: "stake too small for one contract" };
              else {
                const q: any = await comboQuote(ctx, { legs, count });
                if (!q.ok) r = { ok: false, error: q.error };
                else if (q.price > maxPrice) { await kalshi("DELETE", `/communications/rfqs/${q.rfq_id}`); r = { ok: false, waiting: true, error: `Kalshi price ${q.price} is not below our ${(fair * 100).toFixed(1)}% chance minus 2 cents - will re-check` }; }
                else r = await comboAccept(ctx, { rfq_id: q.rfq_id, quote_id: q.quote_id, max_price: maxPrice, legs, game_id: legs[0].game_id, origin: "auto", pick_prefix: "TEASER" });
              }
            } catch (e) { r = { ok: false, error: String(e) }; }
            await log({ game_id: pair[0].game_id, kind: "teaser", pick: `TEASER: ${label}`, win_prob: +fair.toFixed(4), price: maxPrice,
              stake: r.ok ? r.cost_usd : stakeT, status: r.ok ? "placed" : r.waiting ? "waiting" : (r.duplicate ? "skipped" : "failed"), bet_id: r.logged_bet_id ?? null,
              reason: r.ok ? "Auto: teaser through 3 and 7" : r.error, bet_key: key });
            if (r.ok) { xroom -= r.cost_usd; cash -= r.cost_usd; noteBet(r.cost_usd, pair[0].game_id, pair);
              await emailUser(sb, uid, `Auto teaser placed - $${r.cost_usd}`, "Auto teaser placed",
                `<b>${label}</b><br>Both legs cross the key numbers 3 and 7. Our chance both win: ${(fair * 100).toFixed(1)}%, paid ${Math.round(r.price * 100)}¢ per $1.<br>Stake <b>$${r.cost_usd}</b> · pays $${r.count} if both legs win.`); }
          }
        }
      }
    }
    // (5) middles: you hold a spread at one number and the line has moved - buy the other side at the new number when
    //     the gap between them covers 3 or 7 (a final margin there wins BOTH bets) and the pair costs at most $1 + middle_max_cost.
    if (st.middles) {
      const { data: held } = await sb.from("my_bets").select("id,game_id,ticker,side,contracts,stake,pick,market").eq("user_id", uid).is("result", null)
        .in("market", ["spread", "alt_spread"]).like("ticker", "KXNFLSPREAD%").in("status", ["filled", "decided"]);   // only positions that are fully filled
      for (const b of held ?? []) {
        if (/^MIDDLE/i.test(String(b.pick ?? "")) || !(Number(b.contracts) > 0) || !b.side) continue;
        const key = `middle|${b.id}`;
        if (done.has(key)) continue;
        const { data: me } = await sb.from("kalshi_alt_lines").select("team,threshold").eq("ticker", b.ticker).maybeSingle();
        const { data: g } = await sb.from("games").select("game_id,home_team,away_team,kickoff_utc").eq("game_id", b.game_id).maybeSingle();
        if (!me || !g || new Date(g.kickoff_utc).getTime() - now < 15 * 60e3) continue;
        const q = Number(b.stake) / Number(b.contracts), t = Number(me.threshold);
        const { data: ladder } = await sb.from("kalshi_alt_lines").select("ticker,threshold,yes_bid,yes_ask,fetched_at,status")
          .eq("game_id", b.game_id).eq("team", me.team).in("status", ["active", "open"]);
        let best: any = null;
        for (const L of ladder ?? []) {
          if (Date.now() - new Date(L.fetched_at).getTime() > 30 * 60e3) continue;
          const u = Number(L.threshold);
          let lo: number, hi: number, side: "yes" | "no", price: number;
          if (b.side === "yes" && u > t) { lo = t; hi = u; side = "no"; price = +(1 - Number(L.yes_bid)).toFixed(2); }
          else if (b.side === "no" && u < t) { lo = u; hi = t; side = "yes"; price = Number(L.yes_ask); }
          else continue;
          if (!(price > 0.02 && price < 0.98)) continue;
          if (![3, 7].some((m) => m > lo && m < hi)) continue;          // the both-win window must hold a key number
          const pairCost = q + price;
          if (pairCost > 1 + Number(st.middle_max_cost ?? 0.04)) continue;
          if (!best || pairCost < best.pairCost) best = { ticker: L.ticker, side, price, pairCost, lo, hi };
        }
        if (!best) continue;
        const count = Math.min(Number(b.contracts), Math.floor(Math.min(Number(st.middle_max_usd ?? 50), xroom, cash) / best.price));
        if (count < 1) continue;
        const a = best.lo + 0.5, z = best.hi - 0.5;
        const label = `MIDDLE: ${me.team} wins by ${a === z ? a : `${a}-${z}`} = both bets win (other side of ${b.pick})`;
        const r: any = await placeOne(ctx, { game_id: g.game_id, ticker: best.ticker, side: best.side, count, limit_price: best.price, label,
          grade: "MIDDLE", origin: "auto", allow_duplicate: true });
        await log({ game_id: g.game_id, kind: "middle", pick: label, price: best.price, stake: r.ok ? r.cost_usd : +(count * best.price).toFixed(2),
          status: r.ok ? "placed" : "failed", bet_id: r.logged_bet_id ?? null, reason: r.ok ? `Auto: middle, pair costs ${Math.round(best.pairCost * 100)}¢ per $1` : r.error, bet_key: key });
        if (r.ok) { xroom -= r.cost_usd; cash -= r.cost_usd; noteBet(r.cost_usd, g.game_id);
          await emailUser(sb, uid, `Auto middle placed: ${me.team} by ${a === z ? a : `${a}-${z}`}`, "Auto middle placed",
            `<b>${g.away_team} @ ${g.home_team}</b><br>You hold <b>${b.pick}</b>. The line moved, so the Auto Trader bought the other side: <b>${label}</b>.<br>
             Stake <b>$${r.cost_usd}</b> (${count} contracts at ${Math.round(best.price * 100)}¢). If ${me.team} wins by ${a === z ? a : `${a} to ${z}`}, both bets pay;
             otherwise one wins and one loses, ${best.pairCost > 1 ? `costing about ${Math.round((best.pairCost - 1) * 100)}¢` : `still making about ${Math.round((1 - best.pairCost) * 100)}¢`} per contract pair.`); }
      }
    }
    // props: only what's left of the props & parlays budget after parlays
    if (st.include_props) {
      for (const g of readyGames) {
        const gameRoom = maxGame - await gameSpent(g.game_id);
        const { data: ab } = await sb.from("alt_best_bets").select("*").eq("game_id", g.game_id).maybeSingle();
        if (ab && ["A+", "A", "B+"].includes(ab.grade)) {
          const key = `${g.game_id}|prop`;
          if (!done.has(key)) {
            const want = prof[ab.grade as "A+" | "A" | "B+"];
            const stake = sizeFor(want, Math.min(xroom, cash, gameRoom));
            if (stake) await placeSingle(g, "prop", { game_id: g.game_id, ticker: ab.ticker, side: "yes", limit_price: Number(ab.yes_ask),
              label: ab.bet_label, grade: ab.grade, win_prob: Number(ab.our_prob) }, stake, key);
          }
        }
      }
    }
    // Early Edge: bettable signals days before kickoff (only if the user switched Early Edge on). Small sizes while unproven.
    if (st.early_edge) {
      const { data: sigs } = await sb.from("ee_signals").select("*").eq("active", true).eq("bettable", true).in("kind", ["qb_out", "kalshi_gap"])
        .gt("kickoff_utc", new Date(now + 24 * 3600e3).toISOString());
      // ONE Early Edge bet per game: skip a game once any Early Edge bet was placed (or skipped) on it
      const eeGames = new Set([...done].filter((k) => String(k).includes("|ee|")).map((k) => String(k).split("|ee|")[0]));
      // 2026-10-05: at most ee_max_week (3) Early Edge bets per NFL game week, counted by the GAMES' week (yours + auto).
      //   QB-out signals go first, then the soonest games.
      const eeCap = Number(st.ee_max_week ?? 3);
      const { data: eeHeld } = await sb.from("my_bets").select("game_id,pick,grade").eq("user_id", uid)
        .gte("placed_at", new Date(now - 21 * 864e5).toISOString()).not("status", "in", "(not_placed,canceled)").or("result.is.null,result.neq.void");
      const eeBets = (eeHeld ?? []).filter(isEE);
      const wkIds = [...new Set([...eeBets.map((b: any) => b.game_id), ...(sigs ?? []).map((s: any) => s.game_id)].filter(Boolean))];
      const { data: wkRows } = wkIds.length ? await sb.from("games").select("game_id,season,week").in("game_id", wkIds) : { data: [] };
      const wkOf: Record<string, string> = {};
      for (const r of wkRows ?? []) wkOf[r.game_id] = `${r.season}-${r.week}`;
      const eeCount: Record<string, number> = {};
      for (const b of eeBets) { const w = wkOf[b.game_id]; if (w) eeCount[w] = (eeCount[w] ?? 0) + 1; }
      const eeSorted = [...(sigs ?? [])].sort((a: any, b: any) => (a.kind === "qb_out" ? 0 : 1) - (b.kind === "qb_out" ? 0 : 1)
        || new Date(a.kickoff_utc).getTime() - new Date(b.kickoff_utc).getTime());
      for (const s of eeSorted) {
        const key = `${s.game_id}|ee|${s.kind}`;
        if (eeGames.has(s.game_id) || !s.ticker) continue;
        const eeWk = wkOf[s.game_id];
        if (!eeWk || (eeCount[eeWk] ?? 0) >= eeCap) continue;
        // 2026-10-02: Early Edge must agree with the main model before it bets.
        //  model picks the OTHER team to win -> skip · model agrees on the winner but not the spread -> bet "to win" instead of the spread
        const { data: bs } = await sb.from("bet_sheet").select("ats_pick,predicted_winner,predicted_winner_prob").eq("game_id", s.game_id).maybeSingle();
        if (!bs || bs.predicted_winner !== s.bet_team) { out.push({ user: uid, ee_skipped: s.game_id, why: bs ? `model picks ${bs.predicted_winner} to win` : "no model view yet" }); continue; }
        let eeTicker = String(s.ticker), eeLabel: string = s.bet_label ?? `${s.bet_team} to win`, eeSide = s.bet_side === "no" ? "no" : "yes";
        let eeMax: number | null = s.max_price != null ? Number(s.max_price) : null, switched = false;
        if (eeTicker.startsWith("KXNFLSPREAD") && bs.ats_pick !== s.bet_team) {
          const { data: kmw } = await sb.from("kalshi_markets").select("home_ticker,away_ticker").eq("game_id", s.game_id).maybeSingle();
          const { data: gw } = await sb.from("games").select("home_team").eq("game_id", s.game_id).single();
          const wt = gw?.home_team === s.bet_team ? kmw?.home_ticker : kmw?.away_ticker;
          if (!wt) continue;
          eeTicker = wt; eeLabel = `${s.bet_team} to win`; eeSide = "yes"; switched = true;
          eeMax = Math.round((Number(bs.predicted_winner_prob) - 0.02) * 100) / 100;   // never pay more than our own win chance minus 2 cents
        }
        // current price of the contract we will buy (spread ladder or game market), for its side
        const bside = eeSide;
        let ask: number | null = null;
        if (eeTicker.startsWith("KXNFLSPREAD")) {
          const { data: al } = await sb.from("kalshi_alt_lines").select("yes_bid,yes_ask,fetched_at").eq("ticker", eeTicker).maybeSingle();
          if (al && Date.now() - new Date(al.fetched_at).getTime() < 60 * 60e3) ask = bside === "yes" ? Number(al.yes_ask) : Math.round((1 - Number(al.yes_bid)) * 100) / 100;
        } else {
          const { data: km } = await sb.from("kalshi_markets").select("*").eq("game_id", s.game_id).maybeSingle();
          if (km && Date.now() - new Date(km.fetched_at).getTime() < 30 * 60e3) ask = Number(km.home_ticker === eeTicker ? km.home_yes_ask : km.away_yes_ask);
        }
        if (ask == null || !(ask >= 0.1 && ask <= 0.9)) continue;
        let maxP = eeMax;
        if (s.kind === "kalshi_gap") {        // gap bet: Kalshi must still be 2+ pts under the CURRENT Vegas win chance
          const { data: lc } = await sb.rpc("ee_line_context", { p_game_id: s.game_id });
          const { data: km2 } = await sb.from("kalshi_markets").select("home_ticker").eq("game_id", s.game_id).maybeSingle();
          const hp = lc?.[0]?.home_prob_now; if (hp == null) continue;
          maxP = (km2?.home_ticker === s.ticker ? Number(hp) : 1 - Number(hp)) - 0.02;
        }
        if (maxP == null || ask > maxP) continue;
        const { data: g } = await sb.from("games").select("game_id,home_team,away_team,kickoff_utc").eq("game_id", s.game_id).single();
        if (!g) continue;
        const stake = tierFor(tiers, s.kind === "qb_out" ? 25 : 10, Math.min(cash, maxGame - await gameSpent(s.game_id)));   // outside the weekly budget
        if (!stake) continue;
        eeGames.add(s.game_id);
        const eeR: any = await placeSingle(g, "early_edge", { game_id: s.game_id, ticker: eeTicker, side: bside, limit_price: ask,
          label: `${eeLabel} (Early Edge: ${s.kind === "qb_out" ? `${s.fade_team} QB out` : "Kalshi below Vegas"}${switched ? "; model agrees on winner, not spread" : ""})`,
          grade: s.kind === "qb_out" ? "EE-QB" : "EE-Gap", win_prob: s.vegas_prob != null ? Number(s.vegas_prob) : null, line: s.bet_line ?? null }, stake, key);
        if (eeR?.ok) eeCount[eeWk] = (eeCount[eeWk] ?? 0) + 1;
      }
    }
    // Roll It (2026-10-05): ONE chain a week. Leg 1 = roll_start_stake ($25) on an A+/A main pick; every win's FULL payout rides
    // on the next A+/A main pick that starts after it. Ends after roll_legs wins (4), on the first loss, or when switched off between legs.
    {
      const fmt = (v: number) => `$${Number(v).toFixed(2)}`;
      let { data: chain } = await sb.from("roll_chains").select("*").eq("user_id", uid).eq("status", "active").maybeSingle();
      // (6) cash-out: the LAST leg is in play and its sale price reached roll_cashout_at -> sell it and lock the chain's winnings
      if (chain?.current_bet_id && st.roll_cashout && chain.legs_won + 1 >= chain.legs_target) {
        const { data: cb } = await sb.from("my_bets").select("id,game_id,ticker,side,contracts,stake,result,pick").eq("id", chain.current_bet_id).maybeSingle();
        const { data: cg } = cb ? await sb.from("games").select("kickoff_utc").eq("game_id", cb.game_id).maybeSingle() : { data: null };
        if (cb && !cb.result && Number(cb.contracts) > 0 && cb.ticker && cg && new Date(cg.kickoff_utc).getTime() < now) {
          const sd = cb.side === "no" ? "no" : "yes";
          const sp = await sidePrices(cb.ticker, sd);
          const lockAt = Number(st.roll_cashout_at ?? 0.85);
          if (sp && ["active", "open"].includes(String(sp.status)) && sp.bid >= lockAt && sp.bid < 1 && sp.bid * Number(cb.contracts) > Number(cb.stake)) {
            const r = await kalshiOrder({ ticker: cb.ticker, side: sd, count: Number(cb.contracts), price: sp.bid, sell: true, tif: "fill_or_kill", reduce_only: true });
            if (r.ok && r.fill >= Number(cb.contracts)) {
              const proceeds = +(r.fill * sp.bid).toFixed(2);
              await sb.from("my_bets").update({ status: "cashed_out", result: proceeds > Number(cb.stake) ? "win" : "loss", payout: proceeds,
                settled_at: new Date().toISOString() }).eq("id", cb.id);
              await log({ game_id: cb.game_id, kind: "cashout", pick: cb.pick, price: sp.bid, stake: Number(cb.stake), status: "placed",
                reason: `Roll It cash-out: sold ${r.fill} at ${Math.round(sp.bid * 100)}¢ for $${proceeds}`, bet_key: `cashout|${cb.id}` });
              await emailUser(sb, uid, `Roll It cashed out - $${proceeds} locked`, "Roll It cash-out",
                `The last leg <b>${cb.pick}</b> reached ${Math.round(sp.bid * 100)}¢ during the game, so the Auto Trader sold it for <b>$${proceeds}</b> instead of waiting for the final whistle.`);
            } else if (!r.ok) out.push({ user: uid, cashout_failed: cb.id, error: r.error });
          }
        }
      }
      // 1) is the riding leg decided?
      if (chain?.current_bet_id) {
        const { data: lb } = await sb.from("my_bets").select("id,game_id,pick,stake,result,payout").eq("id", chain.current_bet_id).maybeSingle();
        if (lb?.result) {
          const hist = (chain.history ?? []).map((h: any) => h.bet_id === lb.id ? { ...h, result: lb.result, payout: Number(lb.payout ?? 0) } : h);
          const leg = chain.legs_won + 1, nowIso = new Date().toISOString();
          const patch: any = { history: hist, current_bet_id: null };
          let subj = "", html = "";
          if (lb.result === "win") {
            patch.legs_won = leg; patch.current_amount = Number(lb.payout);
            if (leg >= chain.legs_target) {
              patch.status = "won"; patch.ended_at = nowIso;
              subj = `Roll It: ${leg} for ${leg}! ${fmt(chain.start_stake)} became ${fmt(lb.payout)}`;
              html = `Leg ${leg} <b>${lb.pick}</b> won. The chain is complete: <b>${fmt(chain.start_stake)} → ${fmt(lb.payout)}</b>. The money is in your Kalshi cash. A new chain starts next week.`;
            } else {
              subj = `Roll It: leg ${leg} won - ${fmt(lb.payout)} rides on the next pick`;
              html = `Leg ${leg} of ${chain.legs_target} <b>${lb.pick}</b> won. <b>${fmt(lb.payout)}</b> goes on the next A+/A pick when its bet window opens. Turn Roll It off before then to keep the money.`;
            }
          } else if (lb.result === "loss") {
            patch.status = "lost"; patch.current_amount = 0; patch.ended_at = nowIso;
            subj = `Roll It ended: leg ${leg} lost`;
            html = `Leg ${leg} <b>${lb.pick}</b> lost, so this chain is over. You lost the starting ${fmt(chain.start_stake)}. A new chain starts next week.`;
          } else {   // push pays back, void (order never filled) never left the account: same amount tries the next pick
            patch.current_amount = lb.result === "void" ? Number(chain.current_amount) : Number(lb.payout ?? chain.current_amount);
            subj = `Roll It: leg ${leg} ${lb.result === "push" ? "pushed" : "didn't fill"} - trying the next pick`;
            html = `<b>${lb.pick}</b> ${lb.result === "push" ? "was a push" : "never filled on Kalshi"}. ${fmt(patch.current_amount)} stays in the chain for the next A+/A pick.`;
          }
          await sb.from("roll_chains").update(patch).eq("id", chain.id);
          await emailUser(sb, uid, subj, "Roll It", html);
          chain = patch.status ? null : { ...chain, ...patch };
        }
      }
      // 2) switched off between legs: stop and keep the winnings
      if (chain && !chain.current_bet_id && !st.roll_enabled) {
        await sb.from("roll_chains").update({ status: "stopped", ended_at: new Date().toISOString() }).eq("id", chain.id);
        await emailUser(sb, uid, `Roll It stopped - you keep ${fmt(chain.current_amount)}`, "Roll It stopped",
          `You switched Roll It off after ${chain.legs_won} win(s). ${fmt(chain.start_stake)} became <b>${fmt(chain.current_amount)}</b>, already in your Kalshi cash.`);
        chain = null;
      }
      // 3) place the next leg (or leg 1 of this week's chain)
      let startNew = false;
      if (st.roll_enabled && !chain) {
        const { count } = await sb.from("roll_chains").select("id", { count: "exact", head: true }).eq("user_id", uid).gte("started_at", weekStart);
        startNew = !count;
      }
      if (st.roll_enabled && (startNew || (chain && !chain.current_bet_id))) {
        const tag = chain ? String(chain.id) : `new${weekStart.slice(0, 10)}`, leg = chain ? chain.legs_won + 1 : 1;
        const cands: any[] = [];
        for (const g of readyGames) {
          const { data: mp } = await sb.from("pick_kalshi_map").select("*").eq("game_id", g.game_id).maybeSingle();
          if (!mp || !["A+", "A"].includes(mp.rating) || !mp.on_kalshi || !(Number(mp.price) >= 0.2 && Number(mp.price) <= 0.8)) continue;
          const key = `roll|${tag}|${leg}|${g.game_id}`;
          if (done.has(key)) continue;
          if (await singleOn(g.game_id, false)) continue;   // 2026-10-19: never stack on a game you already have a bet on
          cands.push({ g, mp, key, k: new Date(g.kickoff_utc).getTime() });
        }
        // wait until 35 min before the slot's first kickoff so every game in that slot has its injury check, then take the best pick
        if (cands.length && Math.min(...cands.map((c) => c.k)) - now <= 35 * 60e3) {
          cands.sort((a, b) => (a.mp.rating === "A+" ? 0 : 1) - (b.mp.rating === "A+" ? 0 : 1) || Number(b.mp.units ?? 0) - Number(a.mp.units ?? 0) || a.k - b.k);
          const c = cands[0];
          const amount = chain ? Number(chain.current_amount) : scaleForMember("A", Number(st.roll_start_stake ?? 25), mv);   // members start at 10% of their account
          const target = chain ? chain.legs_target : Math.max(1, Number(st.roll_legs ?? 4));
          const stake = Math.min(amount, cash);
          if (stake >= 1) {
            const r: any = await placeSingle(c.g, "roll", { game_id: c.g.game_id, ticker: c.mp.ticker, side: c.mp.side ?? "yes", limit_price: Number(c.mp.price),
              label: `${c.mp.pick_label} (Roll It leg ${leg} of ${target})`, grade: c.mp.rating, source: "main_pick", allow_duplicate: true }, stake, c.key);
            if (r?.ok) {
              const h = { leg, bet_id: r.logged_bet_id ?? null, game_id: c.g.game_id, pick: c.mp.pick_label, stake: r.cost_usd, at: new Date().toISOString() };
              if (chain) await sb.from("roll_chains").update({ current_bet_id: r.logged_bet_id ?? null, history: [...(chain.history ?? []), h] }).eq("id", chain.id);
              else await sb.from("roll_chains").insert({ user_id: uid, start_stake: r.cost_usd, legs_target: target, current_amount: r.cost_usd,
                current_bet_id: r.logged_bet_id ?? null, history: [h] });
              out.push({ user: uid, roll_leg: leg, pick: c.mp.pick_label, stake: r.cost_usd });
            }
          }
        }
      }
    }
    // 2026-10-26 auto cash-out (OFF unless switched on): sell a losing Auto Better single only when the market pays 5+ points
    // more than our live chance (the sell signal) - never just because the game looks ugly.
    if (st.auto_cashout) {
      const { data: openB } = await sb.from("my_bets").select("*").eq("user_id", uid).eq("origin", "auto").is("result", null)
        .neq("market", "parlay").not("ticker", "is", null).gt("contracts", 0);
      for (const b of openB ?? []) {
        if (/Roll It/i.test(String(b.pick ?? ""))) continue;   // Roll It has its own cash-out rule
        const q: any = await cashoutQuote(sb, b);
        if (!q.ok || !q.sell_signal) continue;
        const r: any = await cashoutSell(sb, b, q.bid);
        await log({ game_id: b.game_id, kind: "cashout", pick: b.pick, price: q.bid, stake: Number(b.stake), status: r.ok ? "placed" : "failed",
          reason: r.ok ? `Auto cash-out${q.blowout ? " (blowout)" : ""}: sold at ${Math.round(q.bid * 100)}¢ for $${r.proceeds_usd} (our live chance ${Math.round(q.live.p * 100)}%, ${q.live.score})` : r.error,
          bet_key: `autocash|${b.id}|${Math.floor(now / 600000)}` });
        if (r.ok) await emailUser(sb, uid, `Auto cash-out: ${b.pick} - $${r.proceeds_usd} back`, "Auto cash-out",
          `<b>${b.pick}</b> (${q.live.score}, ${q.live.detail}) - ${q.blowout ? `blowout: our live chance fell to ${Math.round(q.live.p * 100)}% with ${Math.round(q.live.minutes_left)} game-minutes left, so the Auto Better got out while Kalshi still paid ${Math.round(q.bid * 100)}¢` : `our live chance was ${Math.round(q.live.p * 100)}% but Kalshi was paying ${Math.round(q.bid * 100)}¢`} and sold it for <b>$${r.proceeds_usd}</b> of the $${Number(b.stake).toFixed(2)} stake.<br><br>Turn this off any time on the Auto Better page (Auto cash-out).`);
        out.push({ user: uid, auto_cashout: b.id, ok: r.ok });
      }
    }
    out.push({ user: uid, room: +room.toFixed(2), extras_room: +xroom.toFixed(2) });
  }
  return out;
}

// Money you moved INTO / OUT OF Kalshi (read-only, from Kalshi's own records). Deposits count once applied.
async function funding() {
  const pageAll = async (path: string, key: string) => {
    const rows: any[] = []; let cursor = ""; let ok = true;
    for (let i = 0; i < 20; i++) {
      const r = await kalshi("GET", `${path}?limit=500${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      if (!r.ok) { ok = false; break; }
      rows.push(...(r.data?.[key] ?? [])); cursor = r.data?.cursor ?? "";
      if (!cursor) break;
    }
    return { ok, rows };
  };
  const dep = await pageAll("/portfolio/deposits", "deposits");
  const wd = await pageAll("/portfolio/withdrawals", "withdrawals");
  const sum = (rows: any[], st: string[]) => rows.filter((x) => st.includes(String(x.status))).reduce((a, x) => a + Number(x.amount_cents ?? 0), 0) / 100;
  const deposited = dep.ok ? sum(dep.rows, ["applied"]) : null;
  const pending = dep.ok ? sum(dep.rows, ["pending"]) : null;
  const withdrawn = wd.ok ? sum(wd.rows, ["applied", "completed", "processed", "pending"]) : null;
  const fees = dep.ok ? dep.rows.filter((x) => x.status === "applied").reduce((a, x) => a + Number(x.fee_cents ?? 0), 0) / 100 : null;
  const first = dep.ok && dep.rows.length ? Math.min(...dep.rows.map((x) => Number(x.created_ts) || Infinity)) : null;
  return { deposits_ok: dep.ok, withdrawals_ok: wd.ok, deposited_usd: deposited, pending_usd: pending, withdrawn_usd: withdrawn,
           net_deposited_usd: deposited == null ? null : deposited - (withdrawn ?? 0), fees_usd: fees,
           deposit_count: dep.ok ? dep.rows.filter((x) => x.status === "applied").length : null,
           first_deposit_at: first && isFinite(first) ? new Date(first * 1000).toISOString() : null };
}

// Watchdog (read-only): Kalshi orders/fills in the last N hours that the app has no record of.
// Anything here was placed outside the app (by you directly on Kalshi, or by someone else).
async function auditOrders(sb: any, hours = 26) {
  const minTs = Math.floor(Date.now() / 1000 - hours * 3600);
  const o = await kalshi("GET", `/portfolio/orders?min_ts=${minTs}&limit=200`);
  const f = await kalshi("GET", `/portfolio/fills?min_ts=${minTs}&limit=200`);
  if (!o.ok && !f.ok) return { ok: false, error: `Kalshi did not answer (orders ${o.status}, fills ${f.status})` };
  const { data: bets } = await sb.from("my_bets").select("external_order_id,ticker,legs").eq("book", "Kalshi")
    .gte("placed_at", new Date(Date.now() - (hours + 24 * 14) * 3600e3).toISOString());
  const ids = new Set<string>(), tickers = new Set<string>();
  for (const b of bets ?? []) {
    if (b.external_order_id) ids.add(String(b.external_order_id));
    if (b.ticker) tickers.add(String(b.ticker));
  }
  const unknown = new Map<string, any>();
  const rows = [...(o.data?.orders ?? []), ...(f.data?.fills ?? [])];
  for (const x of rows) {
    const id = String(x.order_id ?? ""); const t = String(x.ticker ?? x.market_ticker ?? "");
    if (!id || ids.has(id) || (t && tickers.has(t)) || unknown.has(id)) continue;
    unknown.set(id, { order_id: id, ticker: t, side: x.side ?? null, action: x.action ?? null, status: x.status ?? "filled",
      contracts: Number(x.count_fp ?? x.count ?? x.initial_count_fp ?? x.initial_count ?? x.fill_count ?? 0),
      price: x.yes_price_dollars ?? x.yes_price ?? null, at: x.created_time ?? x.ts ?? null });
  }
  return { ok: true, checked: rows.length, unknown: [...unknown.values()] };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const cronTok = req.headers.get("x-pbm-cron");
    if (cronTok) {
      const sbc = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
      const { data: cfg } = await sbc.from("private_config").select("value").eq("key", "cron_token").single();
      if (!cfg || cfg.value !== cronTok) return json({ ok: false, error: "not authorized" }, 401);
      const cbody = await req.json().catch(() => ({}));
      if (cbody.action === "auto_run") {
        const auto = await autoRun(sbc);
        const funds = await fundsCheck(sbc).catch((e) => [{ funds_error: String(e) }]);   // read-only low-funds email
        return json({ ok: true, auto, ...(funds.length ? { funds } : {}) });
      }   // only acts for users who switched Auto Trader ON
      if (cbody.action === "funding") return json({ ok: true, ...(await funding()) });   // read-only totals
      if (cbody.action === "audit_orders") return json(await auditOrders(sbc, Number(cbody.hours ?? 26)));   // watchdog, read-only
      if (cbody.action === "deposits_sync") return json({ ok: true, ...(await syncDeposits(sbc)) });
      const res = await syncResults(sbc); await snapBalance(sbc).catch(() => {});
      const dep = await syncDeposits(sbc).catch((e) => ({ deposits_error: String(e) }));
      return json({ ok: true, ...res, ...dep });
    }
    const authHeader = req.headers.get("Authorization") ?? "";
    const userSb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: u } = await userSb.auth.getUser();
    if (!u?.user) return json({ ok: false, error: "Sign in required" }, 401);
    const allowed = (Deno.env.get("KALSHI_ALLOWED_EMAILS") ?? "").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
    const myRole = await memberRole(createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!), u.user.id);
    if (myRole === "research") return json({ ok: false, connected: false, research: true, error: "Research account: betting is not available here" }, 403);
    if (!allowed.includes((u.user.email ?? "").toLowerCase()) && myRole !== "owner" && myRole !== "member")
      return json({ ok: false, error: "This account is not allowed to use Kalshi" }, 403);

    const body = await req.json().catch(() => ({}));
    const action = body.action ?? "status";
    if (action !== "status") console.log("action", action, JSON.stringify({ items: Array.isArray(body.items) ? body.items.length : undefined, confirm: body.confirm }));
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const ctx: Ctx = { sb, userSb, userId: u.user.id };

    // Two-factor: once the user has a verified authenticator, every money action needs an aal2 session.
    if (["order", "checkout", "combo_accept", "combo_place", "cashout"].includes(action) || (action === "auto_set" && (body.enabled === true || body.auto_cashout === true || body.auto_zplus === true))) {
      const { data: f } = await sb.auth.admin.mfa.listFactors({ userId: u.user.id });
      const hasVerified = (f?.factors ?? []).some((x: any) => x.status === "verified");
      let aal = "aal1", totpAt = 0;
      try {
        let p = authHeader.replace(/^Bearer /, "").split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
        while (p.length % 4) p += "=";
        const claims = JSON.parse(atob(p));
        aal = claims.aal ?? "aal1";
        totpAt = Math.max(0, ...((claims.amr ?? []) as any[]).filter((a) => a?.method === "totp" || a?.method === "mfa/totp").map((a) => Number(a.timestamp) || 0));
      } catch { /* keep aal1 */ }
      if (hasVerified && aal !== "aal2") return json({ ok: false, error: "Enter your authenticator code to place bets", mfa_required: true }, 403);
      // Switching the Auto Trader ON always needs a FRESH code (entered in the last 5 minutes), even in an already-verified session
      if (action === "auto_set" && body.enabled === true && hasVerified && Date.now() / 1000 - totpAt > 300)
        return json({ ok: false, error: "Enter your authenticator code to turn on the Auto Trader", mfa_required: true, fresh_code_required: true }, 403);
    }

    // 2026-10-26 cash-out: live sell value of my open single bets, and selling one (authenticator + your OK on the exact price)
    if (action === "cashout_quote") {
      const ids = (Array.isArray(body.bet_ids) ? body.bet_ids : []).slice(0, 25);
      const { data: bets } = await sb.from("my_bets").select("*").eq("user_id", u.user.id).in("id", ids.length ? ids : [-1]);
      const quotes: any[] = [];
      for (const b of bets ?? []) quotes.push(await cashoutQuote(sb, b).catch((e) => ({ ok: false, bet_id: b.id, error: String(e) })));
      return json({ ok: true, quotes: quotes.map((q, i) => ({ bet_id: (bets ?? [])[i]?.id, ...q })) });
    }
    if (action === "cashout") {
      if (body.confirm !== true) return json({ ok: false, error: "confirm:true is required" }, 400);
      const { data: b } = await sb.from("my_bets").select("*").eq("user_id", u.user.id).eq("id", body.bet_id).maybeSingle();
      if (!b) return json({ ok: false, error: "Bet not found" }, 404);
      const minPrice = Number(body.min_price);
      if (!(minPrice > 0 && minPrice < 1)) return json({ ok: false, error: "min_price is required" }, 400);
      const r: any = await cashoutSell(sb, b, minPrice);
      if (r.ok) await sb.from("auto_trader_log").insert({ user_id: u.user.id, game_id: b.game_id, kind: "cashout", pick: b.pick, price: r.price, stake: Number(b.stake),
        status: "placed", reason: `Cash-out by you: sold ${r.sold} at ${Math.round(r.price * 100)}¢ for $${r.proceeds_usd}`, bet_key: `cashout|${b.id}` });
      return json(r, r.ok ? 200 : 409);
    }
    if (action === "auto_get") {
      const { data: s0 } = await sb.from("auto_trader_settings").select("*").eq("user_id", u.user.id).maybeSingle();
      const { data: lg } = await sb.from("auto_trader_log").select("*").eq("user_id", u.user.id).order("run_at", { ascending: false }).limit(30);
      const { data: rc } = await sb.from("roll_chains").select("*").eq("user_id", u.user.id).order("started_at", { ascending: false }).limit(10);
      return json({ ok: true, settings: s0 ?? { enabled: false, tiers: [10, 25, 50, 100], weekly_cap_usd: 400, loss_stop_usd: 200, include_props: true, include_parlays: true, max_parlays_week: 2, parlay_profile: 1, bet_profile: 1, extras_cap_usd: 180, parlay_legs: 0, early_edge: false, roll_enabled: false, roll_start_stake: 25, roll_legs: 4 }, log: lg ?? [], roll_chains: rc ?? [] });
    }
    if (action === "auto_set") {
      // switching ON requires the authenticator (checked above); switching OFF never does
      const patch: any = { user_id: u.user.id, updated_at: new Date().toISOString() };
      if (typeof body.enabled === "boolean") { patch.enabled = body.enabled; if (body.enabled) { patch.enabled_at = patch.updated_at; patch.disabled_reason = null; } else { patch.disabled_at = patch.updated_at; patch.disabled_reason = "Turned off by you"; } }
      const num = (v: any, lo: number, hi: number) => Math.min(hi, Math.max(lo, Number(v)));
      if (body.weekly_cap_usd != null) patch.weekly_cap_usd = num(body.weekly_cap_usd, 10, 5000);
      if (body.loss_stop_usd != null) patch.loss_stop_usd = num(body.loss_stop_usd, 10, 5000);
      if (Array.isArray(body.tiers)) patch.tiers = body.tiers.map(Number).filter((v: number) => [10, 25, 50, 100].includes(v));
      for (const k of ["include_props", "include_parlays", "early_edge", "roll_enabled"]) if (typeof body[k] === "boolean") patch[k] = body[k];
      if (body.roll_start_stake != null) patch.roll_start_stake = [10, 25, 50].includes(Number(body.roll_start_stake)) ? Number(body.roll_start_stake) : 25;
      if (body.roll_legs != null) patch.roll_legs = Math.round(num(body.roll_legs, 2, 5));
      // 2026-10-06: the six edge features (all start OFF)
      for (const k of ["limit_orders", "kelly_sizing", "teasers", "clv_timing", "middles", "roll_cashout", "auto_cashout", "auto_zplus"]) if (typeof body[k] === "boolean") patch[k] = body[k];
      // 2026-10-11: your own A+ / A bet amounts (null = use the bet profile)
      for (const k of ["stake_aplus", "stake_a"]) if (k in body) patch[k] = body[k] == null || body[k] === "" ? null : Math.round(num(body[k], 5, 500));
      // 2026-10-10: Jamie's Pick auto parlays (off by default)
      if (typeof body.jamie_auto === "boolean") patch.jamie_auto = body.jamie_auto;
      if (body.jamie_stake != null) patch.jamie_stake = Math.round(num(body.jamie_stake, 1, 50));
      if (body.jamie_legs != null) patch.jamie_legs = Number(body.jamie_legs) === 5 ? 5 : 4;
      if (body.jamie_after_min != null) patch.jamie_after_min = Math.round(num(body.jamie_after_min, 0, 55));
      if (body.jamie_max_day != null) patch.jamie_max_day = Math.round(num(body.jamie_max_day, 1, 5));
      if (body.jamie_min_grade != null) patch.jamie_min_grade = ["A+", "A", "B"].includes(String(body.jamie_min_grade)) ? String(body.jamie_min_grade) : "A";
      // 2026-10-10: extra grades and their max bets
      for (const k of ["include_bplus", "include_b", "include_c"]) if (typeof body[k] === "boolean") patch[k] = body[k];
      for (const k of ["max_bplus", "max_b", "max_c"]) if (body[k] != null) patch[k] = Math.round(num(body[k], 5, 100));
      if (body.limit_improve_cents != null) patch.limit_improve_cents = Math.round(num(body.limit_improve_cents, 1, 5));
      if (body.limit_fallback_min != null) patch.limit_fallback_min = Math.round(num(body.limit_fallback_min, 16, 80));
      if (body.kelly_fraction != null) patch.kelly_fraction = [0.1, 0.25, 0.5].includes(Number(body.kelly_fraction)) ? Number(body.kelly_fraction) : 0.25;
      if (body.teaser_stake != null) patch.teaser_stake = [10, 25, 50].includes(Number(body.teaser_stake)) ? Number(body.teaser_stake) : 25;
      if (body.max_teasers_week != null) patch.max_teasers_week = Math.round(num(body.max_teasers_week, 0, 3));
      if (body.middle_max_cost != null) patch.middle_max_cost = num(body.middle_max_cost, 0, 0.1);
      if (body.middle_max_usd != null) patch.middle_max_usd = num(body.middle_max_usd, 5, 200);
      if (body.roll_cashout_at != null) patch.roll_cashout_at = num(body.roll_cashout_at, 0.6, 0.98);
      if (body.max_parlays_week != null) patch.max_parlays_week = Math.round(num(body.max_parlays_week, 0, 10));
      if (body.parlay_legs != null) patch.parlay_legs = [0, 2, 3, 4, 24].includes(Number(body.parlay_legs)) ? Number(body.parlay_legs) : 0;   // 24 = 2-leg core + 4-leg long shot
      if (body.parlay_profile != null) patch.parlay_profile = [1, 2, 3].includes(Number(body.parlay_profile)) ? Number(body.parlay_profile) : 1;
      // one profile for everything: bet_profile (parlay_profile kept in step for older screens)
      if (body.bet_profile != null) patch.bet_profile = patch.parlay_profile = [1, 2, 3].includes(Number(body.bet_profile)) ? Number(body.bet_profile) : 1;
      else if (body.parlay_profile != null) patch.bet_profile = patch.parlay_profile;
      if (body.extras_cap_usd != null) patch.extras_cap_usd = num(body.extras_cap_usd, 0, 5000);
      const { data: saved, error } = await sb.from("auto_trader_settings").upsert(patch).select().single();
      if (error) return json({ ok: false, error: error.message }, 400);
      if (typeof body.enabled === "boolean") await emailUser(sb, u.user.id, body.enabled ? "Auto Trader switched ON" : "Auto Trader switched OFF",
        body.enabled ? "Auto Trader is ON" : "Auto Trader is OFF",
        body.enabled ? `It will bet A/A+ picks, top props and parlays inside your limits: bets of $${saved.tiers.join("/$")} (max $${Math.max(...saved.tiers)} per game), weekly cap $${saved.weekly_cap_usd}, auto-stop after $${saved.loss_stop_usd} of losses in 7 days. You'll get an email for every bet.`
                     : "No more automatic bets will be placed. Bets already placed stay open.");
      return json({ ok: true, settings: saved });
    }
    if (action === "funding") {
      // total deposited / withdrawn + all-time profit = (cash + open positions) - net deposited
      // 2026-10-19 shared account: a member sees only HIS money; the owner's numbers leave every member's money out
      const r2 = (v: number) => Math.round(v * 100) / 100;
      const { data: mrows } = await sb.from("member_bankroll").select("user_id,bankroll_start,settled_pnl,open_stake,available");
      const { data: mlog } = await sb.from("member_money_log").select("member_email,amount,kind");
      const { data: mem } = await sb.from("app_members").select("email,user_id").eq("role", "member");
      const mNet = (uid: string) => {
        const em = (mem ?? []).find((m: any) => m.user_id === uid)?.email;
        const rows = (mlog ?? []).filter((x: any) => x.member_email === em);
        const dep = rows.filter((x: any) => x.kind !== "withdrawal").reduce((a: number, x: any) => a + Number(x.amount), 0);
        const wd = rows.filter((x: any) => x.kind === "withdrawal").reduce((a: number, x: any) => a + Number(x.amount), 0);
        return { dep, wd };
      };
      if (myRole === "member") {
        const me = (mrows ?? []).find((x: any) => x.user_id === ctx.userId);
        const { dep, wd } = mNet(ctx.userId);
        const value = r2(Number(me?.available ?? 0) + Number(me?.open_stake ?? 0));
        return json({ ok: true, shared_account: true, deposits_ok: true, withdrawals_ok: true, deposited_usd: r2(dep), pending_usd: 0, withdrawn_usd: r2(wd),
          net_deposited_usd: r2(dep - wd), fees_usd: 0, deposit_count: null, first_deposit_at: null,
          account_value_usd: value, all_time_pl_usd: r2(value - (dep - wd)), settled_pl_usd: r2(Number(me?.settled_pnl ?? 0)) });
      }
      const f = await funding();
      const b = await kalshi("GET", "/portfolio/balance");
      const total = b.ok && b.data.balance != null ? (Number(b.data.balance) + Number(b.data.portfolio_value ?? 0)) / 100 : null;
      let mValue = 0, mNetDep = 0, mDep = 0, mWd = 0;
      for (const m of mrows ?? []) { const x = mNet(m.user_id); mValue += Number(m.available ?? 0) + Number(m.open_stake ?? 0); mNetDep += x.dep - x.wd; mDep += x.dep; mWd += x.wd; }
      const ownTotal = total == null ? null : r2(total - mValue);
      const ownNet = f.net_deposited_usd == null ? null : r2(f.net_deposited_usd - mNetDep);
      return json({ ok: true, ...f, deposited_usd: f.deposited_usd == null ? null : r2(f.deposited_usd - mDep), net_deposited_usd: ownNet,
                    account_value_usd: ownTotal, members_value_usd: r2(mValue), kalshi_account_total_usd: total,
                    all_time_pl_usd: ownTotal != null && ownNet != null ? r2(ownTotal - ownNet) : null });
    }
    if (action === "status") {
      const r = await kalshi("GET", "/portfolio/balance");
      if (!r.ok) return json({ ok: false, connected: false, env: ENV, error: `Kalshi ${r.status}: ${JSON.stringify(r.data).slice(0, 300)}` }, 502);
      const cents = r.data.balance ?? null;
      const pv = r.data.portfolio_value ?? null;   // current market value of open positions, cents
      await snapBalance(sb, r.data).catch(() => {});
      const { data: hist } = await sb.from("kalshi_balance_log").select("at,balance_usd,portfolio_value_usd,total_usd")
        .gte("at", new Date(Date.now() - 90 * 864e5).toISOString()).order("at");
      if (myRole === "member") {
        const { data: me } = await sb.from("member_bankroll").select("*").eq("user_id", ctx.userId).maybeSingle();
        const avail = cents == null ? null : await spendable(sb, ctx.userId, cents / 100);
        return json({ ok: true, connected: true, env: ENV, shared_account: true, balance_usd: avail,
                      portfolio_value_usd: Number(me?.open_stake ?? 0), total_usd: avail == null ? null : +(avail + Number(me?.open_stake ?? 0)).toFixed(2),
                      bankroll_start: Number(me?.bankroll_start ?? 0), settled_pnl: Number(me?.settled_pnl ?? 0),
                      updated_at: new Date().toISOString(), history: [], max_order_usd: MAX_ORDER_USD, max_checkout_usd: MAX_CHECKOUT_USD });
      }
      const ownerAvail = cents == null ? null : await spendable(sb, ctx.userId, cents / 100);
      return json({ ok: true, connected: true, env: ENV, balance_usd: cents == null ? null : cents / 100, available_usd: ownerAvail,
                    portfolio_value_usd: pv == null ? null : pv / 100,
                    total_usd: cents == null ? null : (cents + (pv ?? 0)) / 100,
                    updated_at: r.data.updated_ts ? new Date(Number(r.data.updated_ts) * 1000).toISOString() : new Date().toISOString(),
                    history: hist ?? [],
                    max_order_usd: MAX_ORDER_USD, max_checkout_usd: MAX_CHECKOUT_USD });
    }

    if (action === "market") {
      const { data: g } = await sb.from("games").select("game_id,home_team,away_team,game_date_et").eq("game_id", body.game_id).single();
      if (!g) return json({ ok: false, error: "game not found" }, 404);
      const m = await findMarkets(g);
      return json({ ok: true, env: ENV, found: !!m, ...(m ?? {}) });
    }

    if (action === "order") {
      // Never trade without an explicit confirm from the user in the UI.
      if (body.confirm !== true) return json({ ok: false, error: "Order not placed: confirm:true is required" }, 400);
      const res = await placeOne(ctx, body);
      return json({ env: ENV, ...res }, res.ok ? 200 : 400);
    }

    if (action === "checkout") {
      // Bet slip: the user reviewed every line and pressed ONE confirm button. Still validated item by item.
      if (body.confirm !== true) return json({ ok: false, error: "Nothing placed: confirm:true is required" }, 400);
      const items: any[] = Array.isArray(body.items) ? body.items.slice(0, 20) : [];
      if (!items.length) return json({ ok: false, error: "Bet slip is empty" }, 400);
      const total = +items.reduce((s, it) => s + Math.floor(Number(it.count)) * Number(it.limit_price), 0).toFixed(2);
      if (total > MAX_CHECKOUT_USD) return json({ ok: false, error: `Slip total $${total} is above the $${MAX_CHECKOUT_USD} checkout cap - nothing was placed` }, 400);
      const bal = await kalshi("GET", "/portfolio/balance");
      const cash = bal.ok && bal.data.balance != null ? await spendable(sb, ctx.userId, bal.data.balance / 100) : null;
      if (cash != null && total > cash) return json({ ok: false, error: `Slip total $${total} is more than your available money $${cash.toFixed(2)} - nothing was placed` }, 400);
      const results = [];
      for (const it of items) results.push({ cart_id: it.cart_id ?? null, label: it.label ?? null, ...(await placeOne(ctx, it)) });
      const placed = results.filter((r) => r.ok);
      if (placed.length) await userSb.from("bet_cart").delete().in("id", placed.map((r) => r.cart_id).filter(Boolean));
      console.log("checkout", JSON.stringify({ items: items.length, total, placed: placed.length,
        errors: results.filter((r) => !r.ok).map((r: any) => `${r.label ?? r.cart_id}: ${r.error}`) }));
      const allOk = placed.length === results.length;
      return json({ ok: allOk, env: ENV, placed: placed.length, failed: results.length - placed.length,
                    total_usd: total, results,
                    error: allOk ? null : results.filter((r: any) => !r.ok).map((r: any) => `${r.label ?? "bet"}: ${r.error}`).join(" | ") },
                  placed.length ? 200 : 400);
    }

    if (action === "jamie_quote") {
      // Jamie's Pick: live Kalshi price for the board's current 4- or 5-leg parlay. No money moves.
      // To buy, the app then calls combo_accept (confirm:true) with the returned rfq_id / quote_id, legs and pick_prefix "JAMIE".
      const n = [3, 5].includes(Number(body.n_legs)) ? Number(body.n_legs) : 4;   // 3-, 4- or 5-leg
      const kind = body.kind === "big" ? "big" : "safe";   // "big" = Jamie's Big Coin Flip Payout
      // 2026-10-12: game_id = the parlay built from one game only (the game picker on Jamie's Pick)
      const { data: jp } = body.game_id
        ? await sb.from("jamie_game_parlays").select("*").eq("game_id", String(body.game_id)).eq("kind", kind).eq("n_legs", kind === "big" ? 4 : n).maybeSingle()
        : await sb.from("jamie_parlays").select("*").eq("kind", kind).eq("n_legs", kind === "big" ? 4 : n).maybeSingle();
      if (!jp) return json({ ok: false, error: kind === "big" ? "No Big Coin Flip parlay on the board right now" : `No ${n}-leg Jamie's Pick parlay on the board right now` }, 400);
      const stake = Math.min(100, Math.max(1, Number(body.stake ?? 10) || 10));
      const count = Math.max(1, Math.floor(stake / Math.max(0.05, Number(jp.cost))));
      const legs = (jp.legs ?? []).map((l: any) => ({ ticker: l.ticker, label: l.label, game_id: l.game_id, side: l.side }));
      let res: any = await comboQuote(ctx, { legs, count, source: "jamie" });
      let priceMoved = false;
      if (res.ok && Number(res.total_usd) > stake * 1.25) {
        // 2026-10-12: Kalshi's real price is above the board's - re-size to the stake at the REAL price and show it,
        // so you can decide (the real payout, our chance and whether it still has value), instead of refusing
        await kalshi("DELETE", `/communications/rfqs/${res.rfq_id}`);
        const c2 = Math.floor(stake / Math.max(0.05, Number(res.price)));
        if (c2 < 1) return json({ ok: false, error: `Kalshi quoted ${Math.round(res.price * 100)}¢ - your stake is too small for 1 contract`, n_legs: n }, 400);
        res = await comboQuote(ctx, { legs, count: c2, source: "jamie" });
        priceMoved = true;
        if (res.ok && Number(res.total_usd) > stake * 1.25) {   // moved again while re-quoting - still never offer an oversized buy
          await kalshi("DELETE", `/communications/rfqs/${res.rfq_id}`);
          return json({ ok: false, error: `Kalshi's price keeps moving (now ${Math.round(res.price * 100)}¢) - try again in a minute`, n_legs: n }, 400);
        }
      }
      return json({ ...res, kind, n_legs: n, grade: jp.grade, board_cost: Number(jp.cost), board_prob: Number(jp.our_prob), price_moved: priceMoved,
        payout_multiple: res.ok ? +(1 / Number(res.price)).toFixed(1) : null, legs_for_accept: legs, pick_prefix: "JAMIE" }, res.ok ? 200 : 400);
    }

    if (action === "combo_quote") {
      // Gets a live price for a parlay. No money moves.
      const res = await comboQuote(ctx, body);
      return json(res, res.ok ? 200 : 400);
    }

    if (action === "combo_accept") {
      // Buys the parlay at the price the user saw - ONLY with confirm:true.
      if (body.confirm !== true) return json({ ok: false, error: "Parlay not placed: confirm:true is required" }, 400);
      if (body.allow_duplicate !== true && Array.isArray(body.legs) && body.legs.length) {
        const dup = await findDuplicate(ctx, { legs: body.legs.map((l: any) => String(l?.ticker ?? l)) });
        if (dup) return json({ ok: false, duplicate: true, error: dup }, 409);
      }
      const res = await comboAccept(ctx, body);
      return json(res, res.ok ? 200 : 400);
    }

    if (action === "combo_place") {
      // One-click parlays: for each parlay the user approved (legs + contracts + the highest price per contract they accept),
      // get a fresh Kalshi price and buy it ONLY if it is at or below that approved max. ONLY with confirm:true.
      if (body.confirm !== true) return json({ ok: false, error: "Parlays not placed: confirm:true is required" }, 400);
      const parlays: any[] = Array.isArray(body.parlays) ? body.parlays.slice(0, 5) : [];
      if (!parlays.length) return json({ ok: false, error: "No parlays sent" }, 400);
      const results: any[] = [];
      for (const p of parlays) {
        try {
          if (p.allow_duplicate !== true) {
            const dup = await findDuplicate(ctx, { legs: (p.legs ?? []).map((l: any) => String(l?.ticker ?? l)) });
            if (dup) { results.push({ name: p.name ?? null, ok: false, duplicate: true, error: dup }); continue; }
          }
          const q: any = await comboQuote(ctx, { legs: p.legs, count: p.count });
          if (!q.ok) { results.push({ name: p.name ?? null, ok: false, error: q.error }); continue; }
          const maxPrice = Number(p.max_price);
          if (!(maxPrice > 0 && maxPrice < 1)) { results.push({ name: p.name ?? null, ok: false, error: "max_price missing" }); continue; }
          if (q.price > maxPrice) {
            await kalshi("DELETE", `/communications/rfqs/${q.rfq_id}`);
            results.push({ name: p.name ?? null, ok: false, error: `Kalshi's price $${q.price} is above your max $${maxPrice} - skipped`, price: q.price });
            continue;
          }
          const legs = q.legs.map((l: any) => ({ ticker: l.ticker, label: l.label }));
          const game_id = (await ctx.sb.from("alt_lines_board").select("game_id").eq("ticker", legs[0].ticker).maybeSingle()).data?.game_id ?? null;
          const a: any = await comboAccept(ctx, { rfq_id: q.rfq_id, quote_id: q.quote_id, max_price: maxPrice, legs, game_id });
          results.push({ name: p.name ?? null, ...a, our_prob: q.our_prob });
        } catch (e) {
          results.push({ name: p.name ?? null, ok: false, error: String(e instanceof Error ? e.message : e) });
        }
      }
      const placed = results.filter((r) => r.ok).length;
      console.log("combo_place", JSON.stringify(results.map((r) => ({ name: r.name, ok: r.ok, error: r.error, price: r.price, warning: r.warning }))));
      return json({ ok: placed === results.length, placed, failed: results.length - placed, results,
                    error: placed === results.length ? null : results.filter((r) => !r.ok).map((r) => `${r.name ?? "parlay"}: ${r.error ?? r.warning}`).join(" | ") },
                  placed ? 200 : 400);
    }

    if (action === "sync_results") {
      return json({ ok: true, ...(await syncResults(sb)) });
    }

    if (action === "combo_cancel") {
      if (body.rfq_id) await kalshi("DELETE", `/communications/rfqs/${body.rfq_id}`);
      return json({ ok: true });
    }

    return json({ ok: false, error: "unknown action" }, 400);
  } catch (err) {
    console.log("error", String(err instanceof Error ? err.message : err));
    return json({ ok: false, error: String(err instanceof Error ? err.message : err) }, 500);
  }
});
