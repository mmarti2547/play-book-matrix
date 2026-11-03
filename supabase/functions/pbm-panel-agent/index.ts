// ===== SUPABASE EDGE FUNCTION: pbm-panel-agent =====
// Claude agent: reads ONE outlet's publicly published NFL staff-picks article(s) for the week and records every
// named expert's picks (spread and straight-up) with the source link. Experts are graded later and weighted.
// Called by pg_cron (x-pbm-cron header) or by a signed-in user; runs in the background and returns 202.
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
        model: MODEL, max_tokens: 12000, system, messages,
        tools: [{ type: "web_search_20260318", name: "web_search", max_uses: maxSearches, response_inclusion: "excluded" }],
      }),
    });
    if (!r.ok) throw new Error(`Anthropic ${r.status}: ${await r.text()}`);
    res = await r.json();
    await logUsage("panel", res);
    if (res.stop_reason !== "pause_turn") break;
    messages.push({ role: "assistant", content: res.content });
  }
  const text = res.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
  const a = text.indexOf("{"), b = text.lastIndexOf("}");
  if (a < 0 || b < 0) throw new Error("Agent returned no JSON: " + text.slice(0, 300));
  return JSON.parse(text.slice(a, b + 1));
}

const SYSTEM = `You collect NFL staff picks that a media outlet has PUBLISHED FOR FREE this week (e.g. "our experts'
picks for week N" articles or pick grids). Record only picks explicitly stated in a public article from that outlet:
the expert's name, the game, and the side they picked. Never infer, never bypass a paywall, never fabricate, and
never copy article text beyond the pick itself. Distinguish against-the-spread picks (market "spread", include the
line from the picked team's perspective, e.g. +3.5 / -7) from straight-up winner picks (market "moneyline", line null).
If the outlet has not published picks for this week yet, return an empty experts list and say so in notes.
Return ONLY one JSON object.`;

async function run(outletId: number, season: number, week: number) {
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: o } = await sb.from("panel_outlets").select("*").eq("id", outletId).single();
  const { data: games } = await sb.from("games")
    .select("game_id,home_team,away_team,kickoff_utc,spread_line").eq("season", season).eq("week", week);
  if (!o || !games?.length) throw new Error("outlet or games not found");

  const slate = games.map((g) => `${g.game_id}: ${g.away_team} at ${g.home_team} (home line ${g.spread_line})`).join("\n");
  const hint = String(o.search_hint ?? o.outlet).replace("{week}", String(week)).replace("{season}", String(season));
  const prompt = `Outlet: ${o.outlet}. Search suggestion: "${hint}".
Find this outlet's published staff/expert picks for NFL ${season} week ${week}. Games:
${slate}

Return JSON:
{"experts":[{"name":"<expert full name>","picks":[{"game_id":"<one of the ids above>","market":"spread|moneyline",
"pick_team":"<team abbr as listed above>","line":<number or null>}]}],
"source_url":"<main article URL>","notes":"what you found or could not find"}`;

  const out = await claude(SYSTEM, prompt, 8);
  const byId = new Map(games.map((g) => [g.game_id, g]));
  let nExperts = 0, nPicks = 0;
  for (const ex of out.experts ?? []) {
    const name = String(ex.name ?? "").trim();
    if (!name || name.length > 80) continue;
    const { data: existing } = await sb.from("experts").select("id,tier").eq("name", name).maybeSingle();
    if (existing?.tier === "core") continue; // never touch your core handicappers from a staff grid
    const { data: e, error: ee } = existing
      ? { data: existing, error: null }
      : await sb.from("experts")
          .insert({ name, affiliation: o.outlet, outlet: o.outlet, where_published: out.source_url ?? null, tier: "panel", active: true })
          .select("id,tier").single();
    if (ee || !e) continue;
    const rows = (ex.picks ?? []).filter((p: any) => byId.has(p.game_id) && ["spread", "moneyline"].includes(p.market))
      .map((p: any) => {
        const g: any = byId.get(p.game_id);
        const side = p.pick_team === g.home_team ? "home" : p.pick_team === g.away_team ? "away" : null;
        return side && {
          expert_id: e.id, season, week, game_id: p.game_id, market: p.market, pick_team: p.pick_team, pick_side: side,
          line: p.market === "spread" ? (p.line ?? (side === "home" ? -g.spread_line : g.spread_line)) : null,
          pick_type: "pick", source_url: out.source_url ?? null, source_name: o.outlet, found_at: new Date().toISOString(),
        };
      }).filter(Boolean);
    if (rows.length) {
      const { error } = await sb.from("expert_picks").upsert(rows, { onConflict: "expert_id,game_id,market" });
      if (!error) { nExperts++; nPicks += rows.length; }
    }
  }
  await sb.from("panel_scans").upsert({ outlet_id: outletId, season, week, scanned_at: new Date().toISOString(),
    experts_found: nExperts, picks_found: nPicks, notes: out.notes ?? null });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const cronHdr = req.headers.get("x-pbm-cron");
    let allowed = false;
    if (cronHdr) {
      const { data } = await sb.from("private_config").select("value").eq("key", "cron_token").single();
      allowed = !!data && data.value === cronHdr;
    } else {
      const userSb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
        global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
      });
      const { data: u } = await userSb.auth.getUser();
      allowed = !!u?.user;
    }
    if (!allowed) return json({ ok: false, error: "not authorized" }, 401);

    const { outlet_id, season, week } = await req.json();
    // @ts-ignore EdgeRuntime is provided by Supabase
    EdgeRuntime.waitUntil(run(Number(outlet_id), Number(season), Number(week)).catch(async (err) => {
      await sb.from("panel_scans").upsert({ outlet_id, season, week, scanned_at: new Date().toISOString(),
        experts_found: 0, picks_found: 0, notes: "error: " + String(err).slice(0, 400) });
    }));
    return json({ ok: true, queued: true }, 202);
  } catch (err) {
    return json({ ok: false, error: String(err instanceof Error ? err.message : err) }, 500);
  }
});
