// ===== SUPABASE EDGE FUNCTION: pbm-health =====
// Model Health alert (2026-11-09). Run by pg_cron with the cron token, every morning and after game nights.
// Reads public.model_health (Last 4 weeks), compares each product's status light with the last one we saw
// (public.model_health_state) and emails Michael (pbm-email kind "system") whenever a light changes color.
// The first run only records the current lights (no email), so the first alert is a real change.
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-pbm-cron" };
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const COLOR: Record<string, string> = { Green: "#34d399", Yellow: "#fbbf24", Red: "#f87171", "Not enough yet": "#94a3b8" };
const WORD: Record<string, string> = { Green: "Working", Yellow: "Slipping", Red: "Broken", "Not enough yet": "Not enough games yet" };
const pct = (v: unknown) => (v == null ? "—" : `${Number(v).toFixed(1)}%`);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const tok = req.headers.get("x-pbm-cron") ?? "";
  const { data: cfg } = await sb.from("private_config").select("value").eq("key", "cron_token").single();
  if (!tok || !cfg || cfg.value !== tok) return json({ ok: false, error: "not authorized" }, 401);
  try {
    const { data: rows, error } = await sb.from("model_health").select("*").eq("time_window", "Last 4 weeks");
    if (error) throw error;
    const { data: prev } = await sb.from("model_health_state").select("product,status");
    const before = new Map<string, string>((prev ?? []).map((p: any) => [p.product, p.status]));
    const first = before.size === 0;
    const changes = (rows ?? []).filter((r: any) => !first && before.get(r.product) !== r.status && !(before.get(r.product) == null && r.status === "Not enough yet"));
    if (rows?.length) {
      const up = rows.filter((r: any) => before.get(r.product) !== r.status).map((r: any) => ({ product: r.product, status: r.status, changed_at: new Date().toISOString() }));
      if (up.length) await sb.from("model_health_state").upsert(up);
    }
    let email: unknown = null;
    if (changes.length) {
      const rank = (s: string) => (s === "Red" ? 0 : s === "Yellow" ? 1 : s === "Green" ? 2 : 3);
      changes.sort((a: any, b: any) => rank(a.status) - rank(b.status));
      const items = changes.map((r: any) => {
        const was = before.get(r.product) ?? "new";
        const why = r.said_pct != null ? `Said ${pct(r.said_pct)} · Hit ${pct(r.hit_pct)} · Return ${pct(r.return_pct)}` : `Record W-${r.wins} L-${r.losses} · Return ${pct(r.return_pct)}`;
        const tip = r.status === "Red" ? "Don't bet this until it's fixed." : r.status === "Yellow" ? "Slipping - bet smaller or wait." : r.status === "Green" ? "Back to doing what it promised." : "";
        return `<div style="margin:0 0 12px;padding:12px;border:1px solid #1f2a44;border-left:6px solid ${COLOR[r.status] ?? "#94a3b8"};border-radius:8px">
          <div style="font-size:18px;font-weight:bold;color:${COLOR[r.status] ?? "#fff"}">${r.product}: ${WORD[r.status] ?? r.status}</div>
          <div style="color:#cbd5e1;margin:4px 0">Was ${WORD[was] ?? was}. Last 4 weeks: ${why}</div>
          <div style="color:#fff">${tip}</div></div>`;
      }).join("");
      const subject = "Model Health: " + changes.map((r: any) => `${r.product} ${WORD[r.status] ?? r.status}`).join(" · ");
      const r = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/pbm-email`, {
        method: "POST", headers: { "Content-Type": "application/json", "x-pbm-cron": tok },
        body: JSON.stringify({ action: "send", kind: "system", subject, title: "Model Health changed",
          html: items + `<div style="font-size:13px;color:#94a3b8">Status uses the last 4 weeks. Red = hit 8+ points under what we said, or losing 15%+. Full page: Model Health in the menu.</div>` }) });
      email = await r.json().catch(() => null);
    }
    return json({ ok: true, first_run: first, products: rows?.length ?? 0, changes: changes.map((r: any) => `${r.product}: ${before.get(r.product)} -> ${r.status}`), email });
  } catch (e) {
    return json({ ok: false, error: String(e instanceof Error ? e.message : e) }, 500);
  }
});
