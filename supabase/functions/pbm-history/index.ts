// ===== SUPABASE EDGE FUNCTION: pbm-history =====
// Loads historical study data: nflverse schedules/results, injury reports, snap counts (GitHub releases, free)
// and Kalshi NFL game-market price history (public market data). Run by the schedule with the cron token.
import { createClient } from "npm:@supabase/supabase-js@2";
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-pbm-cron" };
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const NFLV = "https://github.com/nflverse/nflverse-data/releases/download";
const KALSHI = "https://api.elections.kalshi.com/trade-api/v2";

// small CSV parser (handles quoted fields with commas/quotes)
function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = []; let row: string[] = [], f = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(f); f = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(f); rows.push(row); row = []; f = ""; }
    else f += c;
  }
  if (f.length || row.length) { row.push(f); rows.push(row); }
  const head = rows.shift() ?? [];
  return rows.filter((r) => r.length > 1).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""])));
}
const num = (v: string) => (v === "" || v === "NA" || v == null ? null : Number(v));
const txt = (v: string) => (v === "" || v === "NA" ? null : v);

// ET kickoff -> UTC (nflverse gametime is US Eastern local time)
function etToUtc(day: string, time: string) {
  if (!day) return null;
  const t = time && /^\d{1,2}:\d{2}$/.test(time) ? time : "13:00";
  const guess = new Date(`${day}T${t}:00Z`);
  const etStr = guess.toLocaleString("en-US", { timeZone: "America/New_York", hour12: false });
  const et = new Date(etStr + " UTC");
  return new Date(guess.getTime() + (guess.getTime() - et.getTime())).toISOString();
}

async function upsert(sb: any, table: string, rows: any[], conflict: string) {
  for (let i = 0; i < rows.length; i += 1000) {
    const { error } = await sb.from(table).upsert(rows.slice(i, i + 1000), { onConflict: conflict });
    if (error) throw new Error(`${table}: ${error.message}`);
  }
  return rows.length;
}

async function getCsv(url: string) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return parseCsv(await r.text());
}

async function kalshi(path: string) {
  for (let a = 0; a < 3; a++) {
    const r = await fetch(`${KALSHI}${path}`, { headers: { Accept: "application/json" } });
    if (r.status === 429) { await new Promise((s) => setTimeout(s, 1500 * (a + 1))); continue; }
    const d = await r.json().catch(() => null);
    if (!r.ok) throw new Error(`Kalshi ${r.status} ${path}: ${JSON.stringify(d).slice(0, 200)}`);
    return d;
  }
  throw new Error("Kalshi rate limited");
}
const cents = (o: any, k: string) => { const raw = o?.[k + "_dollars"] ?? o?.[k]; if (raw == null || raw === "") return null; const v = Number(raw); return v > 1 ? v / 100 : v; };   // handles "0.6000" dollars or 60 cents

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const tok = req.headers.get("x-pbm-cron");
  const { data: cfg } = await sb.from("private_config").select("value").eq("key", "cron_token").single();
  if (!tok || !cfg || cfg.value !== tok) return json({ ok: false, error: "not authorized" }, 401);
  let body: any = {}; try { body = await req.json(); } catch { /* empty */ }
  const log = (dataset: string, season: number | null, rows: number, note = "") => sb.from("hist_load_log").insert({ dataset, season, rows, note });
  try {
    if (body.action === "load_schedules") {
      const all = await getCsv(`${NFLV}/schedules/games.csv`);
      const rows = all.filter((g) => Number(g.season) >= (body.from ?? 2020)).map((g) => ({
        game_id: g.game_id, season: num(g.season), game_type: txt(g.game_type), week: num(g.week), gameday: txt(g.gameday),
        gametime: txt(g.gametime), kickoff_utc: etToUtc(g.gameday, g.gametime), away_team: g.away_team, home_team: g.home_team,
        away_score: num(g.away_score), home_score: num(g.home_score), result: num(g.result), spread_line: num(g.spread_line),
        total_line: num(g.total_line), away_moneyline: num(g.away_moneyline), home_moneyline: num(g.home_moneyline),
        div_game: num(g.div_game), roof: txt(g.roof) }));
      const n = await upsert(sb, "hist_games", rows, "game_id"); await log("schedules", null, n);
      return json({ ok: true, rows: n });
    }
    if (body.action === "load_injuries") {
      const s = Number(body.season);
      const all = await getCsv(`${NFLV}/injuries/injuries_${s}.csv`);
      const seen = new Set<string>(); const rows: any[] = [];
      for (const r of all) {
        const k = `${r.season}|${r.game_type}|${r.week}|${r.team}|${r.gsis_id}`; if (!r.gsis_id || seen.has(k)) continue; seen.add(k);
        rows.push({ season: num(r.season), game_type: r.game_type, week: num(r.week), team: r.team, gsis_id: r.gsis_id, position: txt(r.position),
          full_name: txt(r.full_name), report_primary_injury: txt(r.report_primary_injury), report_status: txt(r.report_status),
          practice_status: txt(r.practice_status), date_modified: txt(r.date_modified) });
      }
      const n = await upsert(sb, "hist_injuries", rows, "season,game_type,week,team,gsis_id"); await log("injuries", s, n);
      return json({ ok: true, season: s, rows: n });
    }
    if (body.action === "load_snaps") {
      const s = Number(body.season);
      const all = await getCsv(`${NFLV}/snap_counts/snap_counts_${s}.csv`);
      const seen = new Set<string>(); const rows: any[] = [];
      for (const r of all) {
        const k = `${r.game_id}|${r.pfr_player_id}`; if (!r.pfr_player_id || seen.has(k)) continue; seen.add(k);
        rows.push({ game_id: r.game_id, season: num(r.season), week: num(r.week), team: r.team, player: r.player, pfr_player_id: r.pfr_player_id,
          position: txt(r.position), offense_pct: num(r.offense_pct), defense_pct: num(r.defense_pct), st_pct: num(r.st_pct) });
      }
      const n = await upsert(sb, "hist_snaps", rows, "game_id,pfr_player_id"); await log("snaps", s, n);
      return json({ ok: true, season: s, rows: n });
    }
    if (body.action === "kalshi_markets") {
      // list settled NFL game-winner markets (one page per call; returns next cursor)
      // recent markets live under /markets; older seasons are archived under /historical/markets
      const series = body.series ?? "KXNFLGAME"; const hist = body.hist === true;
      let cursor: string | null = body.cursor ?? null, n = 0, pages = 0;
      do {
        const d = await kalshi(`${hist ? "/historical" : ""}/markets?series_ticker=${series}${hist ? "" : "&status=settled"}&limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
        const rows = (d.markets ?? []).map((m: any) => ({ ticker: m.ticker, event_ticker: m.event_ticker, series, title: m.title,
          yes_team: m.yes_sub_title ?? null, open_time: m.open_time, close_time: m.close_time, result: m.result ?? null, hist }));
        if (rows.length) n += await upsert(sb, "hist_kalshi_markets", rows, "ticker");
        cursor = d.cursor || null; pages++;
      } while (cursor && pages < 20);
      await log("kalshi_markets", null, n, series + (hist ? " (historical)" : ""));
      return json({ ok: true, rows: n, pages, cursor });
    }
    if (body.action === "kalshi_prices") {
      // hourly candles for the next batch of markets not loaded yet
      const { data: ms } = await sb.from("hist_kalshi_markets").select("ticker,series,open_time,close_time,hist").eq("prices_loaded", false).limit(Number(body.n ?? 25));
      let done = 0, candles = 0;
      for (const m of ms ?? []) {
        try {
          const start = Math.floor(new Date(m.open_time).getTime() / 1000), end = Math.floor(new Date(m.close_time).getTime() / 1000);
          const all: any[] = [];
          for (let s = start; s < end; s += 5000 * 3600) {      // stay under the per-request candle limit
            const q = `candlesticks?start_ts=${s}&end_ts=${Math.min(end, s + 5000 * 3600)}&period_interval=60`;
            const d = await kalshi(m.hist ? `/historical/markets/${m.ticker}/${q}` : `/series/${m.series}/markets/${m.ticker}/${q}`);
            all.push(...(d.candlesticks ?? []));
          }
          const rows = all.map((c: any) => ({ ticker: m.ticker, ts: new Date(c.end_period_ts * 1000).toISOString(),
            yes_bid: cents(c.yes_bid, "close"), yes_ask: cents(c.yes_ask, "close"), price: cents(c.price, "close"),
            volume: c.volume != null ? Number(c.volume) : null, open_interest: c.open_interest != null ? Number(c.open_interest) : null }));
          if (rows.length) await upsert(sb, "hist_kalshi_prices", rows, "ticker,ts");
          await sb.from("hist_kalshi_markets").update({ prices_loaded: true, candles: rows.length, error: null }).eq("ticker", m.ticker);
          done++; candles += rows.length;
        } catch (e) {
          await sb.from("hist_kalshi_markets").update({ prices_loaded: true, error: String(e).slice(0, 300) }).eq("ticker", m.ticker);
        }
      }
      return json({ ok: true, markets: done, candles, remaining_batch: (ms ?? []).length });
    }
    if (body.action === "kalshi_flow") {
      // Trades on each upcoming game's two winner markets since last run -> hourly buckets by the team the trade's initiator backed
      const BIG = Number(body.big_usd ?? 500), MAXP = Number(body.max_pages ?? 30);
      const { data: up } = await sb.from("games").select("game_id,home_team,away_team,kickoff_utc")
        .gt("kickoff_utc", new Date(Date.now() - 4 * 3600e3).toISOString()).lt("kickoff_utc", new Date(Date.now() + 8 * 864e5).toISOString());
      const byGame: Record<string, any> = Object.fromEntries((up ?? []).map((x: any) => [x.game_id, x]));
      const { data: km } = await sb.from("kalshi_markets").select("game_id,home_ticker,away_ticker").in("game_id", Object.keys(byGame).length ? Object.keys(byGame) : ["none"]);
      const gm = (km ?? []).map((k: any) => ({ ...k, games: byGame[k.game_id] }));
      const { data: curs } = await sb.from("kalshi_flow_cursor").select("ticker,last_time");
      const last: Record<string, string> = Object.fromEntries((curs ?? []).map((c: any) => [c.ticker, c.last_time]));
      let total = 0;
      for (const g of gm ?? []) {
        const gi: any = (g as any).games;
        for (const [ticker, yesTeam, otherTeam] of [[g.home_ticker, gi.home_team, gi.away_team], [g.away_ticker, gi.away_team, gi.home_team]]) {
          if (!ticker) continue;
          const since = last[ticker] ? new Date(last[ticker]) : new Date(Date.now() - 24 * 3600e3);
          const kickoff = new Date(gi.kickoff_utc);
          let cursor: string | null = null, pages = 0, newest: string | null = null; const trades: any[] = [];
          do {
            const d = await kalshi(`/markets/trades?ticker=${ticker}&limit=1000&min_ts=${Math.floor(since.getTime() / 1000)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
            for (const t of d.trades ?? []) { if (new Date(t.created_time) > since && new Date(t.created_time) < kickoff) trades.push(t); }
            if (!newest && d.trades?.length) newest = d.trades[0].created_time;
            cursor = d.cursor || null; pages++;
          } while (cursor && pages < MAXP);
          const buckets: Record<string, any> = {}; const bigs: any[] = [];
          for (const t of trades) {
            const n = Number(t.count_fp ?? t.count ?? 0);
            const yes = t.taker_side === "yes";
            const price = Number(yes ? (t.yes_price_dollars ?? t.yes_price / 100) : (t.no_price_dollars ?? t.no_price / 100));
            const team = yes ? yesTeam : otherTeam, usd = n * price;
            const hour = new Date(Math.floor(new Date(t.created_time).getTime() / 3600e3) * 3600e3).toISOString();
            const k = `${hour}|${team}`;
            const b = buckets[k] ??= { game_id: g.game_id, ticker, hour, backed_team: team, trades: 0, contracts: 0, dollars: 0, big_trades: 0, big_dollars: 0 };
            b.trades++; b.contracts += n; b.dollars += usd;
            if (usd >= BIG || n >= 1000) { b.big_trades++; b.big_dollars += usd;   // big = $500+ risked OR 1,000+ contracts (fair to underdogs)
              bigs.push({ trade_id: t.trade_id, game_id: g.game_id, ticker, backed_team: team, contracts: n, price, dollars: Math.round(usd * 100) / 100, created_time: t.created_time, is_block: !!t.is_block_trade }); }
          }
          // add to existing hourly rows (runs are incremental)
          const rows = Object.values(buckets);
          if (rows.length) {
            const { data: prev } = await sb.from("kalshi_flow_hourly").select("hour,backed_team,trades,contracts,dollars,big_trades,big_dollars")
              .eq("ticker", ticker).in("hour", [...new Set(rows.map((r: any) => r.hour))]);
            const pk: Record<string, any> = Object.fromEntries((prev ?? []).map((p: any) => [`${new Date(p.hour).toISOString()}|${p.backed_team}`, p]));
            for (const r of rows as any[]) { const p = pk[`${r.hour}|${r.backed_team}`]; if (p) { r.trades += p.trades; r.contracts += Number(p.contracts);
              r.dollars += Number(p.dollars); r.big_trades += p.big_trades; r.big_dollars += Number(p.big_dollars); }
              r.contracts = Math.round(r.contracts * 100) / 100; r.dollars = Math.round(r.dollars * 100) / 100; r.big_dollars = Math.round(r.big_dollars * 100) / 100; }
            await upsert(sb, "kalshi_flow_hourly", rows, "ticker,hour,backed_team");
          }
          if (bigs.length) await upsert(sb, "kalshi_big_trades", bigs, "trade_id");
          if (newest || !last[ticker]) await sb.from("kalshi_flow_cursor").upsert({ ticker, last_time: newest ?? since.toISOString(), partial: !!cursor, updated_at: new Date().toISOString() });
          total += trades.length;
        }
      }
      return json({ ok: true, games: (gm ?? []).length, trades: total });
    }
    if (body.action === "kalshi_probe") {
      // read-only look at a public Kalshi market-data path (used to locate archived seasons)
      const path = String(body.path ?? "");
      if (!/^\/(historical\/)?(markets|events|series|exchange)/.test(path)) return json({ ok: false, error: "path not allowed" }, 400);
      const r = await fetch(`${KALSHI}${path}`, { headers: { Accept: "application/json" } });
      return json({ ok: r.ok, status: r.status, body: (await r.text()).slice(0, 2500) });
    }
    return json({ ok: false, error: "unknown action" }, 400);
  } catch (e) {
    return json({ ok: false, error: String(e instanceof Error ? e.message : e) }, 500);
  }
});
