// ===== SUPABASE EDGE FUNCTION: pbm-qb-check =====
// 2026-10-27 Starting-QB check (read-only data job, never bets).
// For every upcoming game: is each team's REGULAR starting QB actually QB1 on ESPN's depth chart?
// If not (or he is listed Out / Doubtful / IR / Suspended), store the measured cost for the system formula.
// Measured on 2021-2026 games (team ratings + opponent adjusted, QB quality = this + last season EPA per dropback):
//   elite (>= .15) starter out: -5.3 pts   good (.05-.15): -4.8   weak (< .05): -1.9   -> used: -5.5 / -5 / -2
import { createClient } from "npm:@supabase/supabase-js@2";

const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } });
const NFLVERSE = "https://github.com/nflverse/nflverse-data/releases/download/stats_player/stats_player_week_";
// ESPN blocks bare server requests: send browser headers and try both hosts (same as pbm-jamie)
const ESPN_HOSTS = ["https://site.web.api.espn.com", "https://site.api.espn.com"];
const H = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36",
            "Accept": "application/json", "Referer": "https://www.espn.com/" };
async function espnJson(path: string) {
  let last: unknown;
  for (const h of ESPN_HOSTS) {
    try { const r = await fetch(`${h}/apis/site/v2/sports/football/nfl${path}`, { headers: H });
      const t = await r.text(); if (!r.ok || t.trimStart().startsWith("<")) throw new Error(`${h} ${r.status}`); return JSON.parse(t); }
    catch (e) { last = e; }
  }
  throw last;
}
// ESPN team ids (fixed) keyed by our team codes
const ESPN_ID: Record<string, number> = { ARI: 22, ATL: 1, BAL: 33, BUF: 2, CAR: 29, CHI: 3, CIN: 4, CLE: 5, DAL: 6, DEN: 7, DET: 8, GB: 9,
  HOU: 34, IND: 11, JAX: 30, KC: 12, LV: 13, LAC: 24, LA: 14, MIA: 15, MIN: 16, NE: 17, NO: 18, NYG: 19, NYJ: 20, PHI: 21, PIT: 23,
  SF: 25, SEA: 26, TB: 27, TEN: 10, WAS: 28 };
const PTS: Record<string, number> = { elite: -5.5, good: -5, weak: -2 };
const OUT_STATUS = /^(out|doubtful|injured reserve|ir|suspension|suspended|pup|physically unable to perform)/i;
const norm = (s: string) => String(s ?? "").toLowerCase().replace(/[^a-z ]/g, "").replace(/\b(jr|sr|ii|iii|iv)\b/g, "").replace(/\s+/g, " ").trim();
const tierOf = (e: number | null) => e == null ? "weak" : e >= 0.15 ? "elite" : e >= 0.05 ? "good" : "weak";

// Keeps only QB rows and the 8 columns we use (the full file has every player and 100+ columns).
const KEEP = ["player_id", "player_display_name", "position", "week", "season_type", "team", "attempts", "sacks_suffered", "passing_epa"];
function parseCsv(text: string) {
  const split = (l: string) => { const out: string[] = []; let cur = "", q = false;
    for (let i = 0; i < l.length; i++) { const c = l[i];
      if (q) { if (c === '"' && l[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
      else if (c === '"') q = true; else if (c === ",") { out.push(cur); cur = ""; } else cur += c; }
    out.push(cur); return out; };
  let start = 0, nl = text.indexOf("\n");
  const head = split(text.slice(0, nl).replace(/\r$/, ""));
  const idx = KEEP.map((k) => head.indexOf(k));
  const out: Record<string, string>[] = [];
  start = nl + 1;
  while (start < text.length) {
    nl = text.indexOf("\n", start); if (nl < 0) nl = text.length;
    const l = text.slice(start, nl); start = nl + 1;
    if (!l.includes(",QB,")) continue;
    const v = split(l.replace(/\r$/, ""));
    if (v[idx[2]] !== "QB") continue;
    const o: Record<string, string> = {}; KEEP.forEach((k, j) => o[k] = v[idx[j]] ?? ""); out.push(o);
  }
  return out;
}

async function refreshRegulars(sb: any, season: number) {
  const get = async (y: number) => { const r = await fetch(NFLVERSE + y + ".csv"); if (!r.ok) throw new Error(`nflverse ${y} ${r.status}`); return parseCsv(await r.text()); };
  const cur = (await get(season)).filter((r) => r.season_type === "REG");
  let prev: Record<string, string>[] = [];
  try { prev = (await get(season - 1)).filter((r) => r.season_type === "REG"); } catch { /* last season optional */ }
  // starter of each team-week = most pass attempts
  const best = new Map<string, Record<string, string>>();
  for (const r of cur) { const a = Number(r.attempts || 0); if (!(a > 0)) continue;
    const k = `${r.team}|${r.week}`; const b = best.get(k); if (!b || a > Number(b.attempts || 0)) best.set(k, r); }
  const starts = new Map<string, Map<string, { n: number; name: string }>>();
  for (const r of best.values()) { const m = starts.get(r.team) ?? new Map(); const x = m.get(r.player_id) ?? { n: 0, name: r.player_display_name }; x.n++; m.set(r.player_id, x); starts.set(r.team, m); }
  const tot = (rows: Record<string, string>[], pid: string) => rows.filter((r) => r.player_id === pid)
    .reduce((s, r) => ({ db: s.db + Number(r.attempts || 0) + Number(r.sacks_suffered || 0), epa: s.epa + Number(r.passing_epa || 0) }), { db: 0, epa: 0 });
  const out: any[] = [];
  for (const [team, m] of starts) {
    const [pid, x] = [...m.entries()].sort((a, b) => b[1].n - a[1].n)[0];
    const a = tot(cur, pid), b = tot(prev, pid); const db = a.db + b.db;
    const e = db >= 100 ? (a.epa + b.epa) / db : (a.db > 0 ? a.epa / a.db : null);
    out.push({ season, team, player_id: pid, player_name: x.name, starts: x.n, dropbacks: Math.round(db), epa_db: e == null ? null : Math.round(e * 1000) / 1000, tier: tierOf(e), updated_at: new Date().toISOString() });
  }
  if (out.length) { const { error } = await sb.from("qb_regular").upsert(out); if (error) throw error; }
  return out.length;
}

async function run(sb: any, force: boolean, extraIds: string[]) {
  const now = Date.now();
  const { data: up } = await sb.from("games").select("game_id,season,home_team,away_team,kickoff_utc")
    .is("home_score", null).gte("kickoff_utc", new Date(now - 4 * 3600e3).toISOString()).lte("kickoff_utc", new Date(now + 8 * 86400e3).toISOString());
  // extra game ids (e.g. to re-check a game that just finished)
  const { data: ex } = extraIds.length ? await sb.from("games").select("game_id,season,home_team,away_team,kickoff_utc").in("game_id", extraIds) : { data: [] };
  const games = [...(up ?? []), ...(ex ?? [])];
  if (!games?.length) return { games: 0 };
  const season = Number(games[0].season);
  const { data: reg0 } = await sb.from("qb_regular").select("updated_at").eq("season", season).order("updated_at", { ascending: true }).limit(1);
  let refreshed = 0;
  if (force || !reg0?.length || now - new Date(reg0[0].updated_at).getTime() > 12 * 3600e3) refreshed = await refreshRegulars(sb, season);
  const { data: regs } = await sb.from("qb_regular").select("*").eq("season", season);
  const regBy = new Map<string, any>((regs ?? []).map((r: any) => [r.team, r]));
  const teams = [...new Set(games.flatMap((g: any) => [g.home_team, g.away_team]))] as string[];
  const qb1 = new Map<string, { name: string; injury: string }>();
  for (const t of teams) {
    const id = ESPN_ID[t]; if (!id) continue;
    try {
      const dj = await espnJson(`/teams/${id}/depthcharts`);
      for (const dc of dj?.depthchart ?? []) {
        const a = dc?.positions?.qb?.athletes?.[0];
        if (a) { const inj = (a.injuries ?? [])[0]; qb1.set(t, { name: String(a.displayName ?? a.fullName ?? ""), injury: String(inj?.status ?? inj?.type?.description ?? "") }); break; }
      }
    } catch (e) { console.error("depth", t, e); }
  }
  const rows: any[] = [];
  for (const g of games) for (const t of [g.home_team, g.away_team]) {
    const r = regBy.get(t), q = qb1.get(t);
    if (!r || !q) { rows.push({ game_id: g.game_id, team: t, regular_qb: r?.player_name ?? null, regular_starts: r?.starts ?? null, tier: r?.tier ?? null, depth_qb1: q?.name ?? null, qb1_injury: q?.injury ?? null, starter_out: false, pts: 0, detail: !r ? "no regular starter yet" : "no ESPN depth chart", checked_at: new Date().toISOString() }); continue; }
    const notQb1 = norm(q.name) !== norm(r.player_name);
    const hurt = !notQb1 && OUT_STATUS.test(q.injury);
    const out = Number(r.starts) >= 3 && (notQb1 || hurt);
    rows.push({ game_id: g.game_id, team: t, regular_qb: r.player_name, regular_starts: r.starts, tier: r.tier, depth_qb1: q.name, qb1_injury: q.injury || null,
      starter_out: out, pts: out ? PTS[r.tier] ?? -2 : 0,
      detail: out ? (notQb1 ? `${r.player_name} not QB1 (QB1: ${q.name})` : `${r.player_name} listed ${q.injury}`) : "regular starter is QB1", checked_at: new Date().toISOString() });
  }
  const { error } = await sb.from("qb_status").upsert(rows);
  if (error) throw error;
  return { games: games.length, refreshed_regulars: refreshed, starters_out: rows.filter((r) => r.starter_out).map((r) => `${r.team}: ${r.detail} (${r.tier}, ${r.pts})`) };
}

Deno.serve(async (req) => {
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const tok = req.headers.get("x-pbm-cron");
  const { data: cfg } = await sb.from("private_config").select("value").eq("key", "cron_token").single();
  if (!tok || !cfg || cfg.value !== tok) return json({ ok: false, error: "not authorized" }, 401);
  let body: any = {}; try { body = await req.json(); } catch { /* empty */ }
  try { return json({ ok: true, ...(await run(sb, body.force === true, Array.isArray(body.game_ids) ? body.game_ids.map(String).slice(0, 20) : [])) }); }
  catch (e) { return json({ ok: false, error: String(e instanceof Error ? e.message : e) }, 500); }
});
