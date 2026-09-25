// ===== SUPABASE EDGE FUNCTION: pbm-expert-agent =====
// Claude agent: finds one handicapper's PUBLICLY posted NFL picks for the current week and stores them.
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
    messages.push({ role: "assistant", content: res.content });
  }
  const text = res.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
  const a = text.indexOf("{"), b = text.lastIndexOf("}");
  if (a < 0 || b < 0) throw new Error("Agent returned no JSON: " + text.slice(0, 300));
  return JSON.parse(text.slice(a, b + 1));
}

const SYSTEM = `You track the publicly posted NFL picks of professional handicappers. You record only picks the
handicapper actually published for free and in public (articles, free-pick pages, podcast or show segments
with a write-up, contest entries that were publicly reported, public social posts). Never guess a pick from
general commentary, never infer from reputation, never bypass a paywall, and never fabricate. A lean counts only if
the source states a side. If nothing public is found for this week, return an empty picks list and explain in notes.
Return ONLY one JSON object.`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const { expert_id, season, week } = await req.json();
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: ex } = await sb.from("experts").select("*").eq("id", expert_id).single();
    const { data: games } = await sb.from("games")
      .select("game_id,home_team,away_team,kickoff_utc,spread_line,total_line").eq("season", season).eq("week", week);
    if (!ex || !games?.length) throw new Error("expert or games not found");

    const fav = (g: any) => g.spread_line == null ? "no line" : g.spread_line > 0 ? `${g.home_team} favored by ${g.spread_line}`
      : g.spread_line < 0 ? `${g.away_team} favored by ${-g.spread_line}` : "pick'em";
    const slate = games.map((g) => `${g.game_id}: ${g.away_team} at ${g.home_team} (${fav(g)}, total ${g.total_line})`).join("\n");
    const prompt = `Handicapper: ${ex.name} — ${ex.affiliation}. Usually publishes: ${ex.where_published}.
Find this handicapper's publicly posted picks for NFL ${season} week ${week}. Games this week:
${slate}

Return JSON:
{"picks":[{"game_id":"<one of the ids above>","market":"spread|moneyline|total","pick_team":"<team abbr, or null for totals>",
"pick_side":"home|away|over|under","line":<the number they took, from the picked side's perspective: e.g. +3.5 or -7 for spreads, 44.5 for totals>,
"odds":-110,"units":null,"rationale":"one sentence in your words","source_name":"","source_url":"","published_at":"YYYY-MM-DD"}],
"notes":"what you searched and what you found or could not find"}`;

    const out = await claude(SYSTEM, prompt, 8);
    const ids = new Set(games.map((g) => g.game_id));
    const picks = (out.picks ?? []).filter((p: any) => ids.has(p.game_id) && p.source_url && p.pick_side)
      .map((p: any) => ({
        expert_id, season, week, game_id: p.game_id, market: p.market, pick_team: p.pick_team ?? null,
        pick_side: p.pick_side, line: p.line ?? null, odds: p.odds ?? null, units: p.units ?? null,
        rationale: p.rationale ?? null, source_url: p.source_url, source_name: p.source_name ?? null,
        published_at: p.published_at ?? null, found_at: new Date().toISOString(),
      }));
    if (picks.length) {
      const { error } = await sb.from("expert_picks").upsert(picks, { onConflict: "expert_id,game_id,market" });
      if (error) throw error;
    }
    await sb.from("expert_scans").upsert({ expert_id, season, week, scanned_at: new Date().toISOString(),
      picks_found: picks.length, notes: out.notes ?? null });
    return new Response(JSON.stringify({ ok: true, expert: ex.name, picks: picks.length, notes: out.notes }),
      { headers: { ...cors, "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: String(err) }), {
      status: 500, headers: { ...cors, "Content-Type": "application/json" },
    });
  }
});
