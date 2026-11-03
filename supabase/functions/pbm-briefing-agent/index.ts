// ===== SUPABASE EDGE FUNCTION: pbm-briefing-agent =====
// "After the Fact Briefing": after a week is played, analyse the user's betting (what was bet, how much, on which
// grades/scores) against everything the app recommended, compute what-if strategies, and have Claude write a report.
// Reports are stored per user + season + week in bet_briefings (history kept; regenerating replaces that week's report).
import { createClient } from "npm:@supabase/supabase-js@2";

// ---- Agent cost tracking (estimates; rates can be changed with secrets PBM_PRICE_IN / PBM_PRICE_OUT per 1M tokens, PBM_PRICE_SEARCH per search) ----
async function logUsage(agent: string, res: any, ref: string | null = null) {
  try {
    const u = res?.usage ?? {};
    const inTok = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
    const outTok = u.output_tokens ?? 0;
    const searches = u.server_tool_use?.web_search_requests ?? 0;
    const pin = Number(Deno.env.get("PBM_PRICE_IN") ?? "3"), pout = Number(Deno.env.get("PBM_PRICE_OUT") ?? "15");
    const psearch = Number(Deno.env.get("PBM_PRICE_SEARCH") ?? "0.01");
    const cost = (inTok / 1e6) * pin + (outTok / 1e6) * pout + searches * psearch;
    const { createClient: cc } = await import("npm:@supabase/supabase-js@2");
    const s = cc(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    await s.from("agent_usage").insert({ agent, ref, model: res?.model ?? null, input_tokens: inTok, output_tokens: outTok,
      web_searches: searches, cost_usd: Math.round(cost * 10000) / 10000 });
  } catch (_) { /* never let cost logging break an agent */ }
}

const MODEL = Deno.env.get("PBM_AGENT_MODEL") ?? "claude-sonnet-5";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-pbm-cron",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });
declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };
const r2 = (x: number) => Math.round(x * 100) / 100;
const GRADES = ["A+", "A", "B+", "B", "C", "D", "F", "PASS"];
// Typical Kalshi payout on a ~50/50 spread contract after fees: win returns ~0.92x the stake as profit.
const WIN_MULT = 0.92;

async function buildStats(sb: any, userId: string, season: number, week: number) {
  const { data: games } = await sb.from("games").select("game_id,home_team,away_team,kickoff_utc,home_score,away_score")
    .eq("season", season).eq("week", week);
  const gameIds = new Set((games ?? []).map((g: any) => g.game_id));
  const gameById: Record<string, any> = Object.fromEntries((games ?? []).map((g: any) => [g.game_id, g]));

  const { data: hist } = await sb.from("my_bet_history").select("*").eq("user_id", userId);
  // 2026-10-05: who placed each bet (you vs. the Auto Trader) and parlay legs come from my_bets (the history view has neither)
  const { data: raw } = await sb.from("my_bets").select("id,origin,legs").eq("user_id", userId);
  const rawById: Record<string, any> = Object.fromEntries((raw ?? []).map((r: any) => [String(r.id), r]));
  const allBets = (hist ?? []).map((b: any) => ({ ...b, origin: rawById[String(b.id)]?.origin ?? null, legs: b.legs ?? rawById[String(b.id)]?.legs ?? null }));
  const bets = (allBets ?? []).filter((b: any) => {
    if (b.game_id) return gameIds.has(b.game_id);
    const legs = Array.isArray(b.legs) ? b.legs : [];
    return legs.some((l: any) => gameIds.has(l.game_id));
  }).filter((b: any) => b.result !== "void");

  const { data: sheet } = await sb.from("sheet_results").select("game_id,home_team,away_team,ats_pick,rating,bet_score,risk_rating,units,ats_result,week_rank")
    .eq("season", season).eq("week", week);
  const sheetByGame: Record<string, any> = Object.fromEntries((sheet ?? []).map((s: any) => [s.game_id, s]));
  const { data: alts } = await sb.from("alt_record").select("ticker,bet_label,grade,alt_score,our_prob,yes_ask,result,profit_per_contract")
    .eq("season", season).eq("week", week);
  const altByTicker: Record<string, any> = Object.fromEntries((alts ?? []).map((a: any) => [a.ticker, a]));
  const { data: parlays } = await sb.from("parlay_record").select("tickers,legs,our_prob,kalshi_prob,parlay_score,result")
    .eq("season", season).eq("week", week);

  // --- the user's bets, enriched with the app's grade/score at the time ---
  const mine = bets.map((b: any) => {
    const s = b.game_id ? sheetByGame[b.game_id] : null;
    const a = b.ticker ? altByTicker[b.ticker] : null;
    const grade = b.grade ?? (b.market === "alt_spread" ? a?.grade : b.market === "spread" ? s?.rating : null) ?? null;
    const score = b.market === "alt_spread" ? a?.alt_score ?? null : b.market === "spread" ? s?.bet_score ?? null : null;
    const g = b.game_id ? gameById[b.game_id] : null;
    const cutoff = g ? new Date(new Date(g.kickoff_utc).getTime() - 15 * 60e3) : null;
    const inactives = g ? new Date(new Date(g.kickoff_utc).getTime() - 90 * 60e3) : null;
    return {
      pick: b.pick, placed_by: b.origin === "auto" ? "Auto Trader" : "you", market: b.market, stake: Number(b.stake), result: b.result ?? "open", payout: b.payout == null ? null : Number(b.payout),
      profit: b.profit == null ? null : Number(b.profit), grade, score, odds: b.odds,
      placed_et: new Date(b.placed_at).toLocaleString("en-US", { timeZone: "America/New_York" }),
      placed_before_inactives: inactives ? new Date(b.placed_at) < inactives : null,
      placed_after_cutoff: cutoff ? new Date(b.placed_at) > cutoff : null,
      game: g ? `${g.away_team} @ ${g.home_team}` : (Array.isArray(b.legs) ? b.legs.map((l: any) => l.label).join(" + ") : null),
      legs: b.legs ?? null, game_id: b.game_id ?? null,
    };
  });
  const settled = mine.filter((m: any) => ["win", "loss", "push"].includes(m.result));
  const sum = (arr: any[], f: (x: any) => number) => arr.reduce((t, x) => t + (f(x) || 0), 0);
  const staked = sum(mine, (m) => m.stake);
  const settledStake = sum(settled, (m) => m.stake);
  const profit = sum(settled, (m) => m.profit);

  const group = (key: (m: any) => string) => {
    const out: Record<string, any> = {};
    for (const m of mine) {
      const k = key(m) ?? "unknown";
      out[k] ??= { bets: 0, staked: 0, wins: 0, losses: 0, pushes: 0, open: 0, profit: 0 };
      const o = out[k];
      o.bets++; o.staked = r2(o.staked + m.stake);
      if (m.result === "win") o.wins++; else if (m.result === "loss") o.losses++; else if (m.result === "push") o.pushes++; else o.open++;
      if (m.profit != null) o.profit = r2(o.profit + m.profit);
    }
    return out;
  };

  // --- exposure / correlation ---
  const perGame: Record<string, number> = {};
  for (const m of mine) {
    const ids = new Set<string>(m.legs ? m.legs.map((l: any) => l.game_id).filter(Boolean) : m.game_id ? [m.game_id] : []);
    for (const id of ids) { const g = gameById[id]; if (g) { const k = `${g.away_team} @ ${g.home_team}`; perGame[k] = r2((perGame[k] ?? 0) + m.stake); } }
  }
  const legCount: Record<string, number> = {};
  for (const m of mine.filter((x: any) => x.market === "parlay" && x.legs)) for (const l of m.legs) legCount[l.label] = (legCount[l.label] ?? 0) + 1;
  const sharedLegs = Object.entries(legCount).filter(([, n]) => n > 1).map(([leg, n]) => ({ leg, parlays: n }));
  // Did the app itself suggest these parlays? (so overlap is the app's fault, not the user's)
  const appKeys = new Set((parlays ?? []).map((p: any) => [...(p.tickers ?? [])].sort().join("|")));
  const placedParlays = mine.filter((x: any) => x.market === "parlay" && x.legs);
  const fromApp = placedParlays.filter((m: any) => appKeys.has(m.legs.map((l: any) => l.ticker).sort().join("|")));
  const parlaySource = { placed: placedParlays.length, matched_app_suggestion: fromApp.length,
    placed_by_auto_trader: mine.filter((x: any) => x.market === "parlay" && x.placed_by === "Auto Trader").length,
    placed_by_you: mine.filter((x: any) => x.market === "parlay" && x.placed_by === "you").length,
    note: fromApp.length ? "These parlays were the app's own top suggestions. Shared legs among them come from the app's parlay builder, which has since been changed to spread its top 3 across different games." : null };

  // --- what the app recommended, and how it did (whether or not the user bet it) ---
  const recs = (sheet ?? []).filter((s: any) => s.rating && !["PASS", "F", "D"].includes(s.rating));
  const betGames = new Set(bets.filter((b: any) => b.market === "spread").map((b: any) => b.game_id));
  const missed = recs.filter((s: any) => !betGames.has(s.game_id)).map((s: any) => ({
    game: `${s.away_team} @ ${s.home_team}`, pick: s.ats_pick, grade: s.rating, score: s.bet_score, units: s.units, result: s.ats_result ? String(s.ats_result).toLowerCase() : "pending",
  }));

  // --- what-if strategies on the app's graded spread picks (settled only), sized from the user's own average bet ---
  const avgStake = mine.length ? staked / mine.length : 5;
  const res = (x: any) => String(x ?? "").toLowerCase();
  const graded = (sheet ?? []).filter((s: any) => ["win", "loss", "push"].includes(res(s.ats_result)));
  const isWin = (s: any) => res(s.ats_result) === "win", isLoss = (s: any) => res(s.ats_result) === "loss";
  const strat = (filter: (s: any) => boolean, size: (s: any) => number, name: string) => {
    const rows = graded.filter(filter);
    let st = 0, pr = 0, w = 0, l = 0;
    for (const s of rows) { const amt = size(s); st += amt; if (isWin(s)) { pr += amt * WIN_MULT; w++; } else if (isLoss(s)) { pr -= amt; l++; } }
    return { strategy: name, bets: rows.length, wins: w, losses: l, staked: r2(st), profit: r2(pr), roi_pct: st ? r2(100 * pr / st) : null };
  };
  const whatIf = [
    strat((s) => ["A+", "A"].includes(s.rating), () => avgStake, `Flat $${r2(avgStake)} on every A/A+ pick`),
    strat((s) => ["A+", "A", "B+", "B"].includes(s.rating), () => avgStake, `Flat $${r2(avgStake)} on every A-B pick`),
    strat((s) => Number(s.units) > 0, (s) => avgStake * Number(s.units), `$${r2(avgStake)} x the app's suggested units`),
    strat((s) => (s.week_rank ?? 99) <= 5, () => avgStake, `Flat $${r2(avgStake)} on the top 5 ranked picks`),
  ];
  const altWhatIf = (() => {
    const rows = (alts ?? []).filter((a: any) => ["A+", "A"].includes(a.grade) && ["win", "loss"].includes(String(a.result ?? "").toLowerCase()));
    let st = 0, pr = 0;
    for (const a of rows) { const price = Number(a.yes_ask) || 0.5; const n = avgStake / price; st += avgStake; pr += Number(a.profit_per_contract ?? 0) * n; }
    return { strategy: `Flat $${r2(avgStake)} on every A/A+ alt line`, bets: rows.length, staked: r2(st), profit: r2(pr), roi_pct: st ? r2(100 * pr / st) : null };
  })();

  return {
    season, week, generated_et: new Date().toLocaleString("en-US", { timeZone: "America/New_York" }),
    games_total: (games ?? []).length, games_final: (games ?? []).filter((g: any) => g.home_score != null).length,
    totals: { bets: mine.length, staked: r2(staked), settled_stake: r2(settledStake), profit: r2(profit),
      roi_pct: settledStake ? r2(100 * profit / settledStake) : null, open_bets: mine.filter((m: any) => m.result === "open").length,
      avg_stake: r2(avgStake), largest_stake: r2(Math.max(0, ...mine.map((m: any) => m.stake))) },
    by_grade: group((m) => m.grade ?? "ungraded"), by_market: group((m) => m.market),
    exposure_by_game: perGame, shared_parlay_legs: sharedLegs, parlay_source: parlaySource,
    timing: { before_inactives: mine.filter((m: any) => m.placed_before_inactives).length, after_cutoff: mine.filter((m: any) => m.placed_after_cutoff).length },
    my_bets: mine, missed_recommendations: missed, what_if: [...whatIf, altWhatIf],
    app_parlays_this_week: (parlays ?? []).map((p: any) => ({ our_prob: p.our_prob, kalshi_prob: p.kalshi_prob, score: p.parlay_score, result: p.result })),
  };
}

const SYSTEM = `You are the Play Book Matrix betting coach. You write an "After the Fact Briefing" for one NFL week:
an honest, specific review of how the user bet, compared with what the app's model recommended, so they can make
better decisions next week. You are given computed facts only - never invent numbers; quote the ones provided.
Cover: (1) the result in one line; (2) what went right; (3) where they could have been more efficient -
bet selection vs. grade/score (e.g. money on low grades while A picks were skipped), bet SIZE vs. grade and
suggested units (flat vs. scaled), concentration (too much on one game, parlays sharing the same legs = one bet
repeated - but check parlay_source: if the overlapping parlays were the app's own suggested bundle, say the app
created that overlap, do NOT lower the user's grade for it, and list it in "could_be_better" as a system note rather than
a user mistake), WHO placed each bet: every bet has placed_by ("Auto Trader" = the app chose and placed it automatically
within the user's settings; "you" = the user placed it). Never say the user built or chose an Auto Trader bet, and never
lower the user's grade for an Auto Trader decision - report those as system notes about the Auto Trader's rules. Parlays vs. singles, and timing (bets placed before inactives or after the cut-off); (4) the what-if
table explained in plain words - which simple strategy would have returned the most THIS week and whether that is
luck or signal (one week is a tiny sample; say so); (5) 3-5 concrete rules for next week; (6) a SUGGESTED BETTING PROFILE for next week built from this
week's lessons and the user's own typical stake (avg_stake): a weekly budget, a unit size, how many units per grade
(A+/A/B+/B; C and below = no bet), a max per game, how many parlays (0-2) and how much on them, which bet types to
focus on, and timing rules (bet only after "Agent analysis complete", before the cut-off). Keep the weekly budget at or
below what they risked this week unless they clearly under-bet strong grades.
Tone: plain English, direct, no jargon, no hype. Never encourage chasing losses or raising stakes to recover them;
recommend a fixed bankroll and sizing by grade/units. If bets are still open, label conclusions as preliminary.
Return ONLY one JSON object:
{"headline":"one sentence","grade":"A-F letter for the user's betting discipline this week","summary":"2-3 sentences",
 "went_right":["..."],"could_be_better":[{"title":"","detail":"","impact_usd":null}],
 "what_if_explained":"paragraph","rules_for_next_week":["..."],"preliminary":true|false,
 "next_week_profile":{"weekly_budget_usd":0,"unit_usd":0,"units_by_grade":{"A+":0,"A":0,"B+":0,"B":0,"C":0},
   "max_per_game_usd":0,"parlays":{"max_count":0,"usd_each":0,"rule":""},"focus":["..."],"timing":["..."],
   "why":"2-3 sentences tying this profile to this week's results"}}`;

async function claude(stats: any) {
  const messages: any[] = [{ role: "user", content: "Week data (JSON):\n" + JSON.stringify(stats) }];
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": Deno.env.get("ANTHROPIC_API_KEY")!, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, max_tokens: 6000, system: SYSTEM, messages }),
    });
    if (!r.ok) throw new Error(`Anthropic ${r.status}: ${(await r.text()).slice(0, 300)}`);
    const res = await r.json();
    await logUsage("briefing", res);
    const text = (res.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
    const a = text.indexOf("{"), b = text.lastIndexOf("}");
    try {
      if (a < 0 || b < 0) throw new Error("no JSON object found");
      return JSON.parse(text.slice(a, b + 1));
    } catch (e) {
      // Ask the model to repair its own output (usually an unescaped quote inside a string).
      messages.push({ role: "assistant", content: text || "(empty)" });
      messages.push({ role: "user", content: `That was not valid JSON (${String(e instanceof Error ? e.message : e)}). Return the same report again as ONE valid JSON object only - escape any double quotes inside strings, no trailing commas, no text outside the object.` });
    }
  }
  throw new Error("Briefing agent returned invalid JSON three times");
}

async function generate(sb: any, userId: string, season: number, week: number) {
  await sb.from("bet_briefings").upsert({ user_id: userId, season, week, status: "generating", updated_at: new Date().toISOString() },
    { onConflict: "user_id,season,week" });
  try {
    const stats = await buildStats(sb, userId, season, week);
    if (!stats.totals.bets) {
      await sb.from("bet_briefings").upsert({ user_id: userId, season, week, status: "no_bets", stats, report: null,
        updated_at: new Date().toISOString() }, { onConflict: "user_id,season,week" });
      return;
    }
    const report = await claude(stats);
    const final = stats.games_final === stats.games_total && stats.totals.open_bets === 0;
    await sb.from("bet_briefings").upsert({ user_id: userId, season, week, status: final ? "final" : "preliminary",
      stats, report, error: null, updated_at: new Date().toISOString() }, { onConflict: "user_id,season,week" });
  } catch (e) {
    await sb.from("bet_briefings").upsert({ user_id: userId, season, week, status: "error",
      error: String(e instanceof Error ? e.message : e).slice(0, 500), updated_at: new Date().toISOString() }, { onConflict: "user_id,season,week" });
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  try {
    const body = await req.json().catch(() => ({}));
    const cron = req.headers.get("x-pbm-cron");
    if (cron) {
      const { data } = await sb.from("private_config").select("value").eq("key", "cron_token").single();
      if (!data || data.value !== cron) return json({ ok: false, error: "not authorized" }, 401);
      if (body.user_id && body.season && body.week) {
        EdgeRuntime.waitUntil(generate(sb, String(body.user_id), Number(body.season), Number(body.week)));
        return json({ ok: true, generating: true });
      }
      // Schedule: build final briefings for every user who bet in a completed week that has no final briefing yet.
      const { data: weeks } = await sb.from("week_status").select("season,week,week_complete,last_kickoff")
        .eq("week_complete", true).gte("last_kickoff", new Date(Date.now() - 10 * 86400e3).toISOString());
      const jobs: Promise<unknown>[] = [];
      for (const w of weeks ?? []) {
        const { data: users } = await sb.from("my_bet_history").select("user_id").eq("season", w.season).eq("week", w.week);
        for (const uid of new Set((users ?? []).map((u: any) => u.user_id))) {
          const { data: ex } = await sb.from("bet_briefings").select("status").eq("user_id", uid).eq("season", w.season).eq("week", w.week).maybeSingle();
          if (!ex || ex.status !== "final") jobs.push(generate(sb, uid as string, w.season, w.week));
        }
      }
      EdgeRuntime.waitUntil(Promise.all(jobs));
      return json({ ok: true, queued: jobs.length });
    }
    const userSb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    });
    const { data: u } = await userSb.auth.getUser();
    if (!u?.user) return json({ ok: false, error: "Sign in required" }, 401);
    const season = Number(body.season), week = Number(body.week);
    if (!season || !week) return json({ ok: false, error: "season and week are required" }, 400);
    EdgeRuntime.waitUntil(generate(sb, u.user.id, season, week));
    return json({ ok: true, generating: true });
  } catch (err) {
    return json({ ok: false, error: String(err instanceof Error ? err.message : err) }, 500);
  }
});
