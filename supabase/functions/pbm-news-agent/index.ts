// ===== SUPABASE EDGE FUNCTION: pbm-news-agent =====
// Claude news agent: researches both teams for one game and writes a sourced brief + bounded point adjustment.
import { createClient } from "npm:@supabase/supabase-js@2";

const MODEL = Deno.env.get("PBM_AGENT_MODEL") ?? "claude-sonnet-5";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

async function claude(system: string, prompt: string, maxSearches: number) {
  const messages: any[] = [{ role: "user", content: prompt }];
  let res: any = null;
  for (let i = 0; i < 4; i++) {
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
      }),
    });
    if (!r.ok) throw new Error(`Anthropic ${r.status}: ${await r.text()}`);
    res = await r.json();
    if (res.stop_reason !== "pause_turn") break;
    messages.push({ role: "assistant", content: res.content }); // continue a paused search turn
  }
  const text = res.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
  const a = text.indexOf("{"), b = text.lastIndexOf("}");
  if (a < 0 || b < 0) throw new Error("Agent returned no JSON: " + text.slice(0, 300));
  return JSON.parse(text.slice(a, b + 1));
}

const SYSTEM = `You are the Play Book Matrix NFL intelligence analyst. You research news that could change how a
team performs in its next game and quantify it for a betting model that already knows season-long efficiency
(EPA, success rate), official injury designations, weather, rest and travel. Only report what the model cannot see.

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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const { game_id } = await req.json();
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: g, error } = await sb.from("games").select("*").eq("game_id", game_id).single();
    if (error || !g) throw new Error("game not found: " + game_id);
    const { data: p } = await sb.from("predictions")
      .select("home_starters_out,away_starters_out").eq("game_id", game_id).maybeSingle();

    const prompt = `Game: ${g.away_team} at ${g.home_team}, ${g.season} week ${g.week}, kickoff ${g.kickoff_utc} UTC,
${g.stadium}. Vegas: home spread line ${g.spread_line} (expected home margin), total ${g.total_line}.
Starting QBs listed: ${g.away_qb} (away), ${g.home_qb} (home).
Starters already on the official injury report (the model has these):
home ${JSON.stringify(p?.home_starters_out ?? [])}
away ${JSON.stringify(p?.away_starters_out ?? [])}

Research both teams now. Return JSON:
{"home":{"adjustment_pts":0,"confidence":0.5,"items":[{"player":"","category":"injury|personal|legal|off_field|coaching|locker_room|contract|travel|motivation|other","headline":"","summary":"","impact":"negative|positive|neutral","severity":1,"source_name":"","source_url":"","published":"YYYY-MM-DD"}]},
 "away":{...same...},"volatility":0.3,"game_brief":"4-6 sentence betting-focused preview of what matters in this game"}`;

    const out = await claude(SYSTEM, prompt, 10);
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
    return new Response(JSON.stringify({ ok: true, ...row }), { headers: { ...cors, "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: String(err) }), {
      status: 500, headers: { ...cors, "Content-Type": "application/json" },
    });
  }
});
