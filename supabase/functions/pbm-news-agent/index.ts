// ===== SUPABASE EDGE FUNCTION: pbm-news-agent =====
// Claude news agent: researches both teams for one game and writes a sourced brief + bounded point adjustment.
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
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

async function claude(system: string, prompt: string, maxSearches: number) {
  const messages: any[] = [{ role: "user", content: prompt }];
  const call = async (withTools: boolean) => {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": Deno.env.get("ANTHROPIC_API_KEY")!,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL, max_tokens: 6000, system, messages,
        tools: [{ type: "web_search_20260318", name: "web_search", max_uses: maxSearches, response_inclusion: "excluded" }],
        ...(withTools ? {} : { tool_choice: { type: "none" } }),
      }),
    });
    if (!r.ok) throw new Error(`Anthropic ${r.status}: ${await r.text()}`);
    const out = await r.json();
    await logUsage("news", out);
    return out;
  };
  const textOf = (res: any) => (res?.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
  const hasJson = (t: string) => t.indexOf("{") >= 0 && t.lastIndexOf("}") > t.indexOf("{");
  let res: any = null;
  for (let i = 0; i < 8; i++) {
    res = await call(true);
    if (res.stop_reason !== "pause_turn") break;
    messages.push({ role: "assistant", content: res.content }); // continue a paused search turn
  }
  let text = textOf(res);
  if (!hasJson(text)) {
    // The agent finished (or paused) without the JSON: ask once more, no tools, for the JSON only.
    messages.push({ role: "assistant", content: res.content });
    messages.push({ role: "user", content: "Stop searching now. Using what you found, return ONLY the JSON object in the required format." });
    res = await call(false);
    text = textOf(res);
  }
  const parse = (t: string) => {
    const a = t.indexOf("{"), b = t.lastIndexOf("}");
    if (a < 0 || b < 0) throw new Error("Agent returned no JSON: " + t.slice(0, 300));
    return JSON.parse(t.slice(a, b + 1));
  };
  try { return parse(text); }
  catch (e) {
    // 2026-10-04: the agent sometimes returns slightly broken JSON (a missing comma, a stray quote). Ask once, no tools, for a corrected copy.
    // fresh single-turn request (no tools, no earlier tool blocks) that only repairs the JSON text
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": Deno.env.get("ANTHROPIC_API_KEY")!, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, max_tokens: 6000,
        messages: [{ role: "user", content: `This JSON is invalid (${String(e).slice(0, 120)}). Return ONLY the same object, unchanged in content, as strictly valid JSON (double-quoted keys and strings, commas between items, no comments, no trailing commas):\n\n${text}` }] }),
    });
    if (!r.ok) throw new Error(`Anthropic ${r.status}: ${await r.text()}`);
    const fixed = await r.json();
    await logUsage("news", fixed);
    return parse(textOf(fixed));
  }
}

const SYSTEM = `You are the Play Book Matrix NFL intelligence analyst. You research news that could change how a
team performs in its next game and quantify it for a betting model that already knows season-long efficiency
(EPA, success rate), official injury designations, weather, rest and travel. Only report what the model cannot see.

On game day, first check the official inactives list (released 90 minutes before kickoff) for both teams.
Look for, within the last 10 days: late injury changes and game-time decisions, practice reports, players ruled
out after the final report, suspensions, arrests or legal trouble, personal and family events reported in the press
(divorce, bereavement, birth of a child, car accident, illness in the family), holdouts and contract disputes,
locker-room conflict, coaching and play-calling changes, travel problems, and motivation or rest spots.

Rules:
- Use reputable, published reporting only (team sites, NFL.com, ESPN, The Athletic, AP, local beat writers).
  No anonymous social-media rumor. Every item needs a source URL. Never invent an item. If nothing is found, say so.
- Report personal matters factually and only as far as they were publicly reported and bear on availability or play.
- adjustment_pts is the change in that team's expected margin (points) NOT already reflected by the official injury
  report, clamped to [-3, 3]. Most games deserve 0 to ±1. A starting QB surprise scratch can justify -3.
- confidence 0..1 in your adjustment; volatility 0..1 = how much unresolved uncertainty remains (game-time
  decisions, weather, unclear reports).
Return ONLY one JSON object, no prose.`;

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  let body: any = {};
  try { body = await req.json(); } catch { /* empty body */ }
  const job = async () => {
    try {
      return await run(body);
    } catch (err) {
      console.error(String(err));
      return { ok: false, error: String(err) };
    }
  };
  // Long web research runs in the background so the HTTP request never hits the 150s gateway limit.
  if (body.wait) return json(await job());
  EdgeRuntime.waitUntil(job());
  return json({ ok: true, queued: true }, 202);
});

async function run(body: any) {
    const { game_id } = body;
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    // Lessons the weekly learning review has CONFIRMED in 3+ separate weeks (candidates are never used)
    const { data: lessons } = await sb.from("agent_lessons").select("lesson").eq("status", "active")
      .in("applies_to", ["news", "all"]).order("confirmations", { ascending: false }).limit(8);
    const system = SYSTEM + ((lessons ?? []).length ? "\n\nLessons learned from past weeks (each confirmed in 3+ separate weeks; apply only when relevant to this game):\n" +
      (lessons ?? []).map((l: any) => "- " + l.lesson).join("\n") : "");
    const { data: g, error } = await sb.from("games").select("*").eq("game_id", game_id).single();
    if (error || !g) throw new Error("game not found: " + game_id);
    const { data: p } = await sb.from("predictions")
      .select("home_starters_out,away_starters_out").eq("game_id", game_id).maybeSingle();

    const line = g.spread_line == null ? "no line posted" : g.spread_line > 0 ? `${g.home_team} (home) favored by ${g.spread_line}`
      : g.spread_line < 0 ? `${g.away_team} (away) favored by ${-g.spread_line}` : "pick'em";
    const prompt = `Game: ${g.away_team} at ${g.home_team}, ${g.season} week ${g.week}, kickoff ${g.kickoff_utc} UTC,
${g.stadium}. Vegas: ${line}; moneylines ${g.away_team} ${g.away_moneyline}, ${g.home_team} ${g.home_moneyline}; total ${g.total_line}.
Starting QBs listed: ${g.away_qb} (away), ${g.home_qb} (home).
Starters already on the official injury report (the model has these):
home ${JSON.stringify(p?.home_starters_out ?? [])}
away ${JSON.stringify(p?.away_starters_out ?? [])}

Research both teams now. Return JSON:
{"home":{"adjustment_pts":0,"confidence":0.5,"items":[{"player":"","category":"injury|personal|legal|off_field|coaching|locker_room|contract|travel|motivation|other","headline":"","summary":"","impact":"negative|positive|neutral","severity":1,"source_name":"","source_url":"","published":"YYYY-MM-DD"}]},
 "away":{...same...},"volatility":0.3,"game_brief":"4-6 sentence betting-focused preview of what matters in this game"}`;

    const out = await claude(system, prompt, 10);
    const clamp = (x: number) => Math.max(-3, Math.min(3, Number(x) || 0));
    const row = {
      game_id,
      home_adj_pts: clamp(out.home?.adjustment_pts), away_adj_pts: clamp(out.away?.adjustment_pts),
      home_confidence: out.home?.confidence ?? null, away_confidence: out.away?.confidence ?? null,
      volatility: out.volatility ?? null, home_items: out.home?.items ?? [], away_items: out.away?.items ?? [],
      game_brief: out.game_brief ?? null, agent_model: MODEL, scanned_at: new Date().toISOString(),
    };
    const { error: e2 } = await sb.from("news_intel").upsert(row);
    if (e2) throw e2;
    await sb.rpc("snapshot_slate", { d: g.game_date_et });
    return { ok: true, ...row };
}
