// ===== SUPABASE EDGE FUNCTION: pbm-engine-trigger =====
// Starts the GitHub Actions engine (model + injuries + weather + Claude news agents) on demand.
// Called by pg_cron right after each kickoff slot's inactives (x-pbm-cron header) or by a signed-in allowed user.
// Needs the secret GITHUB_ACTIONS_TOKEN (fine-grained token: this repo only, Actions = Read and write).
import { createClient } from "npm:@supabase/supabase-js@2";

const REPO = Deno.env.get("PBM_GITHUB_REPO") ?? "mmarti2547/play-book-matrix";
const WORKFLOW = "engine.yml";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-pbm-cron",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });

async function gh(method: string, path: string, body?: unknown) {
  const token = Deno.env.get("GITHUB_ACTIONS_TOKEN");
  if (!token) throw new Error("GITHUB_ACTIONS_TOKEN secret is not set yet");
  const r = await fetch(`https://api.github.com/repos/${REPO}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28",
               "User-Agent": "play-book-matrix", ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  return { ok: r.ok, status: r.status, data };
}


declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };
// Re-run the Claude news/injury agent for games whose news is older than that game's inactives (kickoff - 90 min).
async function refreshNews(sb: any, onlySlot?: string | null) {
  const now = Date.now();
  let q = sb.from("games").select("game_id,kickoff_utc").is("home_score", null)
    .gt("kickoff_utc", new Date(now).toISOString()).lt("kickoff_utc", new Date(now + 3 * 3600e3).toISOString());
  if (onlySlot) q = q.eq("kickoff_utc", onlySlot);
  const { data: games } = await q;
  const ids = (games ?? []).map((g: any) => g.game_id);
  if (!ids.length) return [];
  const { data: intel } = await sb.from("news_intel").select("game_id,scanned_at").in("game_id", ids);
  const last: Record<string, number> = {};
  for (const r of intel ?? []) last[r.game_id] = new Date(r.scanned_at).getTime();
  const due = (games ?? []).filter((g: any) => {
    const inactives = new Date(g.kickoff_utc).getTime() - 90 * 60e3;
    return now >= inactives && !(last[g.game_id] >= inactives);
  }).map((g: any) => g.game_id);
  const url = `${Deno.env.get("SUPABASE_URL")}/functions/v1/pbm-news-agent`;
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const one = (game_id: string) => fetch(url, { method: "POST",
    headers: { Authorization: `Bearer ${key}`, apikey: key, "Content-Type": "application/json" },
    body: JSON.stringify({ game_id }) }).then((r) => r.status).catch((e) => String(e));
  for (let i = 0; i < due.length; i += 6) await Promise.all(due.slice(i, i + 6).map(one));
  return due;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  try {
    // --- who is calling ---
    let source = "user";
    let role: string | null = null;
    const cron = req.headers.get("x-pbm-cron");
    if (cron) {
      const { data } = await sb.from("private_config").select("value").eq("key", "cron_token").single();
      if (!data || data.value !== cron) return json({ ok: false, error: "not authorized" }, 401);
      source = "schedule";
    } else {
      const userSb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
        global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
      });
      const { data: u } = await userSb.auth.getUser();
      if (!u?.user) return json({ ok: false, error: "Sign in required" }, 401);
      // 2026-10-26 anyone on the members list may use this (owner and members run it; research accounts may only read the status)
      const { data: m } = await sb.from("app_members").select("role").eq("user_id", u.user.id).maybeSingle();
      role = m?.role ?? null;
      const allowed = (Deno.env.get("KALSHI_ALLOWED_EMAILS") ?? "").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
      const listed = allowed.includes((u.user.email ?? "").toLowerCase());
      if (!role && !listed && allowed.length) return json({ ok: false, error: "not allowed" }, 403);
    }
    const body = await req.json().catch(() => ({}));
    const action = body.action ?? "run";
    if (role === "research" && action !== "status") return json({ ok: false, error: "Research accounts can't start the engine" }, 403);

    if (action === "status") {
      const r = await gh("GET", `/actions/workflows/${WORKFLOW}/runs?per_page=1`);
      const run = r.data?.workflow_runs?.[0];
      return json({ ok: r.ok, run: run ? { status: run.status, conclusion: run.conclusion, event: run.event,
        started_at: run.run_started_at ?? run.created_at, updated_at: run.updated_at, url: run.html_url } : null });
    }

    if (action === "news_test" && body.game_id) {
      const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
      const r = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/pbm-news-agent`, { method: "POST",
        headers: { Authorization: `Bearer ${key}`, apikey: key, "Content-Type": "application/json" },
        body: JSON.stringify({ game_id: body.game_id, wait: true }) });
      return json({ status: r.status, body: (await r.text()).slice(0, 1500) });
    }

    if (action === "news") {
      EdgeRuntime.waitUntil(refreshNews(sb, body.slot ?? null));
      return json({ ok: true, news_refresh: "started" });
    }

    // action "run": always refresh the news agents for games past their inactives (GitHub's agent step skips news under 6h old)
    EdgeRuntime.waitUntil(refreshNews(sb, null));
    // then start the GitHub engine (model + injuries + weather), unless one is already queued/running
    const cur = await gh("GET", `/actions/workflows/${WORKFLOW}/runs?per_page=1`);
    const last = cur.data?.workflow_runs?.[0];
    if (last && ["queued", "in_progress", "waiting", "pending"].includes(last.status)) {
      await sb.from("engine_triggers").insert({ source, slot: body.slot ?? null, status: "already_running", detail: last.html_url });
      return json({ ok: true, already_running: true, url: last.html_url });
    }
    const r = await gh("POST", `/actions/workflows/${WORKFLOW}/dispatches`, { ref: "main" });
    await sb.from("engine_triggers").insert({ source, slot: body.slot ?? null, status: r.ok ? "started" : "error",
      detail: r.ok ? null : `GitHub ${r.status}: ${JSON.stringify(r.data).slice(0, 300)}` });
    if (!r.ok) return json({ ok: false, error: `GitHub ${r.status}: ${JSON.stringify(r.data).slice(0, 300)}` }, 502);
    return json({ ok: true, started: true });
  } catch (err) {
    const msg = String(err instanceof Error ? err.message : err);
    await sb.from("engine_triggers").insert({ source: "error", status: "error", detail: msg.slice(0, 300) });
    return json({ ok: false, error: msg }, 500);
  }
});
