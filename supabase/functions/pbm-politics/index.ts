// ===== SUPABASE EDGE FUNCTION: pbm-politics =====
// Kalshi bridge for the Politics page. Reads positions; the ONLY money action is 'sell'
// (owner only, confirm:true + authenticator, reduce-only fill-or-kill at a price the owner approved). It never buys.
// Pulls Michael's election/politics positions from Kalshi, grades them (won/lost/open),
// and saves a snapshot to public.politics_picks. Called by cron (x-pbm-cron) or the owner.
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
const OWNER_ID = "a28c1685-021f-48f6-a525-f96de523adf5";
const SINCE_TS = Math.floor(Date.parse("2026-10-20T00:00:00Z") / 1000);
const POLITICS = /elect|polit|senate|house|governor|mayor|congress|president|ballot|world/i;
const SPORTS_PREFIX = /^(KXNFL|KXMVE|KXNCAA|KXNBA|KXNHL|KXMLB|KXEPL|KXUFC|KXSB)/;

// ---------- Kalshi signing (same scheme as pbm-kalshi) ----------
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
let signer: ((m: Uint8Array) => Promise<ArrayBuffer>) | null = null;
async function getSigner() {
  if (signer) return signer;
  const pem = Deno.env.get("KALSHI_PRIVATE_KEY");
  if (!pem || !Deno.env.get("KALSHI_API_KEY_ID")) throw new Error("Kalshi secrets missing");
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
async function kget(path: string) {
  const sign = await getSigner();
  const ts = Date.now().toString();
  const full = PREFIX + path;
  const sig = await sign(new TextEncoder().encode(ts + "GET" + full.split("?")[0]));
  const r = await fetch(BASE + full, {
    headers: {
      "KALSHI-ACCESS-KEY": Deno.env.get("KALSHI_API_KEY_ID")!,
      "KALSHI-ACCESS-TIMESTAMP": ts,
      "KALSHI-ACCESS-SIGNATURE": btoa(String.fromCharCode(...new Uint8Array(sig))),
    },
  });
  const t = await r.text();
  let d: any = null;
  try { d = JSON.parse(t); } catch { d = { raw: t.slice(0, 300) }; }
  if (!r.ok) throw new Error(`Kalshi GET ${path.split("?")[0]} ${r.status}: ${JSON.stringify(d).slice(0, 200)}`);
  return d;
}
async function kpages(path: string, key: string, max = 10) {
  const out: any[] = [];
  let cursor = "";
  for (let i = 0; i < max; i++) {
    const d = await kget(path + (path.includes("?") ? "&" : "?") + "limit=200" + (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""));
    out.push(...(d[key] ?? []));
    cursor = d.cursor;
    if (!cursor) break;
  }
  return out;
}

async function kpost(path: string, body: unknown) {
  const sign = await getSigner();
  const ts = Date.now().toString();
  const full = PREFIX + path;
  const sig = await sign(new TextEncoder().encode(ts + "POST" + full.split("?")[0]));
  const r = await fetch(BASE + full, {
    method: "POST",
    headers: {
      "KALSHI-ACCESS-KEY": Deno.env.get("KALSHI_API_KEY_ID")!,
      "KALSHI-ACCESS-TIMESTAMP": ts,
      "KALSHI-ACCESS-SIGNATURE": btoa(String.fromCharCode(...new Uint8Array(sig))),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const t = await r.text();
  let d: any = null;
  try { d = JSON.parse(t); } catch { d = { raw: t.slice(0, 300) }; }
  return { ok: r.ok, status: r.status, data: d };
}
const feeOf = (c: number, p: number) => (p > 0 && p < 1 ? Math.ceil(0.07 * c * p * (1 - p) * 100) / 100 : 0);

// What selling ALL of this position would pay right now (no money moves).
async function sellQuote(ticker: string, side: "yes" | "no") {
  const pos = (await kget(`/portfolio/positions?ticker=${encodeURIComponent(ticker)}&count_filter=position`)).market_positions ?? [];
  const p = pos.find((x: any) => x.ticker === ticker);
  const held = p ? Number(p.position_fp ?? p.position ?? 0) : 0; // + = YES contracts, - = NO contracts
  const contracts = side === "yes" ? Math.max(0, held) : Math.max(0, -held);
  if (!(contracts > 0)) return { ok: false, error: "You don't hold this position anymore" };
  const m = (await kget(`/markets/${encodeURIComponent(ticker)}`)).market;
  if (!["active", "open"].includes(String(m.status))) return { ok: false, error: "Kalshi isn't trading this market right now" };
  const yb = dollars(m.yes_bid_dollars, m.yes_bid), ya = dollars(m.yes_ask_dollars, m.yes_ask);
  const bid = side === "yes" ? yb : +(1 - ya).toFixed(4);
  const c = +contracts.toFixed(2);
  const fee = feeOf(c, bid);
  return { ok: true, ticker, side, contracts: c, bid, fee_usd: fee, value_usd: bid > 0 ? +(c * bid - fee).toFixed(2) : 0 };
}

// Sell (reduce-only, fill-or-kill) at the quoted bid. Same order format as pbm-kalshi.
async function sellOrder(ticker: string, side: "yes" | "no", count: number, price: number) {
  const yesPrice = side === "yes" ? price : 1 - price;
  const mk = (cnt: number) => ({
    ticker, side: side === "yes" ? "ask" : "bid", count: cnt.toFixed(2),
    price: (Math.round(yesPrice * 100) / 100).toFixed(2), time_in_force: "fill_or_kill",
    self_trade_prevention_type: "taker_at_cross", client_order_id: crypto.randomUUID(), reduce_only: true,
  });
  let r = await kpost("/portfolio/events/orders", mk(count));
  if (!r.ok && Math.floor(count) !== count && Math.floor(count) >= 1) r = await kpost("/portfolio/events/orders", mk(Math.floor(count)));
  if (!r.ok) return { ok: false, error: `Kalshi rejected the sale (${r.status}): ${JSON.stringify(r.data).slice(0, 200)}` };
  const d = r.data.order ?? r.data;
  let fill = Number(d.fill_count_fp ?? d.fill_count ?? 0);
  if (!(fill > 0) && d.order_id) {
    const g = await kget(`/portfolio/orders/${d.order_id}`).catch(() => null);
    if (g?.order) fill = Number(g.order.fill_count_fp ?? g.order.fill_count ?? 0);
  }
  return { ok: true, fill, order_id: d.order_id };
}

const num = (...v: any[]) => { for (const x of v) { if (x !== undefined && x !== null && x !== "" && !isNaN(Number(x))) return Number(x); } return 0; };
const dollars = (d: any, c: any) => (d !== undefined && d !== null ? Number(d) : c !== undefined && c !== null ? Number(c) / 100 : 0);

const sellNow = (m: any, side: string, contracts: number) => {
  if (!["active", "open"].includes(String(m.status))) return { sell_bid: null, sell_value: null };
  const yb = dollars(m.yes_bid_dollars, m.yes_bid), ya = dollars(m.yes_ask_dollars, m.yes_ask);
  const bid = side === "no" ? (ya > 0 ? +(1 - ya).toFixed(4) : 0) : yb;
  return { sell_bid: bid, sell_value: bid > 0 ? +(contracts * bid - feeOf(contracts, bid)).toFixed(2) : 0 };
};

async function build() {
  const fills = await kpages(`/portfolio/fills?min_ts=${SINCE_TS}`, "fills");
  const positions = await kpages(`/portfolio/positions?count_filter=total_traded`, "market_positions");
  const posBy: Record<string, any> = {};
  for (const p of positions) posBy[p.ticker] = p;

  // group fills by ticker + side
  type Agg = { ticker: string; side: string; contracts: number; cost: number; fees: number; first: string };
  const agg: Record<string, Agg> = {};
  for (const f of fills) {
    const ticker = f.ticker ?? f.market_ticker;
    if (!ticker || (SPORTS_PREFIX.test(ticker) && !/^KXMVE/.test(ticker))) continue;
    const side = String(f.side ?? "yes").toLowerCase();
    const cnt = num(f.count_fp, f.count);
    const px = side === "yes" ? dollars(f.yes_price_dollars, f.yes_price) : dollars(f.no_price_dollars, f.no_price);
    const sign = String(f.action ?? "buy").toLowerCase() === "sell" ? -1 : 1;
    const k = ticker + "|" + side;
    agg[k] ??= { ticker, side, contracts: 0, cost: 0, fees: 0, first: f.created_time };
    agg[k].contracts += sign * cnt;
    agg[k].cost += sign * cnt * px;
    agg[k].fees += dollars(f.fee_cost_dollars ?? f.fee_dollars, f.fee_cost);
    if (f.created_time < agg[k].first) agg[k].first = f.created_time;
  }

  const eventCache: Record<string, any> = {};
  const rows: any[] = [];
  const priceOf = (mk: any) => {
    const last = dollars(mk.last_price_dollars, mk.last_price);
    const bid = dollars(mk.yes_bid_dollars, mk.yes_bid);
    const ask = dollars(mk.yes_ask_dollars, mk.yes_ask);
    return bid && ask ? (bid + ask) / 2 : last;
  };
  for (const a of Object.values(agg)) {
    const m = (await kget(`/markets/${a.ticker}`)).market;
    if (/^KXMVE/.test(a.ticker)) {
      // Combo (parlay): include only when every leg is a non-sports (politics) market.
      const legsRaw: any[] = m.mve_selected_legs ?? m.selected_legs ?? m.legs ?? [];
      if (!legsRaw.length) continue;
      const legTk = (l: any) => l.market_ticker ?? l.ticker;
      if (legsRaw.some((l: any) => SPORTS_PREFIX.test(String(legTk(l))) || /^KX(NFL|NCAA|NBA|NHL|MLB)/.test(String(l.event_ticker ?? "")))) continue;
      const legs: any[] = [];
      for (const l of legsRaw) {
        const lm = (await kget(`/markets/${legTk(l)}`)).market;
        const ev = (await kget(`/events/${lm.event_ticker}`)).event ?? {};
        const side = String(l.side ?? "yes").toLowerCase();
        const yc = priceOf(lm);
        const res = String(lm.result ?? "").toLowerCase();
        const name = lm.yes_sub_title || lm.subtitle || lm.title;
        legs.push({
          market_ticker: legTk(l), event_title: ev.title ?? lm.title,
          name: side === "yes" ? name : `Not ${name}`, side,
          chance: +(side === "yes" ? yc : 1 - yc).toFixed(3),
          outcome: res === "yes" || res === "no" ? (res === side ? "won" : "lost") : "open",
        });
      }
      const result = String(m.result ?? "").toLowerCase();
      const settled = (result === "yes" || result === "no") && ["settled", "finalized", "determined"].includes(String(m.status));
      const pos = posBy[a.ticker];
      const fees = pos ? dollars(pos.fees_paid_dollars, pos.fees_paid) : a.fees;
      const contracts = +a.contracts.toFixed(2);
      const cost = +a.cost.toFixed(2);
      const anyLost = legs.some((l) => l.outcome === "lost");
      const allWon = legs.every((l) => l.outcome === "won");
      const outcome = settled ? (result === a.side ? "won" : "lost") : anyLost ? "lost" : allWon ? "won" : "open";
      const payout = outcome === "won" ? contracts : outcome === "lost" ? 0 : null;
      rows.push({
        ticker: a.ticker, side: a.side, user_id: OWNER_ID, is_combo: true,
        event_ticker: m.event_ticker, event_title: `Combo · ${legs.length} legs`, market_title: m.title,
        pick_name: legs.map((l) => l.name).join(" + "),
        contracts, cost, fees: +fees.toFixed(2), avg_price: contracts ? +(cost / contracts).toFixed(4) : null,
        market_status: m.status, result: result || null, outcome,
        settled_on_kalshi: settled,
        payout, net: payout === null ? null : +(payout - cost - fees).toFixed(2),
        potential_payout: contracts, potential_net: +(contracts - cost - fees).toFixed(2),
        pick_chance: +legs.reduce((p, l) => p * l.chance, 1).toFixed(3),
        ...sellNow(m, a.side, contracts),
        candidates: [], legs, close_time: m.close_time ?? null, first_fill: a.first,
        updated_at: new Date().toISOString(),
      });
      continue;
    }
    const evt = m.event_ticker;
    eventCache[evt] ??= await kget(`/events/${evt}?with_nested_markets=true`);
    const ev = eventCache[evt].event ?? {};
    let evMarkets = eventCache[evt].markets ?? ev.markets ?? [];
    if (!evMarkets.length) {
      evMarkets = (await kget(`/markets?event_ticker=${evt}&limit=50`)).markets ?? [];
      eventCache[evt].markets = evMarkets;
    }
    const cat = String(ev.category ?? "");
    if (!POLITICS.test(cat + " " + (ev.title ?? "") + " " + (ev.series_ticker ?? ""))) continue;

    const price = (mk: any) => {
      const last = dollars(mk.last_price_dollars, mk.last_price);
      const bid = dollars(mk.yes_bid_dollars, mk.yes_bid);
      const ask = dollars(mk.yes_ask_dollars, mk.yes_ask);
      return bid && ask ? (bid + ask) / 2 : last;
    };
    const candidates = evMarkets
      .map((mk: any) => ({ ticker: mk.ticker, name: mk.yes_sub_title || mk.subtitle || mk.title, chance: +price(mk).toFixed(3), result: mk.result || null, status: mk.status }))
      .sort((x: any, y: any) => y.chance - x.chance);

    const pos = posBy[a.ticker];
    const fees = pos ? dollars(pos.fees_paid_dollars, pos.fees_paid) : a.fees;
    const result = String(m.result ?? "").toLowerCase(); // "yes" | "no" | ""
    const settled = ["settled", "finalized", "determined"].includes(String(m.status)) && (result === "yes" || result === "no");
    const contracts = +a.contracts.toFixed(2);
    const cost = +a.cost.toFixed(2);
    const won = settled ? result === a.side : null;
    const payout = settled ? (won ? contracts : 0) : null;
    const yesChance = price(m);
    const pickName = m.yes_sub_title || m.subtitle || m.title;
    rows.push({
      ticker: a.ticker, side: a.side, user_id: OWNER_ID,
      event_ticker: evt, event_title: ev.title ?? m.title, market_title: m.title,
      pick_name: a.side === "yes" ? pickName : `Not ${pickName}`,
      contracts, cost, fees: +fees.toFixed(2), avg_price: contracts ? +(cost / contracts).toFixed(4) : null,
      market_status: m.status, result: result || null,
      outcome: settled ? (won ? "won" : "lost") : "open",
      payout, net: settled ? +((payout ?? 0) - cost - fees).toFixed(2) : null,
      potential_payout: contracts, potential_net: +(contracts - cost - fees).toFixed(2),
      pick_chance: +(a.side === "yes" ? yesChance : 1 - yesChance).toFixed(3),
      ...sellNow(m, a.side, contracts),
      candidates, close_time: m.close_time ?? null, first_fill: a.first,
      updated_at: new Date().toISOString(),
    });
  }
  return rows;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const cronHdr = req.headers.get("x-pbm-cron");
    let authed = false;
    if (cronHdr) {
      const { data } = await sb.from("private_config").select("value").eq("key", "cron_token").single();
      authed = !!data?.value && data.value === cronHdr;
    } else {
      const userSb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
        global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
      });
      const { data: u } = await userSb.auth.getUser();
      authed = u?.user?.id === OWNER_ID;
    }
    if (!authed) return json({ ok: false, error: "not allowed" }, 401);

    const body = await req.json().catch(() => ({}));

    // ---------- SELL (owner only, never from cron). quote = no money; sell = needs confirm:true + authenticator ----------
    if (body.action === "sell_quote" || body.action === "sell") {
      if (cronHdr) return json({ ok: false, error: "not allowed" }, 401);
      const ticker = String(body.ticker ?? "");
      const side = body.side === "no" ? "no" : "yes";
      if (!ticker) return json({ ok: false, error: "ticker required" }, 400);
      if (body.action === "sell") {
        if (body.confirm !== true) return json({ ok: false, error: "Nothing sold: confirm:true is required" }, 400);
        const { data: f } = await sb.auth.admin.mfa.listFactors({ userId: OWNER_ID });
        const hasVerified = (f?.factors ?? []).some((x: any) => x.status === "verified");
        let aal = "aal1";
        try {
          let p = (req.headers.get("Authorization") ?? "").replace(/^Bearer /, "").split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
          while (p.length % 4) p += "=";
          aal = JSON.parse(atob(p)).aal ?? "aal1";
        } catch { /* keep aal1 */ }
        if (hasVerified && aal !== "aal2") return json({ ok: false, error: "Enter your authenticator code to sell", mfa_required: true }, 403);
      }
      const q = await sellQuote(ticker, side);
      if (!q.ok || body.action === "sell_quote") return json(q);
      const minPrice = Number(body.min_price);
      if (!(q.bid > 0)) return json({ ok: false, error: "No buyer on Kalshi right now - nothing sold" });
      if (!(minPrice > 0) || q.bid + 1e-9 < minPrice)
        return json({ ok: false, error: `Price moved to ${Math.round(q.bid * 100)}¢ (you approved ${Math.round(minPrice * 100)}¢) - nothing sold`, quote: q });
      const r = await sellOrder(ticker, side, q.contracts, q.bid);
      if (!r.ok) return json({ ok: false, error: r.error });
      if (!(r.fill > 0)) return json({ ok: false, error: "Kalshi couldn't sell at that price - nothing sold" });
      const proceeds = +(r.fill * q.bid - feeOf(r.fill, q.bid)).toFixed(2);
      return json({ ok: true, sold: r.fill, price: q.bid, proceeds_usd: proceeds, order_id: r.order_id });
    }

    if (body.action === "combos_raw") {
      const since = Math.floor(Date.parse(body.since ?? "2026-11-03T10:00:00Z") / 1000);
      const f = await kpages(`/portfolio/fills?min_ts=${since}`, "fills");
      const tickers = [...new Set(f.map((x: any) => x.ticker ?? x.market_ticker).filter((t: string) => /^KXMVE/.test(t)))];
      const markets = [];
      for (const t of tickers.slice(0, 5)) markets.push((await kget(`/markets/${t}`)).market);
      return json({ ok: true, fills: f.filter((x: any) => /^KXMVE/.test(x.ticker ?? x.market_ticker)), markets });
    }
    if (body.action === "raw") {
      const f = await kget(`/portfolio/fills?min_ts=${SINCE_TS}&limit=5`);
      const p = await kget(`/portfolio/positions?count_filter=total_traded&limit=5`);
      return json({ ok: true, fill_sample: f.fills?.slice(0, 3), position_sample: p.market_positions?.slice(0, 3) });
    }

    const rows = await build();
    let save_error: string | null = null;
    if (rows.length && body.save !== false) {
      const { error } = await sb.from("politics_picks").upsert(rows, { onConflict: "ticker,side" });
      save_error = error?.message ?? null;
    }
    const totals = rows.reduce((t, r) => {
      t.staked += r.cost + r.fees;
      if (r.outcome === "won") t.won++;
      if (r.outcome === "lost") t.lost++;
      if (r.outcome === "open") t.open++;
      if (r.net !== null) t.net += r.net;
      return t;
    }, { staked: 0, won: 0, lost: 0, open: 0, net: 0 });
    return json({ ok: true, count: rows.length, totals, save_error, rows });
  } catch (err) {
    return json({ ok: false, error: String(err instanceof Error ? err.message : err) }, 500);
  }
});
