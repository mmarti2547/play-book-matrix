===== LOVABLE PROMPT =====
Build "Play Book Matrix" — an NFL game analysis and betting-intelligence dashboard. Dark theme, sportsbook-terminal feel (near-black background, green for positive edge, red for negative, amber for risk). Desktop-first but fully usable on a phone.

BACKEND: Use my existing external Supabase project (NOT Lovable Cloud).
- Supabase URL: {{SUPABASE_URL}}
- Supabase anon key: {{SUPABASE_ANON_KEY}}
Create the Supabase client from these values. Do not create any tables, migrations, or edge functions — they already exist. The app is READ-ONLY except for invoking two edge functions and one RPC listed below.

AUTH: Email + password login page. Every page requires a signed-in user (all data is RLS-protected to the authenticated role). No public sign-up link on the login page; include a small "Create account" link that goes to a sign-up form.

DATA SOURCES (all read with supabase-js):
- view `game_board` — one row per upcoming game with everything needed for the betting box. Key columns:
  game_id, season, week, slate (THU/FRI/SAT/SUN/MON), game_date_et, kickoff_utc, home_team, away_team, stadium, home_qb, away_qb,
  spread_line (expected HOME margin; negative = home is the underdog), total_line, home_moneyline, away_moneyline,
  model_home_prob, blend_home_prob, market_home_prob, adj_home_win, model_margin, adj_margin, news_pts,
  ats_pick, ats_pick_prob, ml_pick, ml_pick_ev, bet_score (0-100), rating (A+/A/B+/B/C/PASS), risk_rating (Low/Moderate/Elevated/High/Extreme), risk_index (0-1), units,
  categories (json: factor group -> log-odds contribution), top_features (json array {feature, logit}),
  home_starters_out, away_starters_out (json arrays {player,pos,status}), questionable_starters,
  temp_f, wind_mph, gust_mph, wind_dir, humidity, precip_prob, pressure_mb, short_forecast, indoor, weather_source, weather_at,
  home_adj_pts, away_adj_pts, home_confidence, away_confidence, volatility, home_items, away_items (json arrays of news items {player,category,headline,summary,impact,severity,source_name,source_url,published}), game_brief, scanned_at,
  expert_count, consensus_pick, consensus_pct, consensus_score, consensus_rating, pbm_agrees_with_experts, n_over, n_under, expert_picks (json array {expert,market,pick,side,line,odds,units,rationale,source_url,source_name,published_at}),
  updated_at
- table `slate_sheets` — game_date_et, slate, season, week, is_final, generated_at, payload (json array of game_board rows)
- table `team_ratings` — season, team, off_epa, def_epa, off_sr, def_sr, off_pass_epa, def_pass_epa, off_rush_epa, def_rush_epa, adot, pythag, winpct17, luck, margin_epa, home_split, road_split, load3
- view `dashboard_stats` — win-rate tiles (see page 0)
- view `sheet_results` — every game from the LOCKED game-day sheets with its result: game_date_et, slate, season, week, game_id, home_team, away_team, home_score, away_score, spread_line, ats_pick, rating, bet_score, risk_rating, units, consensus_pick, agrees, ats_result, consensus_result, su_result (WIN/LOSS/PUSH)
- view `track_record` — graded past model picks: game_id, season, week, game_date_et, slate, home_team, away_team, home_score, away_score, spread_line, ats_pick, ats_result (WIN/LOSS/PUSH), su_result
- view `expert_record` — expert, season, week, game_id, market, pick_team, line, source_url, result (WIN/LOSS/PUSH/null)
- table `model_runs` — latest row: backtest (json: games, model_logloss, vegas_logloss, model_accuracy, vegas_accuracy, ats_bets, ats_win_rate, ats_roi, ev_bets, ev_roi, ev_roi_by_season), feature_importance (json), created_at
- tables `experts` (id, name, affiliation, where_published, active) and `expert_scans` (expert_id, season, week, scanned_at, picks_found, notes)

ACTIONS:
- "Re-scan news" on a game: supabase.functions.invoke('pbm-news-agent', { body: { game_id } }) — show a spinner (can take up to 90 seconds), then refetch.
- "Refresh expert picks" on the Experts page, per expert: supabase.functions.invoke('pbm-expert-agent', { body: { expert_id, season, week } }).
- "Lock sheet now" on a sheet: supabase.rpc('snapshot_slate', { d: game_date_et }).

PAGES:

0. WIN-RATE TILES (top of the home page, above the sheet tabs, and repeated at the top of Track Record)
   Read view `dashboard_stats` for the current season (columns: season, scope, label, sort, wins, losses, pushes, win_pct, units_net, breakeven).
   Row of big stat tiles in this order (scope → tile):
     pbm_ats_bets "Bet win rate" · pbm_ats_all "All picks ATS" · pbm_top "A+/A picks" · pbm_last4 "Last 4 weeks" ·
     consensus_ats "Expert consensus" · agree_ats "PBM + experts agree" · pbm_su "Straight-up winners"
   Each tile: large win % (one decimal), record "W-L-P" underneath, units net (+green / -red, e.g. "+4.6u") where applicable, and a thin bar showing win % against the 52.4% break-even marker (breakeven column). Tile border green when win_pct > breakeven, red when below, gray when fewer than 10 decided games (show "small sample").
   Each tile also has a small sparkline of cumulative units by week from `sheet_results`.
   Under the tiles, a compact "By grade" strip (scopes starting with grade_: A+, A, B+, B, C, PASS) and a "By sheet" strip (scopes starting with slate_: THU, FRI, SAT, SUN, MON), each as small chips with win % and record.
   Season selector (dropdown of seasons present in dashboard_stats), default = current season.
   If there are no graded games yet, show the tiles with "—" and the caption "Records start when the first locked sheet is graded."

1. SLATE SHEETS (home page, "/")
   Tabs across the top: THURSDAY · FRIDAY · SATURDAY · SUNDAY · MONDAY for the current week (only show tabs that have games; group game_board rows by `slate`). Under the tabs show the date, "Live" or "Final sheet (locked at first kickoff)" badge, and "as of" time.
   For each tab: if a slate_sheets row exists for that date use its payload when is_final = true, otherwise show live game_board rows.
   Top summary strip: number of games, number of bets (units > 0), total units, average bet score, count of games where the model and the expert consensus agree.
   Then a sortable table/cards list of games sorted by bet_score desc, each row showing the BETTING BOX (component below) in compact form. Clicking opens the Game Detail page.
   "Print / Export sheet" button: printable layout of the sheet (one clean table: matchup, kickoff ET, line, PBM pick, PBM prob, rating, bet score, risk, units, Expert consensus pick, consensus %, agree/disagree) plus CSV download.

2. BETTING BOX component (used on the sheets and at the top of Game Detail) — two columns side by side:
   LEFT "PLAY BOOK MATRIX":
     - Big letter rating badge (A+ green … PASS gray) and Bet Score 0-100 as a radial gauge
     - Risk rating pill with color (Low green, Moderate teal, Elevated amber, High orange, Extreme red) and a 5-segment risk meter from risk_index
     - ATS pick: "{ats_pick} {line from that team's side}" with cover probability %
     - Moneyline pick: team, EV per $100 (ml_pick_ev * 100), shown red when negative
     - Win probability bar: model (adj_home_win) vs market (market_home_prob) for home/away
     - Fair spread: -adj_margin formatted as a spread vs Vegas spread_line, and the difference in points
     - Suggested units
   RIGHT "EXPERT CONSENSUS":
     - consensus_rating letter badge + consensus_score gauge
     - consensus_pick and consensus_pct, "{expert_count} experts with public picks"
     - Agree/Disagree banner comparing with ats_pick (green AGREE / red DISAGREE / gray "no expert picks yet")
     - Totals lean: n_over vs n_under
   Line conversion rules: spread_line is the expected home margin. The home team's spread is -spread_line and the away team's is +spread_line (e.g., spread_line 7 => home -7, away +7). Format moneylines with a + sign when positive.

3. GAME DETAIL ("/game/:game_id")
   - Header: away @ home, kickoff in ET, stadium, QBs, Vegas line/total/moneylines, weather chip.
   - Betting Box (full size).
   - "Why the model likes it" — horizontal diverging bar chart of `categories` (Efficiency, Luck regression, Home/Away split, Injuries, Fatigue & travel, Weather); positive values favor the home team, negative favor the away team; label bars with team names. Below it, the top_features list with friendly names (map feature codes: d_off_epa "Offensive EPA/play edge", d_def_epa "Defensive EPA allowed edge", d_off_sr "Offensive success rate edge", d_def_sr "Defensive success rate edge", d_margin_epa "Net EPA margin edge", d_pythag "Pythagorean expectation edge", d_luck "Luck (actual vs Pythagorean)", d_fum_rec_rate "Fumble recovery luck", home_home_boost "Home-field split", away_road_boost "Road split", *_inj_qb "QB availability", *_inj_ol "O-line cluster", *_inj_db "Secondary cluster", *_inj_front "Front-7 cluster", *_inj_skill "Skill-position cluster", d_inj_total "Total injury cluster", d_load3 "3-game snap load (fatigue)", rest_diff "Rest days edge", away_travel_mi "Away travel miles", wind_x_adot_home / wind_x_adot_away "Wind vs deep passing (aDOT)", wind_mph "Wind", temp_f "Temperature", humidity "Humidity", precip "Precipitation", indoor "Indoor").
   - Probability panel: gauge/donut of adj_home_win; comparison bars model_home_prob vs blend_home_prob vs market_home_prob vs adj_home_win; a normal-curve chart of the projected margin (mean adj_margin, sd 13.45) with a vertical line at the Vegas spread, the cover area shaded.
   - INTEL panel: game_brief at top, then two columns (home / away) of news items as cards: category icon, headline, summary, impact color, severity dots, source link (open in new tab), published date. Show the agent's adjustment in points and confidence for each team, volatility, and "scanned X min ago". "Re-scan news" button.
   - INJURIES panel: starters out for each team with status badges (Out red, Doubtful orange, Questionable amber, Practice: DNP / Limited gray).
   - WEATHER panel: temp, wind speed + direction arrow, gusts, humidity, precip chance, pressure, forecast text, source, and an "Indoor" state for domes. Highlight wind >= 15 mph.
   - EXPERTS panel: table of expert_picks (expert, market, pick, line, odds, one-line rationale, source link, date).

4. TEAMS ("/teams")
   - Scatter chart: x = off_epa, y = -def_epa (so up and right is good), team abbreviation labels.
   - Sortable table of team_ratings with all metrics; show luck (winpct17 - pythag) with red/green to flag teams due for regression.

5. TRACK RECORD ("/record")
   - Model ATS: W-L-P, win %, units at -110, and a cumulative-units line chart by week from track_record.
   - Expert records from expert_record: per expert W-L-P and win % (spread and total separately), plus the consensus's record.
   - Side-by-side comparison card: Play Book Matrix vs Expert Consensus.

6. MODEL LAB ("/model")
   - Backtest from the latest model_runs row: model vs Vegas log loss, accuracy, ATS win rate vs 52.4% break-even line, ATS ROI, moneyline +EV ROI by season (bar chart).
   - Feature importance bar chart (top 20).
   - A short static explainer: how spreads map to win probability (margin ~ Normal(spread, 13.45)), no-vig probability from moneylines, EV and quarter-Kelly, what EPA/success rate/Pythagorean luck/cluster injuries mean. Plain text, one screen.

7. EXPERTS ("/experts")
   - List of experts with affiliation, where they publish, this week's scan time and picks found, the agent's notes, and a "Refresh picks" button.

Global: top nav (Sheets, Teams, Record, Model Lab, Experts), current season/week in the header, all times in America/New_York. Use Recharts for charts. Show a small footer: "For informational and entertainment purposes. Bet responsibly."
