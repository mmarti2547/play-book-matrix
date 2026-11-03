// ===== SUPABASE EDGE FUNCTION: pbm-watchdog =====
// Watchdog for Play Book Matrix. Runs every 15 minutes (pg_cron, x-pbm-cron header). It:
//  1) re-runs the engine ONCE by itself when the last GitHub engine run failed,
//  2) checks health (scheduled jobs, Kalshi prices/account checks, emails, function errors, Auto Trader errors, engine),
//  3) checks security (new device/location sign-in, password/email/authenticator changes, new accounts,
//     Kalshi orders the app did not place),
//  4) emails ONLY when a health problem is still there after 30 minutes (reminder every 6 hours, and a "fixed" note),
//     and right away for security events. It never places, cancels or moves anything.
// Body: {} normal run · { dry_run:true } report only (no emails, no retry) · { baseline:true } accept current Kalshi orders as known.
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-pbm-cron" };
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const PERSIST_MIN = 30;        // a health problem must last this long before an email
const REMIND_HOURS = 6;        // reminder while it is still broken
const esc = (s: unknown) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));
const et = (d: Date) => d.toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "2-digit" }) + " ET";

type Issue = { key: string; kind: "health" | "security"; title: string; detail: string; urgent?: boolean };   // urgent = email right away

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const URL_ = Deno.env.get("SUPABASE_URL")!;
  const sb = createClient(URL_, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const cronTok = req.headers.get("x-pbm-cron") ?? "";
  const { data: cfg } = await sb.from("private_config").select("value").eq("key", "cron_token").single();
  if (!cfg || !cronTok || cfg.value !== cronTok) return json({ ok: false, error: "not authorized" }, 401);
  const body = await req.json().catch(() => ({}));
  const dry = body.dry_run === true;
  const call = async (fn: string, payload: unknown) => {
    try {
      const r = await fetch(`${URL_}/functions/v1/${fn}`, { method: "POST",
        headers: { "Content-Type": "application/json", "x-pbm-cron": cronTok }, body: JSON.stringify(payload),
        signal: AbortSignal.timeout(60000) });
      const d = await r.json().catch(() => ({}));
      return { ok: r.ok, status: r.status, data: d };
    } catch (e) { return { ok: false, status: 0, data: { error: String(e) } }; }
  };
  const getState = async (k: string) => (await sb.from("watchdog_state").select("value").eq("key", k).maybeSingle()).data?.value ?? null;
  const setState = async (k: string, v: unknown) => { if (!dry) await sb.from("watchdog_state").upsert({ key: k, value: v, updated_at: new Date().toISOString() }); };

  const issues: Issue[] = [];
  const notes: string[] = [];

  // ---- 1) health checks in the database
  const { data: h, error: he } = await sb.rpc("pbm_watchdog_health");
  if (he) issues.push({ key: "watchdog:health", kind: "health", title: "Watchdog health check failed", detail: he.message });
  for (const x of h ?? []) issues.push({ key: x.key, kind: "health", title: x.title, detail: x.detail });

  // ---- 2) engine: last GitHub run — retry once by itself, alert if the retry also fails
  const st = await call("pbm-engine-trigger", { action: "status" });
  const run = st.data?.run;
  if (!st.ok) issues.push({ key: "engine:status", kind: "health", title: "Can't check the engine",
    detail: `The engine status check answered ${st.status}: ${esc(JSON.stringify(st.data).slice(0, 200))}` });
  else if (run) {
    const rs = (await getState("engine_retry")) ?? { retries: 0 };
    const failed = run.status === "completed" && ["failure", "timed_out", "startup_failure", "cancelled"].includes(run.conclusion);
    if (run.status === "completed" && run.conclusion === "success") { if (rs.retries) await setState("engine_retry", { retries: 0 }); }
    else if (failed) {
      if ((rs.retries ?? 0) < 1 && rs.failed_url !== run.url) {
        if (!dry) {
          const r = await call("pbm-engine-trigger", { action: "run" });
          notes.push(`Engine run failed (${run.conclusion}); re-ran it automatically: ${r.ok ? "started" : "could not start"}.`);
          await setState("engine_retry", { retries: (rs.retries ?? 0) + 1, failed_url: run.url, at: new Date().toISOString() });
        } else notes.push(`Engine run failed (${run.conclusion}); would re-run it.`);
      } else issues.push({ key: "engine:failed", kind: "health", title: "Engine run failed (automatic re-run also failed)",
        detail: `Last run: ${run.conclusion} at ${et(new Date(run.updated_at))}. Picks may be out of date. Run log: <a href="${esc(run.url)}">${esc(run.url)}</a>` });
    } else if (["in_progress", "queued"].includes(run.status) && Date.now() - new Date(run.started_at).getTime() > 90 * 60e3) {
      issues.push({ key: "engine:stuck", kind: "health", title: "Engine run is stuck",
        detail: `Started ${et(new Date(run.started_at))} and still ${run.status}. <a href="${esc(run.url)}">Run log</a>` });
    }
  }

  // ---- 2b) 2026-10-05: stalled injury checks. The Auto Trader only bets a game once its injury check ran AFTER inactives
  //      (kickoff - 90 min). 10+ min after inactives with no fresh check -> re-run it now; 30+ min -> also email right away.
  {
    const nowMs = Date.now();
    const { data: soon } = await sb.from("games").select("game_id,away_team,home_team,kickoff_utc").is("home_score", null)
      .gt("kickoff_utc", new Date(nowMs).toISOString()).lt("kickoff_utc", new Date(nowMs + 80 * 60e3).toISOString());
    const ids = (soon ?? []).map((g: any) => g.game_id);
    const { data: intel } = ids.length ? await sb.from("news_intel").select("game_id,scanned_at").in("game_id", ids) : { data: [] };
    const last: Record<string, number> = {};
    for (const r of intel ?? []) last[r.game_id] = new Date(r.scanned_at).getTime();
    const stale = (soon ?? []).filter((g: any) => { const ina = new Date(g.kickoff_utc).getTime() - 90 * 60e3; return !(last[g.game_id] >= ina); });
    if (stale.length) {
      if (!dry) {
        const r = await call("pbm-engine-trigger", { action: "news" });
        notes.push(`Injury check had not run after inactives for ${stale.map((g: any) => `${g.away_team} @ ${g.home_team}`).join(", ")}; re-ran it automatically: ${r.ok ? "started" : "could not start"}.`);
      } else notes.push(`Would re-run the injury check for ${stale.length} game(s).`);
      for (const g of stale) {
        const ina = new Date(g.kickoff_utc).getTime() - 90 * 60e3;
        if (nowMs - ina < 30 * 60e3) continue;
        issues.push({ key: `news:stale:${g.game_id}`, kind: "health", urgent: true, title: `Injury check stalled: ${g.away_team} @ ${g.home_team}`,
          detail: `Kickoff ${et(new Date(g.kickoff_utc))}. The injury check has not run since inactives (${et(new Date(ina))})` +
            `${last[g.game_id] ? `; last check ${et(new Date(last[g.game_id]))}` : ""}. The Auto Trader will NOT bet this game until it does. ` +
            `The watchdog re-ran it automatically. If this is a pick, you can place it from the Bet Slip.` });
      }
    }
  }

  // ---- 3) security events (database: sign-ins, password/email/authenticator, new accounts)
  if (!dry) {
    const { data: s, error: se } = await sb.rpc("pbm_watchdog_security");
    if (se) issues.push({ key: "watchdog:security", kind: "health", title: "Watchdog security check failed", detail: se.message });
    for (const x of s ?? []) issues.push({ key: x.key, kind: "security", title: x.title, detail: x.detail });
  }

  // ---- 4) Kalshi: connection + orders the app did not place
  const au = await call("pbm-kalshi", { action: "audit_orders", hours: 26 });
  if (!au.ok || au.data?.ok === false) issues.push({ key: "kalshi:connection", kind: "health", title: "Can't reach your Kalshi account",
    detail: `Kalshi check failed: ${esc(String(au.data?.error ?? au.status)).slice(0, 200)}. The Auto Trader can't bet or settle until this works.` });
  else for (const o of au.data?.unknown ?? []) {
    let k = `sec:order:${o.order_id}`;
    // PBM's own 1¢ location test (pbm-location-check marks it): label it, and email about those at most once a day
    const { data: lt } = await sb.from("watchdog_alerts").select("key").eq("key", `loctest:${o.order_id}`).maybeSingle();
    const isTest = !!lt;
    if (isTest) k = `sec:loctest:${new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" })}`;
    if (body.baseline === true) { if (!dry) await sb.from("watchdog_alerts").upsert({ key: k, kind: "security", title: "known order (baseline)", detail: o.ticker, resolved_at: new Date().toISOString() }); continue; }
    // 2026-11-03 full bet details: market name (Kalshi public market data, no keys), what was bought, price, cost
    let what = "", event = "";
    try {
      const mr = await fetch(`https://api.elections.kalshi.com/trade-api/v2/markets/${encodeURIComponent(o.ticker)}`, { signal: AbortSignal.timeout(8000) });
      const m = (await mr.json())?.market;
      if (m) {
        what = String(m.yes_sub_title || m.subtitle || m.title || "");
        const er = await fetch(`https://api.elections.kalshi.com/trade-api/v2/events/${encodeURIComponent(m.event_ticker)}`, { signal: AbortSignal.timeout(8000) });
        event = String((await er.json())?.event?.title ?? m.title ?? "");
      }
    } catch { /* details are a nice-to-have */ }
    const side = String(o.side ?? "").toLowerCase();
    const sideTxt = side === "no" ? "NO" : "YES";
    const yesPx = o.price != null ? Number(o.price) > 1 ? Number(o.price) / 100 : Number(o.price) : null;
    const px = yesPx == null ? null : side === "no" ? 1 - yesPx : yesPx;
    const n = Number(o.contracts) || 0;
    const cost = px != null && n ? n * px : null;
    const st = String(o.status ?? "");
    const stTxt = /cancel/i.test(st) ? "canceled - nothing bought" : /resting|open/i.test(st) ? "still waiting to fill" : /exec|fill/i.test(st) ? "FILLED" : st;
    const row = (a: string, b: string) => `<tr><td style="color:#94a3b8;padding:2px 10px 2px 0">${a}</td><td style="color:#fff">${b}</td></tr>`;
    if (isTest && issues.some((i) => i.key === k)) continue;
    issues.push({ key: k, kind: "security", title: isTest ? "Test order to keep Kalshi alive" : "Kalshi order the app did not place",
      detail: `<table style="border-collapse:collapse;margin:4px 0 8px">` +
        (event ? row("Market", esc(event)) : "") +
        row("Bet", `${esc(String(o.action ?? "buy")).toUpperCase()} ${sideTxt}${what ? ` on <b>${esc(what)}</b>` : ""}`) +
        row("Contracts", n ? String(n) : "?") +
        (px != null ? row("Price", `${Math.round(px * 100)}¢ each`) : "") +
        (cost != null ? row("Cost", `$${cost.toFixed(2)}`) : "") +
        (cost != null && n ? row("Profit if it wins", `$${(n - cost).toFixed(2)}`) : "") +
        row("Status", esc(stTxt)) +
        row("Placed", o.at ? et(new Date(o.at)) : "?") +
        row("Ticker", `<span style="color:#94a3b8">${esc(o.ticker)}</span>`) +
        `</table>` + (isTest
          ? `This is Play Book Matrix's own 1¢ test order that checks your Kalshi location is still verified. It is not a bet and nothing to do. (You get this note at most once a day.)`
          : `If you placed this yourself on Kalshi, ignore this. If not, change your Kalshi password and API key right away.`) });
  }

  // ---- 4b) where is that IP? (city, region, country, internet provider, VPN/proxy flag) for sign-in alerts
  for (const i of issues) {
    if (!i.key.startsWith("sec:session:")) continue;
    const ip = i.detail.match(/from IP ([0-9a-fA-F.:]+)/)?.[1];
    if (!ip) continue;
    try {
      const r = await fetch(`http://ip-api.com/json/${ip}?fields=status,country,regionName,city,isp,org,proxy,hosting,mobile`, { signal: AbortSignal.timeout(8000) });
      const g = await r.json();
      if (g?.status === "success") {
        const kind = g.proxy ? "VPN / proxy service" : g.hosting ? "data center / hosting company" : g.mobile ? "mobile carrier" : "home or business internet";
        i.detail += `<br><b>Location:</b> ${esc([g.city, g.regionName, g.country].filter(Boolean).join(", "))} · <b>Provider:</b> ${esc(g.org || g.isp || "?")} (${kind}).`;
        if (g.proxy || g.hosting) i.detail += ` A VPN's location is the VPN server, not where the person really is. If you don't use a VPN, tell Claude to sign out every session, then change your password.`;
      }
    } catch { /* location is a nice-to-have */ }
  }

  if (dry) return json({ ok: true, dry_run: true, issues, notes });

  // ---- 5) remember issues, decide what to email
  const now = new Date();
  const { data: rows } = await sb.from("watchdog_alerts").select("*");
  const byKey = new Map((rows ?? []).map((r: any) => [r.key, r]));
  const toEmail: Issue[] = [], fixed: any[] = [];
  const current = new Set(issues.map((i) => i.key));
  for (const i of issues) {
    const r: any = byKey.get(i.key);
    if (i.kind === "security") {
      if (r) continue;                       // already reported once
      toEmail.push(i);
      await sb.from("watchdog_alerts").insert({ key: i.key, kind: i.kind, title: i.title, detail: i.detail, last_emailed: now.toISOString(),
        times_emailed: 1, resolved_at: now.toISOString() });
      continue;
    }
    const open = r && !r.resolved_at;
    const first = open ? new Date(r.first_seen) : now;
    const due = (i.urgent || now.getTime() - first.getTime() >= PERSIST_MIN * 60e3) &&
      (!open || !r.last_emailed || now.getTime() - new Date(r.last_emailed).getTime() >= REMIND_HOURS * 3600e3);
    if (due) toEmail.push(i);
    await sb.from("watchdog_alerts").upsert({ key: i.key, kind: i.kind, title: i.title, detail: i.detail,
      first_seen: first.toISOString(), last_seen: now.toISOString(), resolved_at: null,
      last_emailed: due ? now.toISOString() : (open ? r.last_emailed : null),
      times_emailed: (open ? r.times_emailed ?? 0 : 0) + (due ? 1 : 0) });
  }
  for (const r of rows ?? []) {
    if (r.kind !== "health" || r.resolved_at || current.has(r.key)) continue;
    await sb.from("watchdog_alerts").update({ resolved_at: now.toISOString() }).eq("key", r.key);
    if (r.last_emailed) fixed.push(r);
  }

  // ---- 6) one email per run, only if there is something to say
  let emailed = false;
  if (toEmail.length || fixed.length) {
    const sec = toEmail.filter((i) => i.kind === "security"), hl = toEmail.filter((i) => i.kind === "health");
    const block = (i: Issue) => `<div style="margin:0 0 14px;padding:10px 12px;border-left:3px solid ${i.kind === "security" ? "#f43f5e" : "#f59e0b"};background:#0b1220">
      <b style="color:#fff">${esc(i.title)}</b><br><span>${i.detail}</span></div>`;
    let html = "";
    if (sec.length) html += `<p style="color:#fda4af"><b>Security</b></p>${sec.map(block).join("")}`;
    if (hl.length) html += `<p style="color:#fcd34d"><b>Still broken</b> (checked for at least ${PERSIST_MIN} minutes)</p>${hl.map(block).join("")}`;
    if (notes.length) html += `<p>${notes.map(esc).join("<br>")}</p>`;
    if (fixed.length) html += `<p style="color:#86efac"><b>Fixed</b></p><ul>${fixed.map((r: any) => `<li>${esc(r.title)}</li>`).join("")}</ul>`;
    html += `<p style="font-size:13px;color:#94a3b8">Checked ${et(now)}. You can ask Claude to look into any of these.</p>`;
    const subject = sec.length ? `🔒 Security alert: ${sec[0].title}${sec.length > 1 ? ` (+${sec.length - 1} more)` : ""}`
      : hl.length ? `⚠️ Play Book Matrix: ${hl.length === 1 ? hl[0].title : `${hl.length} problems need attention`}`
      : `✅ Fixed: ${fixed.length === 1 ? fixed[0].title : `${fixed.length} problems cleared`}`;
    const r = await call("pbm-email", { action: "send", kind: "system", subject, title: sec.length ? "Security alert" : hl.length ? "System watchdog" : "All clear again", html });
    emailed = r.ok && r.data?.ok !== false;
  }
  await setState("last_run", { at: now.toISOString(), open: issues.filter((i) => i.kind === "health").map((i) => i.key),
    emailed, notes, kalshi_checked: au.data?.checked ?? null });
  return json({ ok: true, issues: issues.length, emailed, sent: toEmail.map((i) => i.key), fixed: fixed.map((r: any) => r.key), notes });
});
