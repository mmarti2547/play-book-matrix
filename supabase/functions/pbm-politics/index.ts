// ===== SUPABASE EDGE FUNCTION: pbm-politics =====
// READ-ONLY Kalshi bridge for the Politics page. Never places, changes or cancels orders.
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

const num = (...v: any[]) => { for (const x of v) { if (x !== undefined && x !== null && x !== "" && !isNaN(Number(x))) return Number(x); } return 0; };
const dollars = (d: any, c: any) => (d !== undefined && d !== null ? Number(d) : c !== undefined && c !== null ? Number(c) / 100 : 0);

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
    if (!ticker || SPORTS_PREFIX.test(ticker)) continue;
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
  for (const a of Object.values(agg)) {
    const m = (await kget(`/markets/${a.ticker}`)).market;
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
