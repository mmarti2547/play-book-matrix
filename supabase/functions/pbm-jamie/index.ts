// ===== SUPABASE EDGE FUNCTION: pbm-jamie =====
// Jamie's Pick: live player-stat agent. TEST ONLY - it never places bets.
// Every 2 minutes during games (every 20 minutes otherwise), run by the schedule with the cron token:
//  1) Kalshi player markets (catches, receiving / rushing / passing yards, rushing + receiving yards)
//  2) ESPN live box scores and game clocks
//  3) For every player line: his normal game (Kalshi's pre-game line, frozen at kickoff; history if none), what he has now, minutes left
//     -> projected final and the chance he finishes over / under, vs Kalshi's price -> grade
//  4) The best 3-, 4- and 5-leg parlays across ALL games: honest chances, legs that win together, never under 55%
//  5) Logs every A / A+ leg and parlay the first time it appears, and grades them when the games end
// Model settings come from the 2021-2025 test (jamie/pace_backtest.py): a fast or slow start counts, but the
// player's normal game still carries most of the weight for the rest of the game.
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-pbm-cron" };
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const KALSHI = "https://api.elections.kalshi.com/trade-api/v2";
const ESPN = ["https://site.web.api.espn.com", "https://site.api.espn.com"];
const H = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36",
            "Accept": "application/json", "Referer": "https://www.espn.com/" };

type Stat = "rec" | "rec_yds" | "rush_yds" | "pass_yds" | "rr_yds";
const SERIES: Record<string, { stat: Stat; slug: string }> = {
  KXNFLREC: { stat: "rec", slug: "pro-football-player-receptions" },
  KXNFLRECYDS: { stat: "rec_yds", slug: "pro-football-receiving-yards" },
  KXNFLRSHYDS: { stat: "rush_yds", slug: "pro-football-rushing-yards" },
  KXNFLPASSYDS: { stat: "pass_yds", slug: "pro-football-passing-yards" },
  KXNFLRRYDS: { stat: "rr_yds", slug: "pro-football-rush-and-receiving-yards" },
};
const WORD: Record<Stat, string> = { rec: "catches", rec_yds: "receiving yds", rush_yds: "rushing yds", pass_yds: "passing yds", rr_yds: "rush + rec yds" };
// minutes of "normal game" weight, and spread of the rest of the game (from the backtest)
const K: Record<Stat, number> = { rec: 90, rec_yds: 90, rush_yds: 50, pass_yds: 90, rr_yds: 70 };
const SCALE: Record<Stat, number> = { rec: 1.17, rec_yds: 4.9, rush_yds: 4.6, pass_yds: 5.9, rr_yds: 5.3 };
// 2026-10-12: first live Sunday (661 graded picks) - the model said ~76% and hit ~70%, so confidence is pulled in harder
const SHRINK = 0.75;
// Overs (YES legs) and catches were the weak spots on that Sunday: they must clear 3 extra points of edge each to earn a grade
const penalty = (stat: string, side: string) => (side === "yes" ? 0.03 : 0) + (stat === "rec" ? 0.03 : 0);
const OURS_TO_KALSHI: Record<string, string> = { JAX: "JAC", LA: "LAR" };
const ESPN_TO_OURS: Record<string, string> = { WSH: "WAS", LAR: "LA" };
const MON = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

const normName = (s: string) => String(s ?? "").toLowerCase().replace(/-/g, " ").replace(/[^a-z ]/g, "")
  .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, "").replace(/\s+/g, " ").trim();
const kteam = (t: string) => OURS_TO_KALSHI[t] ?? t;
function erf(x: number) {   // Abramowitz-Stegun 7.1.26
  const s = Math.sign(x); x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return s * y;
}
const Phi = (z: number) => 0.5 * (1 + erf(z / Math.SQRT2));
// 2026-10-26 learned from 2021-2023 play-by-play: share of a role's production still to come after t game-minutes (PROF),
// and how the score changes it (MULT, by the player's team lead). Used only where it tested better: lead 7+ and QB passing.
const ST = [10, 20, 30, 40, 45, 50, 55];
const PROF: Record<string, number[]> = {"pass_yds": [0.8535, 0.7044, 0.4924, 0.3458, 0.2633, 0.1896, 0.1093], "rush_yds": [0.8297, 0.6658, 0.5025, 0.3286, 0.2434, 0.1708, 0.0867], "rr_yds": [0.8348, 0.6737, 0.4976, 0.3283, 0.2435, 0.1714, 0.0906], "rec": [0.8485, 0.7004, 0.4882, 0.3488, 0.2691, 0.1938, 0.1122], "rec_yds": [0.854, 0.7056, 0.4961, 0.3516, 0.2696, 0.1953, 0.1122]};
const MULT: Record<string, number[]> = {"pass_yds|down14": [1.035, 1.247, 1.189, 1.302, 1.39, 1.426, 1.477], "pass_yds|down7": [1.125, 1.186, 1.155, 1.364, 1.491, 1.706, 2.0], "pass_yds|close": [1.05, 1.105, 1.077, 1.126, 1.141, 1.331, 1.584], "pass_yds|up7": [0.976, 0.944, 0.808, 0.806, 0.785, 0.658, 0.66], "pass_yds|up14": [0.781, 0.78, 0.663, 0.558, 0.463, 0.37, 0.3], "rush_yds|up7": [1.071, 1.05, 1.171, 1.321, 1.31, 1.408, 1.57], "rush_yds|up14": [1.001, 1.189, 1.161, 1.154, 1.26, 1.267, 1.178], "rr_yds|up7": [1.009, 0.974, 1.042, 1.13, 1.117, 1.147, 1.257], "rr_yds|up14": [0.891, 1.085, 1.009, 0.968, 1.016, 1.007, 0.945], "rec|up7": [0.949, 0.943, 0.764, 0.771, 0.718, 0.61, 0.573], "rec|up14": [0.767, 0.777, 0.695, 0.591, 0.533, 0.415, 0.3], "rec_yds|up7": [0.951, 0.943, 0.785, 0.792, 0.75, 0.643, 0.632], "rec_yds|up14": [0.693, 0.73, 0.672, 0.585, 0.515, 0.436, 0.3]};
const interp = (t: number, xs: number[], ys: number[]) => {
  if (t <= xs[0]) return ys[0];
  for (let i = 1; i < xs.length; i++) if (t <= xs[i]) return ys[i - 1] + (ys[i] - ys[i - 1]) * (t - xs[i - 1]) / (xs[i] - xs[i - 1]);
  return ys[ys.length - 1];
};
function scriptShare(stat: string, el: number, lead: number) {
  const even = Math.max(0, 60 - el) / 60;
  if (!(lead >= 7 || stat === "pass_yds") || !PROF[stat]) return even;
  const lb = lead >= 14 ? "up14" : lead >= 7 ? "up7" : lead <= -14 ? "down14" : lead <= -7 ? "down7" : "close";
  const share = interp(el, [0, ...ST, 60], [1, ...PROF[stat], 0]);
  const m = MULT[`${stat}|${lb}`] ? interp(el, ST, MULT[`${stat}|${lb}`]) : 1;
  return Math.max(0, share * m);
}
const r2 = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d;

async function getJson(url: string, headers: Record<string, string> = {}) {
  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error(`${new URL(url).host} ${r.status}`);
  return await r.json();
}
async function espn(path: string) {
  let last: unknown;
  for (const h of ESPN) { try { return await getJson(h + path, H); } catch (e) { last = e; } }
  throw last;
}

function etDateCode(iso: string) {
  const d = new Date(new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York" }));
  return String(d.getFullYear()).slice(2) + MON[d.getMonth()] + String(d.getDate()).padStart(2, "0");
}

// 2026-10-11: same letter scale as the rest of the site. A+ / A / B+ / B are the playable grades; C, D and F are tracked only
// (C = thin value, D = about even with Kalshi's price, F = the price is better than our chance).
// 2026-10-26 REBUILT: grades now mean "how likely it is to hit" (A+ = most likely), using the CALIBRATED chance
// (our model blended with Kalshi's price - see JAMIE_W). A leg priced above our chance is never better than D.
// Checked on 11,107 graded legs: calibrated 81% -> hit 81%, 89% -> hit 93%.
function grade(prob: number, edge: number) {
  // 2026-11-09: only legs where our model is clearly BELOW Kalshi's price are F (those hit well under the price);
  // otherwise the grade is the honest chance (Kalshi's price minus 1 pt) - a model "edge" added nothing.
  if (edge < -0.03) return "F";
  if (prob >= 0.85) return "A+";
  if (prob >= 0.78) return "A";
  if (prob >= 0.72) return "B+";
  if (prob >= 0.65) return "B";
  if (prob >= 0.55) return "C";
  return "D";
}
// parlay grade = chance ALL legs hit (calibrated); PASS if the price is worse than that chance
// 2026-11-03: stricter so the letter matches the risk (an "A" at 43-45% read as a sure thing and lost):
// A+ 65%+, A 55%+, B+ 45%+, B 35%+, else C. BET NOW still needs A/A+, so it now means "more likely to hit than miss".
function parlayGrade(prob: number, cost: number) {
  if (prob / cost < 1) return "PASS";
  return prob >= 0.65 ? "A+" : prob >= 0.55 ? "A" : prob >= 0.45 ? "B+" : prob >= 0.35 ? "B" : "C";
}

async function run(sb: any, force: boolean) {
  const now = Date.now();
  // 2026-10-26 trust in our model vs Kalshi's price for player legs (learned weekly by pbm_fit_jamie_weight; started at 0.2)
  const { data: wp } = await sb.from("model_params").select("value").eq("key", "jamie_model_weight").maybeSingle();
  const JAMIE_W = Math.min(0.6, Math.max(0.05, Number(wp?.value ?? 0.2)));
  const started = new Date().toISOString();
  // games from 5 h ago to 4 days out
  const { data: games } = await sb.from("games").select("game_id,home_team,away_team,kickoff_utc,home_score,away_score")
    .gte("kickoff_utc", new Date(now - 5 * 3600e3).toISOString()).lte("kickoff_utc", new Date(now + 4 * 86400e3).toISOString());
  const live = (games ?? []).some((g: any) => { const k = new Date(g.kickoff_utc).getTime(); return k <= now && now - k < 4.5 * 3600e3; });
  if (!force && !live && new Date().getUTCMinutes() % 20 >= 2) return { skipped: "no live games" };

  const byCode = new Map<string, any>();
  for (const g of games ?? []) byCode.set(etDateCode(g.kickoff_utc) + kteam(g.away_team) + kteam(g.home_team), g);

  // ---- ESPN: clocks + live box scores
  const clock = new Map<string, { state: string; elapsed: number; detail: string; hs?: number; as?: number }>();
  const cur = new Map<string, Record<Stat, number>>();   // game_id|player_key -> stats
  const espnTeams = new Map<string, Set<string>>();        // game_id -> player_keys seen in box score
  try {
    const sbd = await espn("/apis/site/v2/sports/football/nfl/scoreboard");
    for (const ev of sbd.events ?? []) {
      const c = ev.competitions?.[0]; if (!c) continue;
      const tm = (side: string) => { const a = String(c.competitors?.find((x: any) => x.homeAway === side)?.team?.abbreviation ?? ""); return ESPN_TO_OURS[a] ?? a; };
      const g = (games ?? []).find((x: any) => x.home_team === tm("home") && x.away_team === tm("away"));
      if (!g) continue;
      const st = c.status ?? ev.status ?? {};
      const state = st.type?.state ?? "pre";
      const period = Number(st.period ?? 0), secs = Number(st.clock ?? 0);
      const elapsed = state === "pre" ? 0 : state === "post" ? 60 : Math.min(60, period > 4 ? 60 : (period - 1) * 15 + (15 - secs / 60));
      const pts = (side: string) => Number(c.competitors?.find((x: any) => x.homeAway === side)?.score ?? 0) || 0;
      clock.set(g.game_id, { state, elapsed: Math.max(0, elapsed), detail: st.type?.shortDetail ?? "", hs: pts("home"), as: pts("away") });
      if (state === "pre") continue;
      if (state === "post" && now - new Date(g.kickoff_utc).getTime() > 6 * 3600e3) continue;
      const s = await espn(`/apis/site/v2/sports/football/nfl/summary?event=${ev.id}`);
      const seen = new Set<string>();
      for (const tp of s.boxscore?.players ?? []) {
        const team = ESPN_TO_OURS[String(tp.team?.abbreviation ?? "")] ?? String(tp.team?.abbreviation ?? "");
        for (const cat of tp.statistics ?? []) {
          const keys: string[] = cat.keys ?? [];
          for (const a of cat.athletes ?? []) {
            const pk = `${team}|${normName(a.athlete?.displayName ?? "")}`;
            const v = (k: string) => { const i = keys.indexOf(k); return i >= 0 ? Number(String(a.stats?.[i] ?? "0").replace(/,/g, "")) || 0 : 0; };
            const id = `${g.game_id}|${pk}`;
            const o = cur.get(id) ?? { rec: 0, rec_yds: 0, rush_yds: 0, pass_yds: 0, rr_yds: 0 };
            if (cat.name === "receiving") { o.rec = v("receptions"); o.rec_yds = v("receivingYards"); }
            if (cat.name === "rushing") o.rush_yds = v("rushingYards");
            if (cat.name === "passing") o.pass_yds = v("passingYards");
            o.rr_yds = o.rec_yds + o.rush_yds;
            cur.set(id, o); seen.add(pk);
          }
        }
      }
      espnTeams.set(g.game_id, seen);
      // store for grading
      const rows: any[] = [];
      for (const pk of seen) {
        const o = cur.get(`${g.game_id}|${pk}`)!;
        for (const st2 of Object.keys(o) as Stat[]) rows.push({ game_id: g.game_id, player_key: pk, stat: st2, value: o[st2], final: state === "post", updated_at: started });
      }
      for (let i = 0; i < rows.length; i += 500) await sb.from("jamie_player_stats").upsert(rows.slice(i, i + 500));
    }
  } catch (e) { console.error("espn", e); }

  // ---- baselines (players on the teams in these games)
  const teams = [...new Set((games ?? []).flatMap((g: any) => [g.home_team, g.away_team]))];
  const { data: base } = await sb.from("jamie_baselines").select("*").in("team", teams);
  const baseBy = new Map<string, any>((base ?? []).map((b: any) => [b.player_key, b]));
  const { data: priors } = await sb.from("jamie_market_prior").select("*").in("game_id", (games ?? []).map((g: any) => g.game_id));
  const priorBy = new Map<string, number>((priors ?? []).map((p: any) => [`${p.game_id}|${p.player_key}|${p.stat}`, Number(p.median)]));

  // ---- Kalshi player ladders
  type Rung = { ticker: string; strike: number; yes_ask: number; no_ask: number; yes_bid: number; no_bid: number };
  const ladders = new Map<string, { g: any; series: string; stat: Stat; name: string; rungs: Rung[]; event: string }>();
  for (const series of Object.keys(SERIES)) {
    let cursor = "";
    for (let page = 0; page < 4; page++) {
      const d = await getJson(`${KALSHI}/events?series_ticker=${series}&status=open&with_nested_markets=true&limit=200${cursor ? "&cursor=" + cursor : ""}`);
      for (const ev of d.events ?? []) {
        const code = String(ev.event_ticker).split("-")[1] ?? "";
        const g = byCode.get(code); if (!g) continue;
        for (const m of ev.markets ?? []) {
          if (!["active", "open"].includes(m.status)) continue;
          const name = String(m.yes_sub_title ?? "").split(":")[0].trim(); if (!name) continue;
          const key = `${g.game_id}|${series}|${normName(name)}`;
          const L = ladders.get(key) ?? { g, series, stat: SERIES[series].stat, name, rungs: [] as Rung[], event: String(ev.event_ticker) };
          L.rungs.push({ ticker: m.ticker, strike: Number(m.floor_strike), yes_ask: Number(m.yes_ask_dollars ?? 0), no_ask: Number(m.no_ask_dollars ?? 0),
                         yes_bid: Number(m.yes_bid_dollars ?? 0), no_bid: Number(m.no_bid_dollars ?? 0) });
          ladders.set(key, L);
        }
      }
      cursor = d.cursor; if (!cursor) break;
    }
  }

  // ---- price every ladder; keep the best rung per player and stat
  const legs: any[] = []; const newPriors: any[] = [];
  for (const L of ladders.values()) {
    const g = L.g; const nn = normName(L.name);
    const cands = [`${g.away_team}|${nn}`, `${g.home_team}|${nn}`];
    const seen = espnTeams.get(g.game_id);
    const pk = cands.find((c) => baseBy.has(c)) ?? cands.find((c) => seen?.has(c));
    if (!pk) continue;
    const b = baseBy.get(pk); const hist = b ? Number(b[`pre_${L.stat}`] ?? 0) : null;
    const ck = clock.get(g.game_id) ?? { state: new Date(g.kickoff_utc).getTime() > now ? "pre" : "in", elapsed: 0, detail: "" };
    if (ck.state === "post") continue;
    // market's middle line from the ladder (where YES crosses 50 cents)
    const rs = L.rungs.filter((r) => r.yes_ask > 0).sort((a, b2) => a.strike - b2.strike);
    let median: number | null = null;
    for (let i = 0; i < rs.length; i++) {
      const p = (rs[i].yes_ask + (rs[i].yes_bid || rs[i].yes_ask)) / 2;
      if (p <= 0.5) {
        if (i === 0) { median = rs[0].strike; break; }
        const p0 = (rs[i - 1].yes_ask + (rs[i - 1].yes_bid || rs[i - 1].yes_ask)) / 2;
        median = rs[i - 1].strike + (rs[i].strike - rs[i - 1].strike) * (p0 - 0.5) / Math.max(1e-6, p0 - p);
        break;
      }
    }
    const pkey = `${g.game_id}|${pk}|${L.stat}`;
    if (ck.state === "pre" && median != null) newPriors.push({ game_id: g.game_id, player_key: pk, stat: L.stat, median: r2(median, 2), captured_at: started });
    const mkt = ck.state === "pre" ? median : (priorBy.get(pkey) ?? null);
    // Kalshi's pre-game line knows today's role (starter, injuries); history only fills in when there is no line
    const normal = mkt ?? hist;
    if (normal == null || normal <= 0) continue;
    const now_v = cur.get(`${g.game_id}|${pk}`)?.[L.stat] ?? 0;
    const el = ck.elapsed, left = Math.max(0, 60 - el);
    const rate = (now_v + normal / 60 * K[L.stat]) / (el + K[L.stat]);
    // 2026-10-26 game script (backtest 2021-23 -> tested 2024-25, 624k lines, log loss 0.4986 -> 0.4920): when his team leads by 7+,
    // and always for QB passing yards, the rest of his production follows the score instead of an even pace.
    const team = pk.split("|")[0];
    const lead = ck.state === "in" && ck.hs != null && ck.as != null ? (team === g.home_team ? ck.hs - ck.as : ck.as - ck.hs) : 0;
    const proj = now_v + rate * 60 * (ck.state === "in" ? scriptShare(L.stat, el, lead) : left / 60);
    const rem = Math.max(0.1, proj - now_v);
    const sd = SCALE[L.stat] * Math.sqrt(rem);
    let best: any = null;
    for (const r of L.rungs) {
      if (Math.abs(r.strike - proj) > 1.5 * sd && now_v <= r.strike) continue;   // only lines near the projection
      let p = now_v > r.strike ? 1 : 1 - Phi((r.strike - proj) / sd);
      p = 0.5 + SHRINK * (p - 0.5);
      if (p > 0.985 || p < 0.015) continue;
      for (const side of ["yes", "no"]) {
        const prob = side === "yes" ? p : 1 - p;
        const price = side === "yes" ? r.yes_ask : r.no_ask;
        if (!(price >= 0.03 && price <= 0.97)) continue;
        if (prob - price > 0.20) continue;   // a gap this big means stale data or a role change - skip, don't trust it
        if (price > 0.93) continue;           // pays almost nothing
        // 2026-10-26 calibrated chance = model x JAMIE_W + Kalshi price x (1 - JAMIE_W). Picking the biggest raw "edge" picked the
        // legs where the model was most wrong (edge 10+ said 64%, hit 50% = Kalshi's 49c). Now: the most likely rung with real value.
        const cal = JAMIE_W * prob + (1 - JAMIE_W) * price;
        const edge = cal - price;
        // 2026-11-09: keep rungs where our model agrees with the price or is higher (within 3 pts below is "agree");
        // on 19,000 graded legs those all hit at the price - requiring the model to be ABOVE the price only threw away
        // the safest rungs and left too few 70%+ legs to build a 55%+ parlay.
        if (prob < price - 0.03) continue;
        if (!best || price > best.price) {
          const n = Math.round(r.strike + 0.5);
          best = { ticker: r.ticker, strike: r.strike, side, our_prob: r2(cal, 4), model_prob: r2(prob, 4), price, edge: r2(edge, 4),
                   label: side === "yes" ? `${L.name} ${n}+ ${WORD[L.stat]}` : `${L.name} under ${n} ${WORD[L.stat]}` };
        }
      }
    }
    if (!best) continue;
    // 2026-11-09 HONEST chance: on 19,000 graded legs, when our model was at or above Kalshi's price the leg hit at Kalshi's price
    // minus about 1 point (the model added nothing beyond the price). So the chance we show and grade on is the price - 1 pt.
    best.our_prob = r2(Math.max(0.02, best.price - 0.01), 4);
    legs.push({ ...best, game_id: g.game_id, matchup: `${g.away_team} @ ${g.home_team}`, player_key: pk, player_name: L.name,
      team: pk.split("|")[0], stat: L.stat, grade: ck.state === "in" ? grade(best.our_prob, best.edge) : "PASS",   // graded in-game only
      current: now_v, projected: r2(proj, 1),
      normal_game: r2(normal, 1), minutes_left: r2(left, 1), game_state: ck.state,
      kalshi_url: `https://kalshi.com/markets/${L.series.toLowerCase()}/${SERIES[L.series].slug}/${L.event.toLowerCase()}`, updated_at: started });
  }

  const priorRows = [...new Map(newPriors.map((p) => [`${p.game_id}|${p.player_key}|${p.stat}`, p])).values()];
  const errs: string[] = [];
  const chk = (r: any, what: string) => { if (r?.error) errs.push(`${what}: ${r.error.message}`); };
  // one row per ticker (Kalshi can list the same market twice across pages)
  const uniq = [...new Map(legs.map((l) => [l.ticker, l])).values()];
  for (let i = 0; i < uniq.length; i += 500) chk(await sb.from("jamie_legs").upsert(uniq.slice(i, i + 500).map(({ model_prob: _m, ...x }: any) => x)), "legs");
  if (!errs.length) chk(await sb.from("jamie_legs").delete().lt("updated_at", started), "legs cleanup");

  // 2026-10-12: ONE direction per player across every parlay. A player can have an over on one stat and an under on another
  // (e.g. under 5 catches, over 60 yards) - those work against each other, so his strongest line decides the direction
  // and every parlay (4-leg, 5-leg and Coin Toss) may only use him that way.
  // (no locking: the direction follows the game live, but every parlay built in the same update agrees)
  const playerDir = new Map<string, { side: string; score: number }>();
  for (const l of legs) {
    if (l.game_state !== "in") continue;
    const sc = l.our_prob;   // 2026-10-26 the player's most likely line decides his direction
    const cur = playerDir.get(l.player_key);
    if (!cur || sc > cur.score) playerDir.set(l.player_key, { side: l.side, score: sc });
  }
  const sameWay = (l: any) => playerDir.get(l.player_key)?.side === l.side;

  // ---- parlays: the most likely winners with real value, spread across games
  // 2026-10-12: built for ALL live games (the main board) and again for EACH live game on its own (the game picker).
  //  - legs spread evenly: at most ceil(n / games) legs from one game, so a single-game night can still fill a parlay
  //  - "relaxed": if not enough strong legs (60%+ chance, 3+ pts value) exist, fall back to 50%+ chance / 2+ pts value,
  //    and say so. The main board only relaxes when one game is on; a single-game pick always may. Auto never buys relaxed ones.
  const sc = (l: any) => l.edge;
  // 2026-10-12: stop parlays blinking on and off - a leg already in a parlay stays eligible at a slightly lower bar
  //  (5 pts less chance, 2 pts less value) until it truly fades
  const prevT = new Set<string>();
  for (const t of ["jamie_parlays", "jamie_game_parlays"]) {
    const { data: pr } = await sb.from(t).select("legs");
    for (const r of pr ?? []) for (const x of r.legs ?? []) prevT.add(`${x.ticker}:${x.side}`);
  }
  const ok = (l: any, p0: number, e0: number) => (sc(l) >= e0 && l.our_prob >= p0) || (prevT.has(`${l.ticker}:${l.side}`) && sc(l) > 0 && l.our_prob >= p0 - 0.03);
  // 2026-10-12: parlays close with 2 game-minutes left (prices jump and Kalshi quotes fail in the final minutes)
  const inPlay = legs.filter((l) => l.game_state === "in" && sameWay(l) && Number(l.minutes_left ?? 0) >= 2);
  const legOut = (l: any) => ({ ticker: l.ticker, side: l.side, label: l.label, game_id: l.game_id, matchup: l.matchup,
    player_key: l.player_key, stat: l.stat, strike: l.strike, our_prob: l.our_prob, price: l.price, grade: l.grade, kalshi_url: l.kalshi_url });
  const pickLegs = (pool: any[], n: number) => {
    const nG = new Set(pool.map((l) => l.game_id)).size;
    const perGame = Math.max(1, Math.ceil(n / Math.max(1, nG)));
    const pick: any[] = []; const players = new Set<string>(); const gcount = new Map<string, number>();
    for (const l of pool) {
      if (pick.length >= n) break;
      if (players.has(l.player_key) || (gcount.get(l.game_id) ?? 0) >= perGame) continue;
      pick.push(l); players.add(l.player_key); gcount.set(l.game_id, (gcount.get(l.game_id) ?? 0) + 1);
    }
    return pick.length === n ? { pick, games: gcount.size } : null;
  };
  // 2026-11-09 "legs that win together". Measured on every pair of graded legs from the same game (Oct 11 - Nov 8, 70 games):
  // how often both hit vs their honest chances multiplied. Only HALF of each measured boost is used, to stay on the safe side.
  //   unders on opposite teams + a QB passing under 1.19 -> 1.09 | unders on opposite teams 1.057 -> 1.03
  //   unders same team 1.037 / over+under same team 1.039 -> 1.02 | over+under opposite teams 1.021 -> 1.01
  //   overs on opposite teams 0.959 and a QB vs his own pass-catcher in opposite directions 0.839 -> never paired.
  // Legs from different games are treated as unrelated (factor 1).
  const MIN_PARLAY = 0.55;   // Michael 2026-11-09: never show a parlay under a 55% chance to win
  const pairF = (a: any, b: any): number | null => {
    if (a.game_id !== b.game_id) return 1;
    const sameTeam = a.team === b.team, hasQB = a.stat === "pass_yds" || b.stat === "pass_yds";
    if (sameTeam && hasQB && a.side !== b.side) return null;
    if (a.side === "no" && b.side === "no") return !sameTeam ? (hasQB ? 1.09 : 1.03) : 1.02;
    if (a.side === "yes" && b.side === "yes") return sameTeam ? 1 : null;
    return sameTeam ? 1.02 : 1.01;
  };
  const jointProb = (pick: any[]): number | null => {
    let p = pick.reduce((x, l) => x * l.our_prob, 1);
    const perGame = new Map<string, number>();
    for (const l of pick) perGame.set(l.game_id, (perGame.get(l.game_id) ?? 0) + 1);
    for (let i = 0; i < pick.length; i++) for (let j = i + 1; j < pick.length; j++) {
      const f = pairF(pick[i], pick[j]);
      if (f == null) return null;
      if (f !== 1) p *= f ** (1 / Math.max(1, (perGame.get(pick[i].game_id) ?? 2) - 1));   // don't double-count a game's boost
    }
    return Math.min(0.97, p);
  };
  const toPar = (kind: string, n: number, r: { pick: any[]; games: number; prob: number }, relaxed: boolean) => {
    const cost = r.pick.reduce((p, l) => p * l.price, 1);
    return { kind, n_legs: n, legs: r.pick.map(legOut), our_prob: r2(r.prob, 4), cost: r2(cost, 4), payout_multiple: r2(1 / cost, 1),
      grade: r.prob >= 0.65 ? "A+" : "A", games: r.games, relaxed, updated_at: started };
  };
  // best n-leg set (highest real chance that ALL hit) from the strongest candidates; null if none reaches 55%
  const bestCombo = (pool: any[], n: number) => {
    const c = pool.slice(0, n >= 5 ? 18 : n === 4 ? 24 : 30);
    let best: { pick: any[]; prob: number } | null = null;
    const pick: any[] = [];
    const rec = (start: number) => {
      if (pick.length === n) {
        const p = jointProb(pick);
        if (p != null && p >= MIN_PARLAY && (!best || p > best.prob)) best = { pick: [...pick], prob: p };
        return;
      }
      for (let i = start; i < c.length; i++) {
        if (pick.some((x) => x.player_key === c[i].player_key)) continue;
        // prune: even with the biggest boost this branch can't beat the best found
        const ub = [...pick, c[i]].reduce((x, l) => x * l.our_prob, 1) * (c[i + 1]?.our_prob ?? 0) ** (n - pick.length - 1) * 1.3;
        if (best && ub < best.prob) continue;
        pick.push(c[i]); rec(i + 1); pick.pop();
      }
    };
    rec(0);
    if (!best) return null;
    const b = best as { pick: any[]; prob: number };
    return { pick: b.pick, prob: b.prob, games: new Set(b.pick.map((l) => l.game_id)).size };
  };
  const buildSet = (cands: any[], _mayRelax: boolean) => {
    const out: any[] = [];
    // no player in two cards (one bad leg used to sink 2-3 parlays at once); 3-leg first, then 4 and 5 from what's left
    const used = new Set<string>();
    const pool = cands.filter((l) => l.our_prob >= 0.70).sort((a, b) => b.our_prob - a.our_prob);
    for (const n of [3, 4, 5]) {
      const r = bestCombo(pool.filter((l) => !used.has(l.player_key)), n);
      if (r) { out.push(toPar("safe", n, r, false)); for (const l of r.pick) used.add(l.player_key); }
    }
    // Big Coin Flip retired 2026-11-09: it never reaches a 55% chance (it hit 9 of 202).
    return out;
  };
  const liveGames = [...new Set(inPlay.map((l) => l.game_id))];
  const parlays: any[] = buildSet(inPlay, liveGames.length === 1);
  const gameParlays: any[] = [];
  for (const gid of liveGames) for (const p of buildSet(inPlay.filter((l) => l.game_id === gid), true)) gameParlays.push({ game_id: gid, ...p });
  if (gameParlays.length) chk(await sb.from("jamie_game_parlays").upsert(gameParlays, { onConflict: "game_id,kind,n_legs" }), "game parlays");
  if (!errs.length) chk(await sb.from("jamie_game_parlays").delete().lt("updated_at", started), "game parlays cleanup");
  if (parlays.length) chk(await sb.from("jamie_parlays").upsert(parlays, { onConflict: "kind,n_legs" }), "parlays");
  if (!errs.length) chk(await sb.from("jamie_parlays").delete().lt("updated_at", started), "parlays cleanup");
  for (let i = 0; i < priorRows.length; i += 500) chk(await sb.from("jamie_market_prior").upsert(priorRows.slice(i, i + 500)), "priors");

  // ---- record keeping: first appearance of every A / A+ leg and parlay
  // 2026-10-11: every graded in-game pick (A+ through F) goes on the record strip
  const logLegs = uniq.filter((l) => l.grade !== "PASS").map((l) => ({ ticker: l.ticker, side: l.side, game_id: l.game_id,
    player_key: l.player_key, player_name: l.player_name, stat: l.stat, strike: l.strike, label: l.label, our_prob: l.our_prob, price: l.price,
    edge: l.edge, grade: l.grade, game_state: l.game_state, minutes_left: l.minutes_left, model_prob: l.model_prob ?? null }));
  if (logLegs.length) chk(await sb.from("jamie_leg_log").upsert(logLegs, { onConflict: "ticker,side", ignoreDuplicates: true }), "leg log");
  // 2026-10-11: every lettered parlay (A+, A, B) goes on the parlay scorecard
  const logPar = parlays.filter((p) => ["A+", "A", "B+", "B"].includes(p.grade)).map((p) => ({
    leg_key: p.legs.map((l: any) => `${l.ticker}:${l.side}`).sort().join(","), kind: p.kind, n_legs: p.n_legs, legs: p.legs, our_prob: p.our_prob, cost: p.cost, grade: p.grade }));
  // 2026-10-12: count each parlay type at most once an hour, so near-identical boards don't pad the record
  const { data: recentPar } = await sb.from("jamie_parlay_log").select("kind,n_legs").gte("logged_at", new Date(Date.now() - 3600e3).toISOString());
  const recentKeys = new Set((recentPar ?? []).map((r: any) => `${r.kind}|${r.n_legs}`));
  const logParHourly = logPar.filter((p: any) => !recentKeys.has(`${p.kind}|${p.n_legs}`));
  if (logParHourly.length) chk(await sb.from("jamie_parlay_log").upsert(logParHourly, { onConflict: "leg_key", ignoreDuplicates: true }), "parlay log");

  return { live, ladders: ladders.size, legs: legs.length, graded: legs.filter((l) => l.grade !== "PASS").length,
           parlays: parlays.map((p) => `${p.kind} ${p.n_legs} legs ${p.grade}${p.relaxed ? " (relaxed)" : ""} ${Math.round(p.our_prob * 100)}% for ${Math.round(p.cost * 100)}c`),
           game_parlays: gameParlays.length,
           priors_saved: priorRows.length, logged_legs: logLegs.length, errors: errs };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const tok = req.headers.get("x-pbm-cron");
  const { data: cfg } = await sb.from("private_config").select("value").eq("key", "cron_token").single();
  if (!tok || !cfg || cfg.value !== tok) return json({ ok: false, error: "not authorized" }, 401);
  let body: any = {}; try { body = await req.json(); } catch { /* empty */ }
  try { return json({ ok: true, ...(await run(sb, body.force === true)) }); }
  catch (e) { return json({ ok: false, error: String(e instanceof Error ? e.message : e) }, 500); }
});
