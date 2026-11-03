// ===== SUPABASE EDGE FUNCTION: pbm-odds =====
// The Odds API (US sportsbooks) - Vegas line data for the Early Edge module. Key lives in the ODDS_API_KEY secret.
import { createClient } from "npm:@supabase/supabase-js@2";
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-pbm-cron" };
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const BASE = "https://api.the-odds-api.com/v4";

async function odds(path: string, params: Record<string, string> = {}) {
  const key = Deno.env.get("ODDS_API_KEY");
  if (!key) throw new Error("ODDS_API_KEY secret is not set");
  const q = new URLSearchParams({ ...params, apiKey: key });
  const r = await fetch(`${BASE}${path}?${q}`);
  const quota = { remaining: r.headers.get("x-requests-remaining"), used: r.headers.get("x-requests-used"), last_cost: r.headers.get("x-requests-last") };
  const data = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`Odds API ${r.status}: ${JSON.stringify(data).slice(0, 200)}`);
  return { data, quota };
}


// ---- team names -> Play Book Matrix codes (incl. old names) ----
const TEAM: Record<string, string> = {
  "Arizona Cardinals":"ARI","Atlanta Falcons":"ATL","Baltimore Ravens":"BAL","Buffalo Bills":"BUF","Carolina Panthers":"CAR",
  "Chicago Bears":"CHI","Cincinnati Bengals":"CIN","Cleveland Browns":"CLE","Dallas Cowboys":"DAL","Denver Broncos":"DEN",
  "Detroit Lions":"DET","Green Bay Packers":"GB","Houston Texans":"HOU","Indianapolis Colts":"IND","Jacksonville Jaguars":"JAX",
  "Kansas City Chiefs":"KC","Las Vegas Raiders":"LV","Oakland Raiders":"LV","Los Angeles Chargers":"LAC","Los Angeles Rams":"LA",
  "Miami Dolphins":"MIA","Minnesota Vikings":"MIN","New England Patriots":"NE","New Orleans Saints":"NO","New York Giants":"NYG",
  "New York Jets":"NYJ","Philadelphia Eagles":"PHI","Pittsburgh Steelers":"PIT","San Francisco 49ers":"SF","Seattle Seahawks":"SEA",
  "Tampa Bay Buccaneers":"TB","Tennessee Titans":"TEN","Washington Commanders":"WAS","Washington Football Team":"WAS",
  "Washington Redskins":"WAS","Washington":"WAS",
};
const code = (n: string) => TEAM[n] ?? n;
const median = (a: number[]) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const dec = (am: number) => (am > 0 ? 1 + am / 100 : 1 + 100 / Math.abs(am));

// One snapshot of events -> consensus rows
function summarize(events: any[], snapAt: string, source: string) {
  const rows: any[] = [];
  for (const ev of events ?? []) {
    const home = ev.home_team, away = ev.away_team;
    const spreads: number[] = [], probs: number[] = []; let dk: number | null = null, fd: number | null = null;
    for (const b of ev.bookmakers ?? []) {
      for (const m of b.markets ?? []) {
        if (m.key === "spreads") {
          const h = (m.outcomes ?? []).find((o: any) => o.name === home);
          if (h && typeof h.point === "number") { spreads.push(h.point); if (b.key === "draftkings") dk = h.point; if (b.key === "fanduel") fd = h.point; }
        } else if (m.key === "h2h") {
          const h = (m.outcomes ?? []).find((o: any) => o.name === home), a = (m.outcomes ?? []).find((o: any) => o.name === away);
          if (h && a && h.price && a.price) { const ph = 1 / dec(h.price), pa = 1 / dec(a.price); probs.push(ph / (ph + pa)); }
        }
      }
    }
    if (!spreads.length && !probs.length) continue;
    const ct = new Date(ev.commence_time);
    rows.push({ event_id: ev.id, season: ct.getUTCMonth() >= 2 ? ct.getUTCFullYear() : ct.getUTCFullYear() - 1, commence_time: ev.commence_time,
      home_team: code(home), away_team: code(away), snap_at: snapAt, source, books: (ev.bookmakers ?? []).length,
      home_spread_med: median(spreads), home_spread_min: spreads.length ? Math.min(...spreads) : null, home_spread_max: spreads.length ? Math.max(...spreads) : null,
      home_ml_prob_med: probs.length ? Math.round(median(probs)! * 10000) / 10000 : null, dk_home_spread: dk, fd_home_spread: fd });
  }
  return rows;
}

// Keep only rows where the consensus changed since the last stored row for that game (and drop games already started)
async function saveChanged(sb: any, rows: any[]) {
  rows = rows.filter((r) => new Date(r.snap_at) < new Date(r.commence_time));
  if (!rows.length) return 0;
  rows.sort((a, b) => a.snap_at.localeCompare(b.snap_at));
  const ids = [...new Set(rows.map((r) => r.event_id))];
  const last: Record<string, any> = {};
  for (let i = 0; i < ids.length; i += 100) {
    const { data } = await sb.rpc("pbm_last_odds", { ids: ids.slice(i, i + 100) });
    for (const r of data ?? []) last[r.event_id] = r;
  }
  const keep: any[] = [];
  for (const r of rows) {
    const p = last[r.event_id];
    const moved = !p || p.home_spread_med !== r.home_spread_med || Math.abs(Number(p.home_ml_prob_med ?? 0) - Number(r.home_ml_prob_med ?? 0)) >= 0.005;
    if (moved && (!p || new Date(r.snap_at) > new Date(p.snap_at))) { keep.push(r); last[r.event_id] = r; }
  }
  for (let i = 0; i < keep.length; i += 500) await sb.from("odds_line_history").upsert(keep.slice(i, i + 500), { onConflict: "event_id,snap_at", ignoreDuplicates: true });
  return keep.length;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const cronTok = req.headers.get("x-pbm-cron");
  if (cronTok) {
    const { data: cfg } = await sb.from("private_config").select("value").eq("key", "cron_token").single();
    if (!cfg || cfg.value !== cronTok) return json({ ok: false, error: "not authorized" }, 401);
  } else {
    const { data: u } = await sb.auth.getUser((req.headers.get("Authorization") ?? "").replace("Bearer ", ""));
    if (!u?.user) return json({ ok: false, error: "sign in required" }, 401);
  }
  let body: any = {}; try { body = await req.json(); } catch { /* empty */ }
  try {
    if (body.action === "check") {
      // /sports is free (no credits); one live NFL spreads call costs 1 credit and shows which books are covered
      const s = await odds("/sports", {});
      const nfl = (s.data ?? []).find((x: any) => x.key === "americanfootball_nfl");
      const live = await odds("/sports/americanfootball_nfl/odds", { regions: "us", markets: "spreads", oddsFormat: "american" });
      const books = [...new Set((live.data ?? []).flatMap((g: any) => (g.bookmakers ?? []).map((b: any) => b.title)))];
      const sample = (live.data ?? []).slice(0, 2).map((g: any) => ({ game: `${g.away_team} @ ${g.home_team}`, kickoff: g.commence_time,
        books: (g.bookmakers ?? []).slice(0, 3).map((b: any) => ({ book: b.title, updated: b.last_update,
          lines: (b.markets?.[0]?.outcomes ?? []).map((o: any) => `${o.name} ${o.point > 0 ? "+" : ""}${o.point} (${o.price})`) })) }));
      return json({ ok: true, nfl_active: !!nfl?.active, games_listed: (live.data ?? []).length, books, sample, quota: live.quota });
    }
    if (body.action === "history_batch") {
      // Claim the next snapshot times and pull them in parallel (10 credits per market per snapshot)
      const { data: ts } = await sb.rpc("claim_odds_batch", { n: Number(body.n ?? 150) });
      if (!ts?.length) return json({ ok: true, idle: true });
      let saved = 0, errors = 0, remaining: string | null = null, lastErr: string | null = null;
      const all: any[] = [];
      for (let i = 0; i < ts.length; i += 10) {
        const chunk = ts.slice(i, i + 10);
        const res = await Promise.all(chunk.map(async (t: string) => {
          const iso = new Date(t).toISOString().replace(/\.\d{3}Z$/, "Z");
          try {
            const r = await odds("/historical/sports/americanfootball_nfl/odds", { regions: "us", markets: "spreads,h2h", oddsFormat: "american", date: iso });
            remaining = r.quota.remaining ?? remaining;
            return summarize(r.data?.data ?? [], r.data?.timestamp ?? iso, "hist");
          } catch (e) {
            errors++; lastErr = String(e instanceof Error ? e.message : e);
            await sb.from("odds_backfill_failed").upsert({ ts: t, error: lastErr.slice(0, 300) });
            return [];
          }
        }));
        for (const rows of res) all.push(...rows);
        if (lastErr && /429|quota|credits/i.test(lastErr)) break;   // back off on rate limit / quota
      }
      saved = await saveChanged(sb, all);
      const { data: c } = await sb.from("odds_backfill").select("calls,rows_saved,errors").eq("id", 1).single();
      await sb.from("odds_backfill").update({ calls: (c?.calls ?? 0) + ts.length, rows_saved: (c?.rows_saved ?? 0) + saved,
        errors: (c?.errors ?? 0) + errors, credits_remaining: remaining ? Number(remaining) : null, last_error: lastErr, updated_at: new Date().toISOString(),
        ...(lastErr && /quota|credits/i.test(lastErr) ? { paused: true } : {}) }).eq("id", 1);
      return json({ ok: true, snapshots: ts.length, saved, errors, remaining });
    }
    if (body.action === "hardrock_lines") {
      // 2026-10-12 Hard Rock Bet (Florida) game lines for research accounts: spreads, moneylines, totals = 3 credits per pull
      const book = String(body.book ?? "hardrockbet_fl");
      const r = await odds("/sports/americanfootball_nfl/odds", { bookmakers: book, markets: "spreads,h2h,totals", oddsFormat: "american" });
      const { data: games } = await sb.from("games").select("game_id,home_team,away_team,kickoff_utc")
        .gte("kickoff_utc", new Date(Date.now() - 6 * 3600e3).toISOString()).lte("kickoff_utc", new Date(Date.now() + 14 * 864e5).toISOString());
      const rows: any[] = [];
      for (const ev of r.data ?? []) {
        const b = (ev.bookmakers ?? []).find((x: any) => x.key === book);
        if (!b) continue;
        const home = code(ev.home_team), away = code(ev.away_team), ct = new Date(ev.commence_time).getTime();
        const g = (games ?? []).find((x: any) => x.home_team === home && x.away_team === away && Math.abs(new Date(x.kickoff_utc).getTime() - ct) < 12 * 3600e3);
        if (!g) continue;
        const mk = (k: string) => (b.markets ?? []).find((m: any) => m.key === k)?.outcomes ?? [];
        const sp = mk("spreads"), ml = mk("h2h"), tot = mk("totals");
        const hs = sp.find((o: any) => o.name === ev.home_team), as = sp.find((o: any) => o.name === ev.away_team);
        const hm = ml.find((o: any) => o.name === ev.home_team), am = ml.find((o: any) => o.name === ev.away_team);
        const ov = tot.find((o: any) => o.name === "Over"), un = tot.find((o: any) => o.name === "Under");
        rows.push({ game_id: g.game_id, book, home_team: home, away_team: away, kickoff_utc: g.kickoff_utc,
          home_spread: hs?.point ?? null, home_spread_price: hs?.price ?? null, away_spread_price: as?.price ?? null,
          home_ml: hm?.price ?? null, away_ml: am?.price ?? null,
          total: ov?.point ?? null, over_price: ov?.price ?? null, under_price: un?.price ?? null,
          book_updated: b.last_update ?? null, fetched_at: new Date().toISOString() });
      }
      if (rows.length) {
        const { error } = await sb.from("hr_game_lines").upsert(rows, { onConflict: "game_id" });
        if (error) return json({ ok: false, error: error.message }, 500);
        await sb.from("hr_game_lines_history").insert(rows.map(({ book_updated, ...x }) => x));
      }
      return json({ ok: true, book, events: (r.data ?? []).length, saved: rows.length, remaining: r.quota.remaining, cost: r.quota.last_cost });
    }
    if (body.action === "live_snapshot") {
      // Current lines for every upcoming game: 1 credit per market
      const r = await odds("/sports/americanfootball_nfl/odds", { regions: "us", markets: "spreads,h2h", oddsFormat: "american" });
      const saved = await saveChanged(sb, summarize(r.data ?? [], new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), "live"));
      return json({ ok: true, games: (r.data ?? []).length, saved, remaining: r.quota.remaining });
    }
    return json({ ok: false, error: "unknown action" }, 400);
  } catch (e) {
    return json({ ok: false, error: String(e instanceof Error ? e.message : e) }, 500);
  }
});
