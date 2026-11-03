// ===== SUPABASE EDGE FUNCTION: pbm-kalshi-prices =====
// Pulls PUBLIC Kalshi NFL prices (no account or keys used): game winners -> kalshi_markets,
// alternate spread ladders -> kalshi_alt_lines, then freezes graded props/parlays for the record.
// Safe to call often: it refreshes at most once per 60 seconds.
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });

const BASE = "https://api.elections.kalshi.com/trade-api/v2";
const ALIAS: Record<string, string> = { LAR: "LA", JAC: "JAX", WSH: "WAS", LVR: "LV", ARZ: "ARI", GNB: "GB", KAN: "KC", NWE: "NE", NOR: "NO", SFO: "SF", TAM: "TB" };
const norm = (t: string) => ALIAS[t?.toUpperCase()] ?? t?.toUpperCase();
const MON: Record<string, string> = { JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06", JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12" };
const num = (d: unknown, c: unknown) => (d != null && d !== "" ? Number(d) : c != null ? Number(c) / 100 : null);
const px = (bid: number | null, ask: number | null, last: number | null) =>
  bid && ask && ask > bid ? (bid + ask) / 2 : last || ask || bid || null;

async function fetchEvents(series: string) {
  const out: any[] = [];
  let cursor = "";
  for (let page = 0; page < 8; page++) {
    const r = await fetch(`${BASE}/events?series_ticker=${series}&status=open&with_nested_markets=true&limit=200${cursor ? "&cursor=" + cursor : ""}`);
    if (!r.ok) throw new Error(`Kalshi ${series} ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const d = await r.json();
    out.push(...(d.events ?? []));
    cursor = d.cursor;
    if (!cursor) break;
  }
  return out;
}
const evDateOf = (ticker: string) => {
  const m = String(ticker).match(/-(\d{2})([A-Z]{3})(\d{2})/);
  return m ? Date.parse(`20${m[1]}-${MON[m[2]]}-${m[3]}T12:00:00Z`) : NaN;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: last } = await sb.from("kalshi_markets").select("fetched_at").order("fetched_at", { ascending: false }).limit(1);
    if (last?.[0] && Date.now() - new Date(last[0].fetched_at).getTime() < 60_000) return json({ ok: true, skipped: "refreshed under 60s ago" });

    const today = new Date(Date.now() - 12 * 3600e3).toISOString().slice(0, 10);
    const { data: games } = await sb.from("games").select("game_id,home_team,away_team,game_date_et")
      .is("home_score", null).gte("game_date_et", today).order("game_date_et").limit(64);
    if (!games?.length) return json({ ok: true, updated: 0, note: "no upcoming games" });

    const events = await fetchEvents("KXNFLGAME");

    const rows: any[] = [];
    for (const ev of events) {
      const m = String(ev.event_ticker).match(/-(\d{2})([A-Z]{3})(\d{2})/);
      if (!m) continue;
      const evDate = Date.parse(`20${m[1]}-${MON[m[2]]}-${m[3]}T12:00:00Z`);
      const mk = (ev.markets ?? []).map((x: any) => ({ ...x, team: norm(String(x.ticker).split("-").pop()!) }));
      const g = games.find((g) => Math.abs(Date.parse(g.game_date_et + "T12:00:00Z") - evDate) <= 86400e3 &&
        mk.some((x: any) => x.team === g.home_team) && mk.some((x: any) => x.team === g.away_team));
      if (!g) continue;
      const h = mk.find((x: any) => x.team === g.home_team), a = mk.find((x: any) => x.team === g.away_team);
      const hb = num(h.yes_bid_dollars, h.yes_bid), ha = num(h.yes_ask_dollars, h.yes_ask), hl = num(h.last_price_dollars, h.last_price);
      const ab = num(a.yes_bid_dollars, a.yes_bid), aa = num(a.yes_ask_dollars, a.yes_ask), al = num(a.last_price_dollars, a.last_price);
      const hp = px(hb, ha, hl), ap = px(ab, aa, al);
      rows.push({
        game_id: g.game_id, event_ticker: ev.event_ticker, home_ticker: h.ticker, away_ticker: a.ticker,
        home_yes_bid: hb, home_yes_ask: ha, away_yes_bid: ab, away_yes_ask: aa, home_last: hl, away_last: al,
        home_prob: hp && ap ? +(hp / (hp + ap)).toFixed(4) : null, // remove the market's overround
        volume: Number(h.volume_fp ?? h.volume ?? 0) + Number(a.volume_fp ?? a.volume ?? 0),
        fetched_at: new Date().toISOString(),
      });
    }
    if (rows.length) {
      const { error } = await sb.from("kalshi_markets").upsert(rows);
      if (error) throw error;
      for (const d of [...new Set(games.filter((g) => rows.some((r) => r.game_id === g.game_id)).map((g) => g.game_date_et))])
        await sb.rpc("snapshot_slate", { d });
    }

    // ---- Alternate spread ladders (KXNFLSPREAD): YES = team wins by more than floor_strike ----
    const spreadEvents = await fetchEvents("KXNFLSPREAD");
    const alt: any[] = [];
    for (const ev of spreadEvents) {
      const evDate = evDateOf(ev.event_ticker);
      const mk = (ev.markets ?? []).map((x: any) => ({ ...x, team: norm(String(x.ticker).split("-").pop()!.replace(/\d+$/, "")) }));
      const g = games.find((g) => Math.abs(Date.parse(g.game_date_et + "T12:00:00Z") - evDate) <= 86400e3 &&
        mk.some((x: any) => x.team === g.home_team) && mk.some((x: any) => x.team === g.away_team));
      if (!g) continue;
      for (const x of mk) {
        if (x.floor_strike == null || (x.team !== g.home_team && x.team !== g.away_team)) continue;
        alt.push({
          ticker: x.ticker, game_id: g.game_id, event_ticker: ev.event_ticker, team: x.team, threshold: Number(x.floor_strike),
          yes_bid: num(x.yes_bid_dollars, x.yes_bid), yes_ask: num(x.yes_ask_dollars, x.yes_ask),
          last_price: num(x.last_price_dollars, x.last_price), volume: Number(x.volume_fp ?? x.volume ?? 0),
          open_interest: Number(x.open_interest_fp ?? x.open_interest ?? 0), status: x.status, fetched_at: new Date().toISOString(),
          event_title: ev.title ?? null, market_title: x.yes_sub_title ?? x.title ?? null,
        });
      }
    }
    for (let i = 0; i < alt.length; i += 500) {
      const { error } = await sb.from("kalshi_alt_lines").upsert(alt.slice(i, i + 500));
      if (error) throw error;
    }
    const { error: logErr } = await sb.rpc("log_alt_picks");
    return json({ ok: true, events: events.length, updated: rows.length, alt_events: spreadEvents.length, alt_lines: alt.length, log_error: logErr?.message ?? null });
  } catch (err) {
    return json({ ok: false, error: String(err instanceof Error ? err.message : err) }, 500);
  }
});
