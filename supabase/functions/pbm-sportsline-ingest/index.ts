// ===== SUPABASE EDGE FUNCTION: pbm-sportsline-ingest =====
// 2026-11-02 Receives SportsLine game-forecast data read from Michael's own signed-in SportsLine
// session (browser pane) and stores it privately: model projection, betting splits, expert picks.
// Auth: x-pbm-ingest header must equal private_config.sportsline_ingest_token. Read-only data, never bets.
import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = { "Access-Control-Allow-Origin": "https://www.sportsline.com", "Access-Control-Allow-Headers": "content-type, x-pbm-ingest", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const CODE: Record<string, string> = { JAC: "JAX", LAR: "LA", WSH: "WAS", LVR: "LV", OAK: "LV", SD: "LAC", STL: "LA" };
const fix = (t: string) => CODE[t] ?? t;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const tok = req.headers.get("x-pbm-ingest");
  const { data: cfg } = await sb.from("private_config").select("value").eq("key", "sportsline_ingest_token").single();
  if (!tok || !cfg || cfg.value !== tok) return json({ ok: false, error: "not authorized" }, 401);
  let body: any; try { body = await req.json(); } catch { return json({ ok: false, error: "bad json" }, 400); }
  const games: any[] = Array.isArray(body?.games) ? body.games.slice(0, 40) : [];
  const now = new Date().toISOString();
  let proj = 0, picks = 0; const unmatched: string[] = [];
  for (const g of games) {
    const m = /^NFL_(\d{4})(\d{2})(\d{2})_([A-Z]+)@([A-Z]+)$/.exec(String(g.abbrev ?? ""));
    if (!m) continue;
    const [, y, mo, d, a, h] = m;
    const day = `${y}-${mo}-${d}`;
    const { data: gm } = await sb.from("games").select("game_id,kickoff_utc").eq("away_team", fix(a)).eq("home_team", fix(h))
      .gte("kickoff_utc", new Date(Date.parse(day + "T00:00:00Z") - 86400e3).toISOString()).lte("kickoff_utc", new Date(Date.parse(day + "T00:00:00Z") + 2 * 86400e3).toISOString()).limit(1);
    const game_id = gm?.[0]?.game_id ?? null;
    if (!game_id) unmatched.push(g.abbrev);
    const p = g.projection;
    if (p && (p.awayScore != null || p.spread)) {
      const row = { abbrev: g.abbrev, game_id, captured_at: now, away_score: p.awayScore ?? null, home_score: p.homeScore ?? null, spread: p.spread ?? null, moneyline: p.moneyLine ?? null, total: p.total ?? null, splits: g.splits ?? null };
      const { error } = await sb.from("sportsline_projection").upsert(row); if (error) return json({ ok: false, error: error.message }, 500);
      await sb.from("sportsline_projection_history").insert({ abbrev: g.abbrev, captured_at: now, game_id, data: { projection: p, splits: g.splits ?? null } });
      proj++;
    }
    const rows = (Array.isArray(g.experts) ? g.experts : []).map((e: any) => ({
      pick_id: String(e.id), abbrev: g.abbrev, game_id, expert_id: e.expert_id ?? null, expert_name: e.expert_name ?? null, nickname: e.nickname ?? null,
      market: e.market ?? null, label: e.label ?? null, odds: e.odds ?? null, unit: e.unit ?? null, subject_id: e.subject_id ?? null,
      analysis: typeof e.analysis === "string" ? e.analysis.slice(0, 6000) : null, result_status: e.result_status ?? null, streak_label: e.streak_label ?? null, streak_profit: e.streak_profit ?? null, created_at: e.created_at ?? null, captured_at: now,
    }));
    if (rows.length) { const { error } = await sb.from("sportsline_expert_picks").upsert(rows); if (error) return json({ ok: false, error: error.message }, 500); picks += rows.length; }
  }
  return json({ ok: true, projections: proj, expert_picks: picks, unmatched });
});
