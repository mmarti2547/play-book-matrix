// ===== SUPABASE EDGE FUNCTION: pbm-email =====
// Sends Play Book Matrix alerts from alerts@playbookmatrix.com through Resend (key in the RESEND_API_KEY secret).
// Other functions/schedules call it with the cron token: { action:"send", kind, subject, html, user_id? }.
// A signed-in user can call { action:"test" } to get a test email at their own address.
import { createClient } from "npm:@supabase/supabase-js@2";
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-pbm-cron" };
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const FROM = Deno.env.get("PBM_EMAIL_FROM") ?? "Play Book Matrix <alerts@playbookmatrix.com>";
const LOGO = Deno.env.get("PBM_EMAIL_LOGO") ?? "https://playbookmatrix.com/email-logo.png";
const KINDS = ["early_edge", "line_moves", "weekly_briefing", "auto_bets", "system", "test"];   // system = watchdog (health + security), always on

export function layout(title: string, bodyHtml: string) {
  return `<!doctype html><html><body style="margin:0;background:#0b1220;font-family:Arial,Helvetica,sans-serif;color:#e5e7eb">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0b1220;padding:24px 0"><tr><td align="center">
  <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#111a2e;border-radius:12px;border:1px solid #1f2a44">
  <tr><td align="center" style="padding:18px 24px 14px;border-bottom:1px solid #1f2a44;background:#000000;border-radius:12px 12px 0 0">
  <a href="https://playbookmatrix.com" style="text-decoration:none"><img src="cid:pbm-logo" width="200" alt="PLAY BOOK MATRIX"
  style="display:block;width:200px;max-width:70%;height:auto;border:0;color:#22d3ee;font-size:16px;letter-spacing:2px;font-weight:bold"></a></td></tr>
  <tr><td style="padding:24px"><h1 style="margin:0 0 12px;font-size:20px;color:#ffffff">${title}</h1>
  <div style="font-size:15px;line-height:1.55;color:#cbd5e1">${bodyHtml}</div></td></tr>
  <tr><td style="padding:16px 24px;border-top:1px solid #1f2a44;font-size:12px;color:#64748b">
  Sent by the SI Agent at playbookmatrix.com · Nothing is bet unless you place it yourself or you switched on the Auto Better.
  You can turn these emails off in the app's alert settings.</td></tr></table></td></tr></table></body></html>`;
}

async function sendOne(to: string, subject: string, html: string, replyTo?: string) {
  const key = Deno.env.get("RESEND_API_KEY");
  if (!key) throw new Error("RESEND_API_KEY secret is not set");
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    // logo is embedded in the email (Content-ID) so Outlook / Microsoft 365 shows it without "download pictures"
    body: JSON.stringify({ from: FROM, to: [to], subject, html, ...(replyTo ? { reply_to: replyTo } : {}),
      ...(html.includes("cid:pbm-logo") ? { attachments: [{ path: LOGO, filename: "playbookmatrix-logo.png", content_id: "pbm-logo" }] } : {}) }),
  });
  const d = await r.json().catch(() => ({}));
  return { ok: r.ok, id: d?.id ?? null, error: r.ok ? null : `${r.status} ${JSON.stringify(d).slice(0, 200)}` };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  let body: any = {}; try { body = await req.json(); } catch { /* empty */ }
  const cronTok = req.headers.get("x-pbm-cron");
  let userId: string | null = null, userEmail: string | null = null;
  if (cronTok) {
    const { data: cfg } = await sb.from("private_config").select("value").eq("key", "cron_token").single();
    if (!cfg || cfg.value !== cronTok) return json({ ok: false, error: "not authorized" }, 401);
  } else {
    const { data: u } = await sb.auth.getUser((req.headers.get("Authorization") ?? "").replace("Bearer ", ""));
    if (!u?.user) return json({ ok: false, error: "sign in required" }, 401);
    userId = u.user.id; userEmail = u.user.email ?? null;
  }
  try {
    // Recipients
    let recipients: { user_id: string; email: string }[] = [];
    // 2026-10-12 invite: sign-up instructions to someone on the members list (system only, never any other address)
    if (body.action === "invite") {
      if (!cronTok) return json({ ok: false, error: "only the system can send invites" }, 403);
      const to = String(body.email ?? "").toLowerCase().trim();
      const { data: m } = await sb.from("app_members").select("email,user_id,role").eq("email", to).maybeSingle();
      if (!m) return json({ ok: false, error: "not on the members list" }, 400);
      const subject = String(body.subject ?? "Your Play Book Matrix login").slice(0, 150);
      const html = layout(String(body.title ?? subject), String(body.html ?? ""));
      const s = await sendOne(m.email, subject, html, String(body.reply_to ?? "michael@it365live.com"));
      await sb.from("email_log").insert({ user_id: m.user_id, to_email: m.email, kind: "invite", subject, status: s.ok ? "sent" : "failed", provider_id: s.id, error: s.error });
      return json({ ok: s.ok, to: m.email, id: s.id, error: s.error });
    }
    if (body.action === "test" && userId && userEmail) recipients = [{ user_id: userId, email: userEmail }];
    else if (body.action === "send" || body.action === "test") {
      if (!cronTok) return json({ ok: false, error: "only the system can send alerts" }, 403);
      const kind = KINDS.includes(body.kind) ? body.kind : "test";
      let q = sb.from("alert_settings").select("user_id,email,enabled,early_edge,line_moves,weekly_briefing,auto_bets").eq("enabled", true);
      if (body.user_id) q = q.eq("user_id", body.user_id);
      const { data } = await q;
      recipients = (data ?? []).filter((r: any) => kind === "test" || kind === "system" || r[kind] === true);
    } else return json({ ok: false, error: "unknown action" }, 400);

    const kind = body.action === "test" ? "test" : body.kind;
    const subject = body.action === "test" ? "✅ Play Book Matrix alerts are working" : String(body.subject ?? "Play Book Matrix alert").slice(0, 150);
    const html = body.action === "test"
      ? layout("Your alerts are set up", `This is a test from the SI Agent. When the Early Edge module spots a bet worth making
         <b>before</b> the market catches up, you'll get an email like this with the game, the bet, why, and the time window.<br><br>
         Sent ${new Date().toLocaleString("en-US", { timeZone: "America/New_York" })} ET.`)
      : (body.raw_html ? String(body.html) : layout(String(body.title ?? subject), String(body.html ?? "")));
    const results = [];
    for (const r of recipients) {
      const s = await sendOne(r.email, subject, html, r.email);
      await sb.from("email_log").insert({ user_id: r.user_id, to_email: r.email, kind, subject, status: s.ok ? "sent" : "failed", provider_id: s.id, error: s.error });
      results.push({ to: r.email, ...s });
    }
    return json({ ok: results.every((r) => r.ok), sent: results.filter((r) => r.ok).length, results });
  } catch (e) {
    return json({ ok: false, error: String(e instanceof Error ? e.message : e) }, 500);
  }
});
