# Play Book Matrix

NFL game analysis and betting intelligence. Three parts:

| Part | Where it runs | What it does |
|---|---|---|
| Model engine (`run.py`, `pbm/`) | GitHub Actions, on a schedule | Pulls nflverse play-by-play, injuries, snap counts, depth, schedules and Vegas lines; builds EPA/success-rate, Pythagorean luck, home/away split, cluster-injury, fatigue/travel and weather features; trains XGBoost (win classifier + margin regressor); pulls live stadium weather (NWS + Open-Meteo); writes predictions to Supabase |
| Claude agents (`supabase/functions/`) | Supabase Edge Functions | `pbm-news-agent`: sourced news brief + bounded point adjustment per game. `pbm-expert-agent`: collects each handicapper's publicly posted picks |
| App | Lovable | Game-day sheets (Thu/Fri/Sat/Sun/Mon), betting box, graphs, intel, expert consensus side by side, track record |

The betting box math (bet score, rating, risk, units, consensus) lives in the `game_board` view in `sql/schema.sql`, so a news re-scan updates it instantly.

## Secrets
GitHub repo → Settings → Secrets → Actions: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`.
Supabase Edge Function secrets: `ANTHROPIC_API_KEY` (optional `PBM_AGENT_MODEL`, default `claude-sonnet-5`).

## Backtest (walk-forward 2018–2025, model never sees the season it predicts)
- Model log loss 0.645 vs Vegas no-vig 0.609 (Vegas is sharper on straight-up winners)
- ATS picks at ≥55% model cover probability: ~53% win rate over ~1,400 games (break-even at -110 is 52.4%)
- Raw moneyline "+EV" flags lost ~5% — which is why moneyline EV uses a 30% model / 70% market blend and the bet score is driven mainly by the ATS signal
