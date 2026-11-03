// ===== SUPABASE EDGE FUNCTION: pbm-live-scores =====
// NFL scoreboard for the Scorecard ticker and the Scoreboard page. Reads ESPN's public scoreboard (no key).
// Optional body/query: { week, seasontype (2 = regular, 3 = playoffs), year }. No params = the current week.
// Adds field position, down & distance and total yards (from each game's box score, cached).
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };
const FIX: Record<string, string> = { WSH: "WAS", LAR: "LA" };   // ESPN -> Play Book Matrix team codes
const H = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36",
            "Accept": "application/json", "Accept-Language": "en-US,en;q=0.9", "Referer": "https://www.espn.com/" };
const HOSTS = ["https://site.web.api.espn.com", "https://site.api.espn.com"];
const boardCache = new Map<string, { at: number; body: any }>();
const yardsCache = new Map<string, { at: number; v: Record<string, number | null> }>();

async function espn(path: string) {
  const errs: string[] = [];
  for (const h of HOSTS) {
    try {
      const r = await fetch(h + path, { headers: H });
      if (r.ok) return await r.json();
      errs.push(`${new URL(h).host} ${r.status}`);
    } catch (e) { errs.push(`${new URL(h).host} ${e}`); }
  }
  throw new Error(errs.join("; "));
}

// from each game's summary (final games cached 6 h, live games 30 s): total yards per team,
// passing / rushing / receiving leader per team, and the live home win probability
async function totalYards(id: string, state: string) {
  const c = yardsCache.get(id);
  const ttl = state === "post" ? 6 * 3600e3 : 15e3;
  if (c && Date.now() - c.at < ttl) return c.v;
  const v: Record<string, any> = { _leaders: {} as Record<string, any>, _homeWin: null, _scoring: [] as any[], _drive: null };
  try {
    const s = await espn(`/apis/site/v2/sports/football/nfl/summary?event=${id}`);
    for (const t of s.boxscore?.teams ?? []) {
      const abbr = String(t.team?.abbreviation ?? "");
      const st = (t.statistics ?? []).find((x: any) => x.name === "totalYards");
      v[FIX[abbr] ?? abbr] = st ? Number(st.displayValue) : null;
    }
    for (const t of s.leaders ?? []) {
      const abbr = String(t.team?.abbreviation ?? ""); const out: Record<string, any> = {};
      for (const cat of t.leaders ?? []) {
        const k = cat.name === "passingYards" ? "passing" : cat.name === "rushingYards" ? "rushing" : cat.name === "receivingYards" ? "receiving" : null;
        const l = cat.leaders?.[0];
        if (k && l) out[k] = { name: l.athlete?.displayName ?? l.athlete?.shortName ?? null, line: l.displayValue ?? null };
      }
      v._leaders[FIX[abbr] ?? abbr] = out;
    }
    // scoring plays in order: who scored, how, when, and how many points (from the running score)
    let pa = 0, ph = 0;
    for (const sp of s.scoringPlays ?? []) {
      const abbr = String(sp.team?.abbreviation ?? ""); const a = Number(sp.awayScore ?? pa), h = Number(sp.homeScore ?? ph);
      v._scoring.push({ team: FIX[abbr] ?? abbr, type: sp.type?.abbreviation ?? sp.scoringType?.abbreviation ?? null,
        type_name: sp.type?.text ?? sp.scoringType?.displayName ?? null, text: sp.text ?? null,
        period: sp.period?.number ?? null, clock: sp.clock?.displayValue ?? null,
        points: Math.max(0, (a - pa) + (h - ph)), away_score: a, home_score: h });
      pa = a; ph = h;
    }
    // the drive in progress: who, where it started, plays / yards / time so far
    const d = s.drives?.current;
    if (d) {
      const abbr = String(d.team?.abbreviation ?? "");
      v._drive = { team: FIX[abbr] ?? abbr, description: d.description ?? null,          // "6 plays, 42 yards, 3:12"
        start: d.start?.text ?? null, start_yardline: d.start?.yardLine ?? null,       // "ARI 25"
        plays: d.offensivePlays ?? null, yards: d.yards ?? null };
    }
    const wp = s.winprobability ?? [];
    if (wp.length) v._homeWin = Number(wp[wp.length - 1].homeWinPercentage);
  } catch (_) { /* extras are optional */ }
  yardsCache.set(id, { at: Date.now(), v });
  return v;
}

async function load(week?: number, seasontype?: number, year?: number) {
  const key = `${week ?? "cur"}|${seasontype ?? ""}|${year ?? ""}`;
  const hit = boardCache.get(key);
  if (hit && Date.now() - hit.at < 8_000) return hit.body;   // 8 s so the 10-second page refresh sees new plays
  const qs = week ? `?week=${week}&seasontype=${seasontype ?? 2}${year ? `&year=${year}` : ""}` : "";
  const d = await espn(`/apis/site/v2/sports/football/nfl/scoreboard${qs}`);
  const games = await Promise.all((d.events ?? []).map(async (e: any) => {
    const c = e.competitions?.[0] ?? {};
    const st = c.status ?? e.status ?? {};
    const state = st.type?.state ?? "pre";                         // pre | in | post
    const team = (side: string) => {
      const t = (c.competitors ?? []).find((x: any) => x.homeAway === side) ?? {};
      const abbr = String(t.team?.abbreviation ?? "");
      return { id: t.team?.id ?? t.id ?? null, team: FIX[abbr] ?? abbr, name: t.team?.location ?? t.team?.shortDisplayName ?? abbr,
               nickname: t.team?.name ?? null, score: t.score != null && t.score !== "" ? Number(t.score) : null,
               logo: t.team?.logo ?? null, color: t.team?.color ? `#${t.team.color}` : null,
               record: t.records?.[0]?.summary ?? null, winner: !!t.winner,
               lines: (t.linescores ?? []).map((l: any) => Number(l.value ?? l.displayValue ?? 0)) };
    };
    const home = team("home"), away = team("away");
    const sit = c.situation ?? {};
    const possId = sit.possession ?? null;
    const possTeam = possId ? (possId === home.id ? home.team : possId === away.id ? away.team : null) : null;
    const yards: Record<string, any> = state === "pre" ? {} : await totalYards(e.id, state);
    const odds = c.odds?.[0] ?? {};
    const lpHome = sit.lastPlay?.probability?.homeWinPercentage;
    const homeWin = lpHome != null ? Number(lpHome) : yards._homeWin ?? null;
    return {
      espn_id: e.id, kickoff_utc: e.date, state,
      detail: st.type?.shortDetail ?? "",                            // "Q3 4:12", "Final", "Sun 8:20 PM EDT"
      completed: !!st.type?.completed,
      period: st.period ?? null, clock: st.displayClock ?? null,
      away_team: away.team, away_name: away.name, away_nickname: away.nickname, away_score: away.score, away_logo: away.logo,
      away_color: away.color, away_record: away.record, away_winner: away.winner, away_yards: yards[away.team] ?? null,
      home_team: home.team, home_name: home.name, home_nickname: home.nickname, home_score: home.score, home_logo: home.logo,
      home_color: home.color, home_record: home.record, home_winner: home.winner, home_yards: yards[home.team] ?? null,
      possession: possTeam,
      down_distance: sit.downDistanceText ?? sit.shortDownDistanceText ?? null,   // "1st & 10 at PHI 2"
      yard_line: sit.yardLine ?? null,          // 0-100 from the HOME team's goal line (ESPN convention)
      red_zone: !!sit.isRedZone,
      last_play: sit.lastPlay?.text ?? null,
      // added 2026-10-04 for the Live Scoreboard
      away_lines: away.lines, home_lines: home.lines,                 // points per quarter (OT = 5th entry)
      down_short: sit.shortDownDistanceText ?? null,                  // "4th & 1"
      ball_on: sit.possessionText ?? null,                            // "IND 48"
      away_timeouts: sit.awayTimeouts ?? null, home_timeouts: sit.homeTimeouts ?? null,
      home_win_prob: homeWin, away_win_prob: homeWin == null ? null : 1 - homeWin,   // 0-1 live odds to win
      leaders: { [away.team]: yards._leaders?.[away.team] ?? null, [home.team]: yards._leaders?.[home.team] ?? null },
      scoring_plays: yards._scoring ?? [],
      current_drive: state === "in" ? yards._drive ?? null : null,   // {team, description, start ("ARI 25"), plays, yards}      // [{team, type "TD"/"FG"/"SF"/"2PT", text, period, clock, points, away_score, home_score}]
      spread: odds.details ?? null,                                   // ESPN line, e.g. "IND -4.5"
      over_under: odds.overUnder ?? null,
      broadcast: c.broadcasts?.[0]?.names?.[0] ?? null,
      venue: c.venue?.fullName ?? null,
    };
  }));
  const body = { ok: true, fetched_at: new Date().toISOString(),
    season: d.season?.year ?? year ?? null, seasontype: d.season?.type ?? seasontype ?? 2, week: d.week?.number ?? week ?? null, games };
  boardCache.set(key, { at: Date.now(), body });
  return body;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const u = new URL(req.url);
    let b: any = {}; if (req.method === "POST") { try { b = await req.json(); } catch { /* none */ } }
    const num = (v: any) => (v == null || v === "" ? undefined : Number(v));
    // 2026-10-04: cron action - copy FINAL scores into games right away (My Bets WON/LOST badges, settling)
    if (b.action === "sync_finals") {
      const { createClient } = await import("npm:@supabase/supabase-js@2");
      const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
      const { data: cfg } = await sb.from("private_config").select("value").eq("key", "cron_token").single();
      if (!cfg || cfg.value !== req.headers.get("x-pbm-cron")) return new Response(JSON.stringify({ ok: false, error: "not authorized" }), { status: 401, headers: CORS });
      const board = await load();
      const done: string[] = [];
      for (const g of board.games ?? []) {
        if (g.state !== "post" || g.home_score == null || g.away_score == null) continue;
        const id = `${board.season}_${String(board.week).padStart(2, "0")}_${g.away_team}_${g.home_team}`;
        const { data: u } = await sb.from("games").update({ home_score: g.home_score, away_score: g.away_score })
          .eq("game_id", id).is("home_score", null).select("game_id");
        if (u?.length) done.push(id);
      }
      return new Response(JSON.stringify({ ok: true, updated: done }), { headers: { ...CORS, "Content-Type": "application/json" } });
    }
    const body = await load(num(b.week ?? u.searchParams.get("week")), num(b.seasontype ?? u.searchParams.get("seasontype")),
                            num(b.year ?? u.searchParams.get("year")));
    return new Response(JSON.stringify(body), { headers: { ...CORS, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 502, headers: { ...CORS, "Content-Type": "application/json" } });
  }
});
