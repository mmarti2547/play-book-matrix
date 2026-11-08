// ===== SUPABASE EDGE FUNCTION: pbm-latebet =====
// Late bets: lets the owner/members place a single NFL game or spread bet in the first 5 minutes AFTER kickoff,
// but only while Kalshi's live price is still within 2c of the price captured at kickoff (nothing big has happened yet).
//  - cron (x-pbm-cron) every minute, body {action:"snapshot"}: records live Kalshi prices for games kicking off in the
//    next 3 minutes (slip tickers + both winner markets) into public.kalshi_kickoff_price. Read-only on Kalshi.
//  - user, body {action:"late", confirm:true, game_id, ticker, side, count, label?, grade?}: authenticator required,
//    immediate-or-cancel buy at the live price (never rests into the game), logged in my_bets with origin "late".
// The main pbm-kalshi function is untouched and still refuses every bet once a game has started.
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-pbm-cron" };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });
const ENV = (Deno.env.get("KALSHI_ENV") ?? "prod").toLowerCase();
const BASE = ENV === "demo" ? "https://external-api.demo.kalshi.co" : "https://api.elections.kalshi.com";
const PREFIX = "/trade-api/v2";
const LATE_MIN = 5;            // minutes after kickoff the late window stays open
const MAX_MOVE = 0.02;         // live price must be within 2c of the kickoff price
const MAX_ORDER_USD = Number(Deno.env.get("KALSHI_MAX_ORDER_USD") ?? "500");

function pemBytes(pem: string) { const b64 = pem.replace(/-----[^-]+-----/g, "").replace(/\\n/g, "").replace(/\s+/g, ""); return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)); }
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
  try { const k = await crypto.subtle.importKey("pkcs8", der, { name: "RSA-PSS", hash: "SHA-256" }, false, ["sign"]); signer = (m) => crypto.subtle.sign({ name: "RSA-PSS", saltLength: 32 }, k, m); }
  catch { const k = await crypto.subtle.importKey("pkcs8", der, { name: "Ed25519" }, false, ["sign"]); signer = (m) => crypto.subtle.sign({ name: "Ed25519" }, k, m); }
  return signer;
}
async function kalshi(method: string, path: string, body?: unknown) {
  const sign = await getSigner();
  const ts = Date.now().toString();
  const full = PREFIX + path;
  const sig = await sign(new TextEncoder().encode(ts + method + full.split("?")[0]));
  const r = await fetch(BASE + full, { method, headers: { "KALSHI-ACCESS-KEY": Deno.env.get("KALSHI_API_KEY_ID")!, "KALSHI-ACCESS-TIMESTAMP": ts,
    "KALSHI-ACCESS-SIGNATURE": btoa(String.fromCharCode(...new Uint8Array(sig))), "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  let d: any = null; try { d = JSON.parse(t); } catch { d = { raw: t.slice(0, 300) }; }
  return { ok: r.ok, status: r.status, data: d };
}
const dollars = (d: any, c: any) => (d != null ? Number(d) : c != null ? Number(c) / 100 : 0);
const sidePrice = (yesBid: number, yesAsk: number, side: string) => (side === "no" ? +(1 - yesBid).toFixed(4) : yesAsk);   // cost to BUY that side
const toAmerican = (p: number) => (p >= 0.5 ? -Math.round((100 * p) / (1 - p)) : Math.round((100 * (1 - p)) / p));
const isLocationErr = (d: unknown) => /location_attestation/i.test(JSON.stringify(d ?? ""));

async function snapshot(sb: any) {
  const now = Date.now();
  const { data: games } = await sb.from("games").select("game_id,kickoff_utc")
    .gt("kickoff_utc", new Date(now).toISOString()).lte("kickoff_utc", new Date(now + 3 * 60e3).toISOString());
  if (!games?.length) return { games: 0, saved: 0 };
  const ids = games.map((g: any) => g.game_id);
  const tick = new Map<string, string>();
  const { data: cart } = await sb.from("bet_cart").select("game_id,ticker").in("game_id", ids);
  for (const c of cart ?? []) if (c.ticker) tick.set(c.ticker, c.game_id);
  const { data: km } = await sb.from("kalshi_markets").select("game_id,home_ticker,away_ticker").in("game_id", ids);
  for (const k of km ?? []) { if (k.home_ticker) tick.set(k.home_ticker, k.game_id); if (k.away_ticker) tick.set(k.away_ticker, k.game_id); }
  let saved = 0;
  for (const [t, gid] of tick) {
    const r = await kalshi("GET", `/markets/${encodeURIComponent(t)}`);
    const m = r.data?.market;
    if (!r.ok || !m) continue;
    await sb.from("kalshi_kickoff_price").upsert({ ticker: t, game_id: gid, yes_bid: dollars(m.yes_bid_dollars, m.yes_bid), yes_ask: dollars(m.yes_ask_dollars, m.yes_ask), captured_at: new Date().toISOString() });
    saved++;
  }
  return { games: games.length, saved };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const body = await req.json().catch(() => ({}));
    const cronHdr = req.headers.get("x-pbm-cron");
    if (cronHdr) {
      const { data: cfg } = await sb.from("private_config").select("value").eq("key", "cron_token").single();
      if (!cfg?.value || cfg.value !== cronHdr) return json({ ok: false, error: "not allowed" }, 401);
      if (body.action === "snapshot") return json({ ok: true, ...(await snapshot(sb)) });
      return json({ ok: false, error: "unknown action" }, 400);
    }

    // ---- user: late bet
    const authHeader = req.headers.get("Authorization") ?? "";
    const userSb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: authHeader } } });
    const { data: u } = await userSb.auth.getUser();
    if (!u?.user) return json({ ok: false, error: "Sign in required" }, 401);
    const { data: mem } = await sb.from("app_members").select("role").eq("user_id", u.user.id).maybeSingle();
    const role = mem?.role ?? null;
    if (role !== "owner" && role !== "member") return json({ ok: false, error: "This account can't place bets" }, 403);
    if (body.action !== "late") return json({ ok: false, error: "unknown action" }, 400);
    if (body.confirm !== true) return json({ ok: false, error: "Nothing placed: confirm:true is required" }, 400);

    // authenticator (same rule as pbm-kalshi)
    const { data: f } = await sb.auth.admin.mfa.listFactors({ userId: u.user.id });
    if ((f?.factors ?? []).some((x: any) => x.status === "verified")) {
      let aal = "aal1";
      try { let p = authHeader.replace(/^Bearer /, "").split(".")[1].replace(/-/g, "+").replace(/_/g, "/"); while (p.length % 4) p += "="; aal = JSON.parse(atob(p)).aal ?? "aal1"; } catch { /* aal1 */ }
      if (aal !== "aal2") return json({ ok: false, error: "Enter your authenticator code to place bets", mfa_required: true }, 403);
    }

    const ticker = String(body.ticker ?? "");
    const side = body.side === "no" ? "no" : "yes";
    const count = Math.floor(Number(body.count));
    if (!/^KXNFL(SPREAD|GAME)-/.test(ticker)) return json({ ok: false, error: "Only NFL game and spread contracts can be late bets" });
    if (!(count >= 1)) return json({ ok: false, error: "count must be at least 1 contract" });
    const { data: g } = await sb.from("games").select("game_id,kickoff_utc").eq("game_id", body.game_id).single();
    if (!g) return json({ ok: false, error: "game not found" });
    const k = new Date(g.kickoff_utc).getTime(), now = Date.now();
    if (now < k) return json({ ok: false, error: "Game hasn't started — use the normal Bet button" });
    if (now > k + LATE_MIN * 60e3) return json({ ok: false, error: `Late window closed (${LATE_MIN} min after kickoff)` });

    // ticker must belong to this game
    const { data: alt } = await sb.from("kalshi_alt_lines").select("game_id").eq("ticker", ticker).maybeSingle();
    const { data: km } = await sb.from("kalshi_markets").select("game_id").eq("game_id", g.game_id).or(`home_ticker.eq.${ticker},away_ticker.eq.${ticker}`).maybeSingle();
    const { data: ct } = await sb.from("bet_cart").select("game_id").eq("ticker", ticker).eq("game_id", g.game_id).limit(1).maybeSingle();
    if (alt?.game_id !== g.game_id && !km && !ct) return json({ ok: false, error: "That contract is not for this game" });

    // price guard vs kickoff
    const { data: snap } = await sb.from("kalshi_kickoff_price").select("yes_bid,yes_ask,captured_at").eq("ticker", ticker).maybeSingle();
    if (!snap) return json({ ok: false, error: "No kickoff price was recorded for this bet, so a late bet isn't allowed" });
    const live = await kalshi("GET", `/markets/${encodeURIComponent(ticker)}`);
    const m = live.data?.market;
    if (!live.ok || !m) return json({ ok: false, error: "Couldn't read Kalshi's live price" });
    if (!["active", "open"].includes(String(m.status))) return json({ ok: false, error: "Kalshi has this market paused right now — try again in a moment" });
    const yb = dollars(m.yes_bid_dollars, m.yes_bid), ya = dollars(m.yes_ask_dollars, m.yes_ask);
    const nowPx = sidePrice(yb, ya, side);
    const kickPx = sidePrice(Number(snap.yes_bid), Number(snap.yes_ask), side);
    if (!(nowPx > 0 && nowPx < 1)) return json({ ok: false, error: "No seller on Kalshi right now" });
    if (Math.abs(nowPx - kickPx) > MAX_MOVE + 1e-9)
      return json({ ok: false, moved: true, error: `Price moved ${Math.round(kickPx * 100)}¢ → ${Math.round(nowPx * 100)}¢ since kickoff — something happened in the game, late bet blocked`, kickoff_price: kickPx, live_price: nowPx });

    // money + duplicate checks
    const cost = +(count * nowPx).toFixed(2);
    if (cost > MAX_ORDER_USD) return json({ ok: false, error: `Order cost $${cost} is above the $${MAX_ORDER_USD} per-order cap` });
    const bal = await kalshi("GET", "/portfolio/balance");
    if (bal.ok && bal.data.balance != null) {
      const cash = bal.data.balance / 100;
      const { data: rows } = await sb.from("member_bankroll").select("user_id,available");
      const mine = role === "member"
        ? Math.max(0, Math.min(cash, Number((rows ?? []).find((r: any) => r.user_id === u.user.id)?.available ?? 0)))
        : Math.max(0, cash - (rows ?? []).reduce((s: number, r: any) => s + Math.max(0, Number(r.available ?? 0)), 0));
      if (cost > mine + 1e-9) return json({ ok: false, error: `Order cost $${cost} is more than your available money $${mine.toFixed(2)}` });
    }
    const { data: dup } = await sb.from("my_bets").select("id,result,status").eq("user_id", u.user.id).eq("ticker", ticker).eq("side", side)
      .gte("placed_at", new Date(now - 14 * 864e5).toISOString());
    if ((dup ?? []).some((b: any) => b.result !== "void" && !["canceled", "not_placed", "not_filled"].includes(String(b.status))))
      return json({ ok: false, duplicate: true, error: "You already have this bet" });

    // immediate-or-cancel at the live price: fills now or not at all (never sits on the book during the game)
    const yesPrice = side === "yes" ? nowPx : 1 - nowPx;
    const order = { ticker, side: side === "yes" ? "bid" : "ask", count: count.toFixed(2), price: (Math.round(yesPrice * 100) / 100).toFixed(2),
      time_in_force: "immediate_or_cancel", self_trade_prevention_type: "taker_at_cross", client_order_id: crypto.randomUUID() };
    const r = await kalshi("POST", "/portfolio/events/orders", order);
    if (!r.ok) return json({ ok: false, location: isLocationErr(r.data), error: isLocationErr(r.data) ? "Kalshi needs you to re-verify your location in the Kalshi app" : `Kalshi rejected the order (${r.status}): ${JSON.stringify(r.data).slice(0, 200)}` });
    const d = r.data.order ?? r.data;
    let fill = Number(d.fill_count_fp ?? d.fill_count ?? 0);
    if (!(fill > 0) && d.order_id) { const gq = await kalshi("GET", `/portfolio/orders/${d.order_id}`); if (gq.data?.order) fill = Number(gq.data.order.fill_count_fp ?? gq.data.order.fill_count ?? 0); }
    if (!(fill > 0)) return json({ ok: false, error: "Kalshi couldn't fill it at the live price — nothing placed" });
    const filled = Math.floor(fill);
    const spent = +(filled * nowPx).toFixed(2);
    const market = ticker.startsWith("KXNFLSPREAD") ? (body.source === "main_pick" ? "spread" : "alt_spread") : "moneyline";
    const { data: bet, error } = await userSb.from("my_bets").insert({
      user_id: u.user.id, game_id: g.game_id, book: "Kalshi", market, pick: String(body.label ?? ticker), line: body.line ?? null,
      odds: toAmerican(nowPx), stake: spent, status: filled >= count ? "filled" : "partially_filled", external_order_id: d.order_id,
      ticker, side, contracts: filled, grade: body.grade ?? null, origin: "late", order_mode: "late_ioc", ask_at_order: nowPx,
    }).select().single();
    return json({ ok: true, late: true, ticker, side, filled, price: nowPx, kickoff_price: kickPx, cost_usd: spent, order_id: d.order_id, logged_bet_id: bet?.id ?? null, log_error: error?.message ?? null });
  } catch (err) {
    return json({ ok: false, error: String(err instanceof Error ? err.message : err) }, 500);
  }
});
