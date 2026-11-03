// ===== SUPABASE EDGE FUNCTION: pbm-learning-agent =====
// Weekly learning review (Tuesdays): runs the guard-railed model tuning, then has the SI Agent review the week's
// results and maintain a lessons memory. Lessons need 3+ separate confirming weeks before they affect anything.
import { createClient } from "npm:@supabase/supabase-js@2";

const MODEL = Deno.env.get("PBM_AGENT_MODEL") ?? "claude-sonnet-5";
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-pbm-cron" };
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...cors, "Content-Type": "application/json" } });
declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };

async function logUsage(sb: any, res: any) {
  try {
    const u = res?.usage ?? {};
    const inTok = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
    const outTok = u.output_tokens ?? 0;
    const pin = Number(Deno.env.get("PBM_PRICE_IN") ?? "3"), pout = Number(Deno.env.get("PBM_PRICE_OUT") ?? "15");
    await sb.from("agent_usage").insert({ agent: "learning", ref: null, model: res?.model ?? null, input_tokens: inTok,
      output_tokens: outTok, web_searches: 0, cost_usd: Math.round(((inTok / 1e6) * pin + (outTok / 1e6) * pout) * 10000) / 10000 });
  } catch (_) { /* never break on cost logging */ }
}

const SYSTEM = `You are the Play Book Matrix model reviewer. Once a week you look at how the prediction system did and
maintain a short memory of LESSONS for the SI analyst agents (mainly the news/injury agent that adjusts each team's
expected margin before games). You are given computed facts only - never invent numbers.

Your jobs:
1. For each existing lesson, judge whether THIS week's evidence supports it, contradicts it, or says nothing (neutral).
   Be strict: "supports" only if this week clearly shows the same pattern again. Most lessons are neutral most weeks.
2. Propose at most 3 NEW candidate lessons - only if this week shows a clear, specific pattern about how games should be
   assessed (e.g. how much a specific type of injury news mattered, a situation the model mispriced). Each lesson must be:
   one sentence, concrete, actionable by an analyst before a game, testable against future weeks, and NOT about the
   user's personal betting habits. Never make a lesson from a single game. Do not duplicate existing lessons.
   It is fine to propose none - one week is a small sample and most variance is luck.
3. Write a 2-3 sentence plain-English summary of what the system learned this week (including "nothing conclusive yet"
   when that is the honest answer).
Return ONLY one JSON object:
{"reviews":[{"id":0,"verdict":"supports|contradicts|neutral","why":""}],
 "new_lessons":[{"lesson":"","category":"injuries|weather|matchups|market|model|situational|other","applies_to":"news|all","evidence":""}],
 "summary":""}`;

async function claude(sb: any, prompt: string) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": Deno.env.get("ANTHROPIC_API_KEY")!, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, max_tokens: 3000, system: SYSTEM, messages: [{ role: "user", content: prompt }] }),
    });
    if (!r.ok) throw new Error(`Anthropic ${r.status}: ${(await r.text()).slice(0, 300)}`);
    const out = await r.json();
    await logUsage(sb, out);
    const text = (out.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
    const a = text.indexOf("{"), b = text.lastIndexOf("}");
    try { if (a >= 0 && b > a) return JSON.parse(text.slice(a, b + 1)); } catch (_) { /* retry */ }
  }
  throw new Error("Learning agent returned no valid JSON");
}

async function run(body: any) {
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  // Latest week with every game final (or the week asked for)
  let season = body.season, week = body.week;
  if (!season || !week) {
    const { data: ws } = await sb.from("weekly_scorecard").select("season,week,week_complete").eq("week_complete", true)
      .order("season", { ascending: false }).order("week", { ascending: false }).limit(1);
    if (!ws?.length) return { ok: false, error: "no completed week yet" };
    season = ws[0].season; week = ws[0].week;
  }
  const { data: done } = await sb.from("learning_runs").select("id").eq("season", season).eq("week", week).maybeSingle();
  if (done && !body.force) return { ok: true, skipped: `already reviewed ${season} week ${week}` };

  // 1) Guard-railed tuning (moves nothing unless the evidence is big and clear)
  const { data: paramChanges } = await sb.rpc("pbm_weekly_learn");

  // 2) Facts for the review
  const [scores, calib, sheet, alts, news, clv, lessons] = await Promise.all([
    sb.from("model_scores").select("*"),
    sb.from("model_calibration").select("source,bucket,n,predicted_pct,actual_pct,gap_pts"),
    sb.from("sheet_results").select("home_team,away_team,home_score,away_score,spread_line,ats_pick,rating,bet_score,ats_result,su_result,predicted_winner,vegas_su_result,kalshi_su_result").eq("season", season).eq("week", week),
    sb.from("alt_record").select("game_id,bet_label,our_prob,yes_ask,grade,result,home_team,away_team,home_score,away_score").eq("season", season).eq("week", week),
    sb.from("news_agent_record").select("away_team,home_team,spread_line,home_score,away_score,net_home_adj,home_vs_spread,result").eq("season", season).eq("week", week),
    sb.from("clv_summary").select("*"),
    sb.from("agent_lessons").select("id,lesson,category,status,confirmations,contradictions,weeks").in("status", ["candidate", "active"]).order("id"),
  ]);
  // one alt line per game (the most confident) so ladders don't exaggerate
  const altByGame: Record<string, any> = {};
  for (const a of alts.data ?? []) if (a.result && (!altByGame[a.game_id] || a.our_prob > altByGame[a.game_id].our_prob)) altByGame[a.game_id] = a;
  const stats = {
    season, week,
    model_scores_all_time: scores.data ?? [], calibration_all_time: calib.data ?? [],
    this_week_ats_picks: sheet.data ?? [], this_week_alt_best_line_per_game: Object.values(altByGame),
    this_week_news_agent_adjustments: news.data ?? [], closing_line_value: clv.data ?? [],
    guarded_parameter_tuning: paramChanges ?? [],
  };
  const prompt = `Week reviewed: ${season} week ${week}.\n\nFACTS (JSON):\n${JSON.stringify(stats)}\n\nEXISTING LESSONS (JSON):\n${JSON.stringify(lessons.data ?? [])}`;
  const out = await claude(sb, prompt);

  // 3) Apply lesson bookkeeping with hard rules (the model only votes; code decides)
  const wk = `${season}-${String(week).padStart(2, "0")}`;
  const byId: Record<number, any> = Object.fromEntries((lessons.data ?? []).map((l: any) => [l.id, l]));
  const now = new Date().toISOString();
  for (const rv of out.reviews ?? []) {
    const l = byId[Number(rv.id)]; if (!l) continue;
    const seen = (l.weeks ?? []).includes(wk);
    const patch: any = { last_seen: now };
    if (rv.verdict === "supports" && !seen) { patch.confirmations = l.confirmations + 1; patch.weeks = [...(l.weeks ?? []), wk]; }
    if (rv.verdict === "contradicts") patch.contradictions = l.contradictions + 1;
    const conf = patch.confirmations ?? l.confirmations, contra = patch.contradictions ?? l.contradictions;
    const weeksN = (patch.weeks ?? l.weeks ?? []).length;
    if (l.status === "candidate" && weeksN >= 3 && conf >= 2 * contra) { patch.status = "active"; patch.promoted_at = now; }
    if (l.status === "active" && contra >= 3 && contra * 2 > conf) { patch.status = "retired"; patch.retired_at = now; }
    await sb.from("agent_lessons").update(patch).eq("id", l.id);
  }
  // stale candidates that never got a second confirmation within 8 weeks
  await sb.from("agent_lessons").update({ status: "retired", retired_at: now }).eq("status", "candidate").lt("confirmations", 2)
    .lt("first_seen", new Date(Date.now() - 56 * 864e5).toISOString());
  const fresh = (out.new_lessons ?? []).slice(0, 3).filter((n: any) => n?.lesson && String(n.lesson).length > 15);
  if (fresh.length) await sb.from("agent_lessons").insert(fresh.map((n: any) => ({
    lesson: String(n.lesson).slice(0, 400), category: n.category ?? "other", applies_to: n.applies_to === "all" ? "all" : "news",
    evidence: String(n.evidence ?? "").slice(0, 600), weeks: [wk] })));

  await sb.from("learning_runs").upsert({ season, week, run_at: now, summary: out.summary ?? null, reviews: out.reviews ?? [],
    new_lessons: fresh, param_changes: paramChanges ?? [], stats: { n_ats: (sheet.data ?? []).length, n_alt_games: Object.keys(altByGame).length }, error: null },
    { onConflict: "season,week" });
  return { ok: true, season, week, summary: out.summary, new_lessons: fresh.length, reviews: (out.reviews ?? []).length, param_changes: paramChanges };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const sbc = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  // Only the schedule (cron token) or a signed-in user may start it
  const cronTok = req.headers.get("x-pbm-cron");
  if (cronTok) {
    const { data: cfg } = await sbc.from("private_config").select("value").eq("key", "cron_token").single();
    if (!cfg || cfg.value !== cronTok) return json({ ok: false, error: "not authorized" }, 401);
  } else {
    const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
    const { data: u } = await sbc.auth.getUser(token);
    if (!u?.user) return json({ ok: false, error: "sign in required" }, 401);
  }
  let body: any = {}; try { body = await req.json(); } catch { /* empty */ }
  const job = async () => { try { return await run(body); } catch (e) {
    const msg = String(e instanceof Error ? e.message : e); console.error(msg);
    if (body.season && body.week) await sbc.from("learning_runs").upsert({ season: body.season, week: body.week, error: msg }, { onConflict: "season,week" });
    return { ok: false, error: msg }; } };
  if (body.wait) return json(await job());
  EdgeRuntime.waitUntil(job());
  return json({ ok: true, queued: true }, 202);
});
