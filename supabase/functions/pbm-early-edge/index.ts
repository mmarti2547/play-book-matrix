// ===== SUPABASE EDGE FUNCTION: pbm-early-edge =====
// Early Edge live signals (from the 2026-09-28 study). Run every 15 min by the schedule with the cron token.
//  1) Kalshi vs Vegas gap scan (SQL: ee_detect_kalshi_gap)
//  2) Starting-QB injury check from ESPN's public injury lists (every 30 min)
//  3) One email per run listing any new signals (alert_settings.early_edge)
// It never places bets. The Auto Trader (pbm-kalshi) acts on bettable signals only if the user switched Early Edge on.
import { createClient } from "npm:@supabase/supabase-js@2";
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-pbm-cron" };
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const ESPN = "https://site.web.api.espn.com/apis/site/v2/sports/football/nfl";
const H = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36",
            "Accept": "application/json", "Accept-Language": "en-US,en;q=0.9", "Referer": "https://www.espn.com/" };
const FIX: Record<string, string> = { WSH: "WAS", LAR: "LA" };   // ESPN -> Play Book Matrix team codes
const OUT = ["out", "doubtful", "injured reserve", "suspension", "physically unable to perform", "reserve"];
const WATCH = ["questionable", "day-to-day"];
const nm = (s: string) => String(s ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
  .replace(/[.'’]/g, "").replace(/\s+(jr|sr|ii|iii|iv|v)$/, "").replace(/\s+/g, " ").trim();
const sameName = (a: string, b: string) => {
  const x = nm(a), y = nm(b); if (!x || !y) return false; if (x === y) return true;
  const [xf, ...xl] = x.split(" "), [yf, ...yl] = y.split(" ");
  return xl.join(" ") === yl.join(" ") && xf[0] === yf[0];          // "Cam Ward" vs "Cameron Ward"
};
const etTime = (iso: string) => new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) + " ET";

async function espn(path: string) {
  const r = await fetch(`${ESPN}${path}`, { headers: H });
  if (!r.ok) throw new Error(`ESPN ${r.status} ${path}`);
  return await r.json();
}

async function qbCheck(sb: any) {
  const runStart = new Date().toISOString();
  const now = Date.now();
  const { data: games } = await sb.from("games").select("game_id,season,week,game_type,home_team,away_team,kickoff_utc,home_qb,away_qb")
    .gt("kickoff_utc", new Date(now + 24 * 3600e3).toISOString()).lt("kickoff_utc", new Date(now + 8 * 864e5).toISOString());
  if (!games?.length) return { games: 0 };
  const season = games[0].season;
  // starting QB = the QB listed for the team's most recent game BEFORE this one (finished, live or tonight).
  // A QB who already missed that game is old news the market has priced, so he does not count.
  const { data: past } = await sb.from("games").select("home_team,away_team,home_qb,away_qb,kickoff_utc").eq("season", season)
    .order("kickoff_utc", { ascending: false }).limit(600);
  const starter = (team: string, before: string, fallback: string | null) => {
    const p = (past ?? []).find((x: any) => (x.home_team === team || x.away_team === team) && new Date(x.kickoff_utc) < new Date(before));
    return p ? (p.home_team === team ? p.home_qb : p.away_qb) : fallback;
  };
  // ESPN events for the weeks involved
  const events: any[] = [];
  for (const w of [...new Set(games.map((g: any) => `${g.season}|${g.week}|${g.game_type === "REG" ? 2 : 3}`))]) {
    const [y, wk, st] = (w as string).split("|");
    const d = await espn(`/scoreboard?week=${wk}&seasontype=${st}&year=${y}`);
    events.push(...(d.events ?? []));
  }
  const found: any[] = [];
  for (const g of games) {
    const e = events.find((ev: any) => {
      const cs = ev.competitions?.[0]?.competitors ?? [];
      const code = (side: string) => { const a = String(cs.find((c: any) => c.homeAway === side)?.team?.abbreviation ?? ""); return FIX[a] ?? a; };
      return code("home") === g.home_team && code("away") === g.away_team;
    });
    if (!e) continue;
    const sum = await espn(`/summary?event=${e.id}`);
    for (const side of ["home", "away"]) {
      const team = side === "home" ? g.home_team : g.away_team, opp = side === "home" ? g.away_team : g.home_team;
      const qb = starter(team, g.kickoff_utc, side === "home" ? g.home_qb : g.away_qb);
      if (!qb) continue;
      const list = (sum.injuries ?? []).find((t: any) => (FIX[t.team?.abbreviation] ?? t.team?.abbreviation) === team)?.injuries ?? [];
      const hit = list.find((i: any) => (i.athlete?.position?.abbreviation ?? "QB") === "QB" && sameName(i.athlete?.displayName, qb));
      if (!hit) continue;
      const status = String(hit.status ?? hit.type?.description ?? "").trim();
      const s = status.toLowerCase();
      const kind = OUT.some((o) => s.includes(o)) ? "qb_out" : WATCH.some((o) => s.includes(o)) ? "qb_watch" : null;
      if (!kind) continue;
      // market context: has Vegas already moved against the team? is Kalshi still at or below Vegas for the opponent?
      const { data: lc } = await sb.rpc("ee_line_context", { p_game_id: g.game_id });
      const v = lc?.[0] ?? {};
      const k = side === "home" ? 1 : -1;
      const moved = v.home_spread_now != null && v.home_spread_early != null ? k * (Number(v.home_spread_now) - Number(v.home_spread_early)) : null;
      // The bet: the OPPONENT against the spread at the Kalshi line closest to the current Vegas number
      // (that is what the study tested). Falls back to the straight-up win market if there is no spread ladder.
      const hs = v.home_spread_now != null ? Number(v.home_spread_now) : null;          // home handicap (negative = home favored)
      const oppHcp = hs == null ? null : (opp === g.home_team ? hs : -hs);              // opponent handicap
      const { data: ladder } = await sb.from("kalshi_alt_lines").select("ticker,team,threshold,yes_bid,yes_ask,fetched_at")
        .eq("game_id", g.game_id).gt("fetched_at", new Date(now - 60 * 60e3).toISOString());
      const nearest = (rows: any[], L: number, preferBelow: boolean) => rows.map((x) => ({ ...x, thr: Number(x.threshold) }))
        .sort((a, b) => Math.abs(a.thr - L) - Math.abs(b.thr - L) || (preferBelow ? a.thr - b.thr : b.thr - a.thr))[0];
      let pick: any = null;
      if (oppHcp != null && oppHcp < 0) {                     // opponent favored by L: buy YES "opp wins by over thr"
        const L = -oppHcp, x = nearest((ladder ?? []).filter((r: any) => r.team === opp && Number(r.yes_ask) > 0), L, true);
        if (x) pick = { ticker: x.ticker, side: "yes", price: Number(x.yes_ask), line: -x.thr, fair: 0.5 + 0.03 * (L - x.thr),
                        label: `${opp} -${x.thr} (win by ${x.thr + 0.5}+)` };
      } else if (oppHcp != null && oppHcp > 0) {              // opponent is the underdog getting L: buy NO on "fade team wins by over thr"
        const L = oppHcp, x = nearest((ladder ?? []).filter((r: any) => r.team === team && Number(r.yes_bid) > 0), L, false);
        if (x) pick = { ticker: x.ticker, side: "no", price: Math.round((1 - Number(x.yes_bid)) * 100) / 100, line: x.thr, fair: 0.5 + 0.03 * (x.thr - L),
                        label: `${opp} +${x.thr} (${team} does NOT win by ${x.thr + 0.5}+)` };
      }
      if (!pick) {                                            // pick'em or no spread ladder: straight-up win
        const { data: km } = await sb.from("kalshi_markets").select("*").eq("game_id", g.game_id).maybeSingle();
        const vpw = v.home_prob_now != null ? (side === "home" ? 1 - Number(v.home_prob_now) : Number(v.home_prob_now)) : null;
        if (km) pick = { ticker: side === "home" ? km.away_ticker : km.home_ticker, side: "yes", line: null,
                         price: Number(side === "home" ? km.away_yes_ask : km.home_yes_ask), fair: vpw, label: `${opp} to win` };
      }
      const maxPrice = pick?.fair != null ? Math.round(Math.min(0.9, pick.fair + (pick.line != null ? 0.03 : 0.02)) * 100) / 100 : null;
      const hrs = (new Date(g.kickoff_utc).getTime() - now) / 3600e3;
      const reasons: string[] = [];
      if (kind !== "qb_out") reasons.push("only questionable so far, watching");
      if (hrs < 48) reasons.push("less than 2 days to kickoff");
      if (moved != null && moved >= 1.5) reasons.push(`Vegas already moved ${moved.toFixed(1)} pts against ${team}`);
      if (!pick || !(pick.price >= 0.1 && pick.price <= 0.9)) reasons.push("no usable Kalshi price");
      else if (maxPrice != null && pick.price > maxPrice) reasons.push(`Kalshi already priced it (${Math.round(pick.price * 100)}¢, fair about ${Math.round(pick.fair * 100)}¢)`);
      const bettable = reasons.length === 0;
      const row = {
        kind, game_id: g.game_id, bet_team: opp, fade_team: team, ticker: pick?.ticker ?? null, bet_side: pick?.side ?? "yes",
        bet_label: pick?.label ?? `${opp} to win`, bet_line: pick?.line ?? null, max_price: maxPrice,
        price: pick?.price ?? null, vegas_prob: pick?.fair != null ? Math.round(pick.fair * 10000) / 10000 : null,
        gap_pts: pick?.fair != null && pick?.price != null ? Math.round(1000 * (pick.fair - pick.price)) / 10 : null,
        player: qb, player_status: status, line_now: v.home_spread_now ?? null, line_early: v.home_spread_early ?? null,
        line_moved_pts: moved, bettable, active: true, kickoff_utc: g.kickoff_utc, last_seen_at: new Date().toISOString(),
        note: bettable ? `${qb} (${team} QB) is ${status}. Bet ${pick.label} before the line adjusts.` : `${qb} (${team} QB) is ${status}. Not a bet: ${reasons.join("; ")}.`,
      };
      const { error } = await sb.from("ee_signals").upsert(row, { onConflict: "kind,game_id,bet_team" });
      if (error) throw new Error("ee_signals: " + error.message);
      found.push({ game: g.game_id, qb, status, kind, bettable });
    }
  }
  // QB no longer on the list -> signal off
  await sb.from("ee_signals").update({ active: false }).in("kind", ["qb_out", "qb_watch"]).eq("active", true).lt("last_seen_at", runStart);
  return { games: games.length, events: events.length, found };
}

async function notify(sb: any, cronTok: string) {
  const { data: sigs } = await sb.from("ee_signals").select("*").is("emailed_at", null).eq("active", true).order("detected_at");
  if (!sigs?.length) return { emailed: 0 };
  const { data: gms } = await sb.from("games").select("game_id,home_team,away_team,kickoff_utc").in("game_id", [...new Set(sigs.map((s: any) => s.game_id))]);
  const gi = (id: string) => (gms ?? []).find((g: any) => g.game_id === id);
  const label: Record<string, string> = { kalshi_gap: "Kalshi below Vegas", qb_out: "Starting QB out", qb_watch: "QB questionable (watch only)" };
  const conf: Record<string, string> = { kalshi_gap: "Lean", qb_out: "Moderate", qb_watch: "Watch" };
  // one clear verdict per alert: BET NOW / PASS / WATCH
  const verdict = (s: any) => {
    const g = gi(s.game_id);
    const vp = s.vegas_prob != null ? Number(s.vegas_prob) : null;
    const cents = (x: number) => `${Math.round(x * 100)}¢`;
    if (s.kind === "qb_watch") return { tag: "WATCH", color: "#94a3b8", subject: `WATCH ${s.fade_team}`,
      line: `No bet yet. ${s.player} is only questionable. You'll get another email if he's ruled out.` };
    if (!s.bettable) return { tag: "PASS", color: "#fbbf24", subject: `PASS ${s.bet_team}`,
      line: `Don't bet this one: ${String(s.note ?? "").replace(/^.*Not a bet: /, "").replace(/\.$/, "")}.` };
    const stake = s.kind === "qb_out" ? 25 : 10;
    const maxPrice = s.max_price != null ? Number(s.max_price) : s.kind === "qb_out" ? Math.min(0.9, (vp ?? Number(s.price)) + 0.02) : (vp ?? Number(s.price)) - 0.02;
    const by = s.kind === "qb_out"
      ? (() => { const k = g ? new Date(g.kickoff_utc) : null; if (!k) return "before Thursday"; const d = new Date(k.getTime() - 72 * 3600e3);
          return "by " + d.toLocaleString("en-US", { timeZone: "America/New_York", weekday: "long" }) + " night (most of the line move happens Mon–Thu)"; })()
      : "within the next 6 hours (about half of these gaps close by then)";
    return { tag: "BET NOW", color: "#34d399", subject: `BET NOW: ${s.bet_label ?? s.bet_team + " to win"}`,
      line: `<b>Buy ${s.bet_label ?? s.bet_team + " to win"} on Kalshi</b> - now ${cents(Number(s.price))}, pay no more than <b>${cents(maxPrice)}</b>. Suggested stake <b>$${stake}</b>. Do it ${by}.` };
  };
  const order = (t: string) => (t === "BET NOW" ? 0 : t === "PASS" ? 1 : 2);
  const vs = sigs.map((s: any) => ({ s, v: verdict(s) })).sort((a: any, b: any) => order(a.v.tag) - order(b.v.tag));
  const items = vs.map(({ s, v }: any) => {
    const g = gi(s.game_id);
    const price = s.price != null ? `${Math.round(Number(s.price) * 100)}¢` : "-";
    const vp = s.vegas_prob != null ? `${(Number(s.vegas_prob) * 100).toFixed(1)}%` : "-";
    return `<div style="margin:0 0 14px;padding:12px;border:1px solid #1f2a44;border-left:6px solid ${v.color};border-radius:8px">
      <div style="font-size:22px;font-weight:bold;color:${v.color};letter-spacing:1px">${v.tag}</div>
      <div style="font-size:16px;color:#fff;margin:4px 0"><b>${g ? `${g.away_team} @ ${g.home_team}` : s.game_id}</b> · ${g ? etTime(g.kickoff_utc) : ""}</div>
      <div style="margin:6px 0;color:#fff">${v.line}</div>
      <div style="font-size:13px;color:#94a3b8">Why: ${s.player ? `${s.player} (${s.fade_team} QB) is ${s.player_status}. ` : ""}${s.kind !== "qb_watch" ? `Kalshi ${price} vs fair ${vp} for ${s.bet_label ?? s.bet_team}.` : ""}
      Signal: ${label[s.kind] ?? s.kind} · confidence ${conf[s.kind] ?? ""}</div></div>`;
  }).join("");
  const window = `<div style="font-size:13px;color:#94a3b8">Why the timing matters: in 6 years of lines, QB-out moves happen Monday–Thursday (almost none on game day), and Kalshi-vs-Vegas gaps are about half gone within 6 hours.
     If your Auto Trader has Early Edge switched on, bettable alerts are placed automatically at $10 (Kalshi gap) or $25 (QB out) inside your weekly cap.</div>`;
  const subject = "Early Edge: " + vs.map((x: any) => x.v.subject).join(" · ");
  const r = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/pbm-email`, { method: "POST",
    headers: { "Content-Type": "application/json", "x-pbm-cron": cronTok },
    body: JSON.stringify({ action: "send", kind: "early_edge", subject, title: "Early Edge alert", html: items + window }) });
  const res = await r.json().catch(() => ({}));
  await sb.from("ee_signals").update({ emailed_at: new Date().toISOString() }).in("id", sigs.map((s: any) => s.id));
  return { emailed: sigs.length, email: res };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const tok = req.headers.get("x-pbm-cron");
  const { data: cfg } = await sb.from("private_config").select("value").eq("key", "cron_token").single();
  if (!tok || !cfg || cfg.value !== tok) return json({ ok: false, error: "not authorized" }, 401);
  let body: any = {}; try { body = await req.json(); } catch { /* empty */ }
  const out: any = {};
  try {
    const { data: gap, error: ge } = await sb.rpc("ee_detect_kalshi_gap");
    out.kalshi_gap = ge ? { error: ge.message } : gap;
    const m = new Date().getUTCMinutes();
    if (body.qb === true || (body.qb !== false && m % 30 < 15)) {
      try { out.qb = await qbCheck(sb); } catch (e) { out.qb = { error: String(e) }; }
    }
    if (body.notify !== false) out.notify = await notify(sb, tok);
    return json({ ok: true, ...out });
  } catch (e) {
    return json({ ok: false, error: String(e instanceof Error ? e.message : e), ...out }, 500);
  }
});
