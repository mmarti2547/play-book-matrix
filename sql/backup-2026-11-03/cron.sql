-- ===== PSQL WINDOW =====
-- pg_cron jobs for Play Book Matrix (project ljlzpysnikwbhspzlpmu), read from cron.job on 2026-11-03.
-- 26 jobs, all active. Secrets are never stored in these commands: the cron token is read at run time
-- from private_config (key 'cron_token'). Re-create a job with the matching cron.schedule(...) line.

-- jobid 1
select cron.schedule('pbm-kalshi-prices', '*/15 * * * *', $cmd$select net.http_post(url:='https://ljlzpysnikwbhspzlpmu.supabase.co/functions/v1/pbm-kalshi-prices', body:='{}'::jsonb, headers:='{"Content-Type":"application/json"}'::jsonb)$cmd$);

-- jobid 3
select cron.schedule('pbm-gameday-scans', '*/5 * * * *', $cmd$select run_gameday_scans_if_due()$cmd$);

-- jobid 4
select cron.schedule('pbm-engine-after-inactives', '*/5 * * * *', $cmd$select run_engine_after_inactives()$cmd$);

-- jobid 6
select cron.schedule('pbm-settle-bets', '*/10 * * * *', $cmd$select net.http_post(url := 'https://ljlzpysnikwbhspzlpmu.supabase.co/functions/v1/pbm-kalshi', body := '{}'::jsonb, headers := jsonb_build_object('Content-Type','application/json','x-pbm-cron',(select value from private_config where key='cron_token')), timeout_milliseconds := 60000)$cmd$);

-- jobid 7
select cron.schedule('pbm-weekly-briefings', '0 13 * * 2', $cmd$
  select net.http_post(url := 'https://ljlzpysnikwbhspzlpmu.supabase.co/functions/v1/pbm-briefing-agent',
    body := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-pbm-cron', (select value from private_config where key = 'cron_token')),
    timeout_milliseconds := 30000)$cmd$);

-- jobid 8
select cron.schedule('pbm-closing-lines', '*/5 * * * *', $cmd$select capture_closing_lines()$cmd$);

-- jobid 10
select cron.schedule('pbm-learning-agent', '15 14 * * 2', $cmd$
  select net.http_post(url := 'https://ljlzpysnikwbhspzlpmu.supabase.co/functions/v1/pbm-learning-agent',
    body := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json',
                                  'x-pbm-cron', (select value from private_config where key = 'cron_token')),
    timeout_milliseconds := 5000)
$cmd$);

-- jobid 12
select cron.schedule('pbm-odds-live', '*/15 * * * *', $cmd$
  select net.http_post(url := 'https://ljlzpysnikwbhspzlpmu.supabase.co/functions/v1/pbm-odds',
    body := '{"action":"live_snapshot"}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-pbm-cron', (select value from private_config where key = 'cron_token')),
    timeout_milliseconds := 5000)
$cmd$);

-- jobid 14
select cron.schedule('pbm-kalshi-flow', '*/10 * * * *', $cmd$
  select net.http_post(url := 'https://ljlzpysnikwbhspzlpmu.supabase.co/functions/v1/pbm-history',
    body := '{"action":"kalshi_flow","max_pages":10}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-pbm-cron', (select value from private_config where key = 'cron_token')),
    timeout_milliseconds := 5000)
$cmd$);

-- jobid 15
select cron.schedule('pbm-auto-trader', '*/5 * * * *', $cmd$
  select net.http_post(url := 'https://ljlzpysnikwbhspzlpmu.supabase.co/functions/v1/pbm-kalshi',
    body := '{"action":"auto_run"}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-pbm-cron', (select value from private_config where key = 'cron_token')),
    timeout_milliseconds := 5000)
$cmd$);

-- jobid 16
select cron.schedule('pbm-early-edge', '3-59/15 * * * *', $cmd$
  select net.http_post(url := 'https://ljlzpysnikwbhspzlpmu.supabase.co/functions/v1/pbm-early-edge',
    body := '{"action":"run"}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-pbm-cron', (select value from private_config where key = 'cron_token')),
    timeout_milliseconds := 5000)
$cmd$);

-- jobid 17
select cron.schedule('pbm-bet-slip-tuesday', '0 12 * * 2', $cmd$ select pbm_fill_bet_slip() $cmd$);

-- jobid 18
select cron.schedule('pbm-bet-slip-sync', '7 * * * *', $cmd$ select pbm_fill_bet_slip() $cmd$);

-- jobid 19
select cron.schedule('pbm-watchdog', '3,18,33,48 * * * *', $cmd$select net.http_post(url := 'https://ljlzpysnikwbhspzlpmu.supabase.co/functions/v1/pbm-watchdog', body := '{}'::jsonb, headers := jsonb_build_object('Content-Type','application/json','x-pbm-cron',(select value from private_config where key='cron_token')), timeout_milliseconds := 120000)$cmd$);

-- jobid 20
select cron.schedule('pbm-sync-finals', '*/5 * * * *', $cmd$select net.http_post(url := 'https://ljlzpysnikwbhspzlpmu.supabase.co/functions/v1/pbm-live-scores', body := '{"action":"sync_finals"}'::jsonb, headers := jsonb_build_object('Content-Type','application/json','x-pbm-cron',(select value from private_config where key='cron_token')), timeout_milliseconds := 30000)$cmd$);

-- jobid 21
select cron.schedule('pbm-kalshi-totals', '*/15 * * * *', $cmd$ select pbm_refresh_kalshi_totals() $cmd$);

-- jobid 22
select cron.schedule('pbm-jamie', '* * * * *', $cmd$
  select net.http_post(url := 'https://ljlzpysnikwbhspzlpmu.supabase.co/functions/v1/pbm-jamie',
    body := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-pbm-cron', (select value from private_config where key = 'cron_token')),
    timeout_milliseconds := 120000)
$cmd$);

-- jobid 23
select cron.schedule('pbm-odds-hardrock', '7,22,37,52 * * * *', $cmd$
  select net.http_post(url := 'https://ljlzpysnikwbhspzlpmu.supabase.co/functions/v1/pbm-odds',
    body := '{"action":"hardrock_lines"}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-pbm-cron', (select value from private_config where key = 'cron_token')),
    timeout_milliseconds := 5000)
$cmd$);

-- jobid 24
select cron.schedule('pbm-deposits-sync', '*/2 * * * *', $cmd$select net.http_post(url := 'https://ljlzpysnikwbhspzlpmu.supabase.co/functions/v1/pbm-kalshi', body := '{"action":"deposits_sync"}'::jsonb, headers := jsonb_build_object('Content-Type','application/json','x-pbm-cron',(select value from private_config where key='cron_token')), timeout_milliseconds := 60000)$cmd$);

-- jobid 25
select cron.schedule('pbm-slate-lock', '*/5 * * * *', $cmd$select public.snapshot_slate((now() at time zone 'America/New_York')::date) where exists (select 1 from games where game_date_et = (now() at time zone 'America/New_York')::date)$cmd$);

-- jobid 26
select cron.schedule('pbm-location-reminder', '0 12,13 * * 2', $cmd$select public.pbm_location_reminder()$cmd$);

-- jobid 27
select cron.schedule('pbm-jamie-learn', '30 13 * * 2', $cmd$select public.pbm_fit_jamie_weight()$cmd$);

-- jobid 29
select cron.schedule('pbm-zplus-log', '*/5 * * * *', $cmd$select public.pbm_zplus_snapshot()$cmd$);

-- jobid 30
select cron.schedule('pbm-y-log', '*/5 * * * *', $cmd$select public.pbm_y_snapshot()$cmd$);

-- jobid 31
select cron.schedule('pbm-qb-check', '*/30 * * * *', $cmd$
  select net.http_post(url := 'https://ljlzpysnikwbhspzlpmu.supabase.co/functions/v1/pbm-qb-check',
    body := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-pbm-cron', (select value from private_config where key = 'cron_token')),
    timeout_milliseconds := 120000)
$cmd$);

-- jobid 32
select cron.schedule('pbm-fill-check', '*/5 * * * *', $cmd$select net.http_post(url := 'https://ljlzpysnikwbhspzlpmu.supabase.co/functions/v1/pbm-fill-check', body := '{}'::jsonb, headers := jsonb_build_object('Content-Type','application/json','x-pbm-cron',(select value from private_config where key='cron_token')), timeout_milliseconds := 60000)$cmd$);
select cron.schedule('pbm-location-check', '*/15 * * * *', $cmd$select net.http_post(url := 'https://ljlzpysnikwbhspzlpmu.supabase.co/functions/v1/pbm-location-check', body := '{}'::jsonb, headers := jsonb_build_object('Content-Type','application/json','x-pbm-cron',(select value from private_config where key='cron_token')), timeout_milliseconds := 60000)$cmd$);
select cron.schedule('pbm-kickoff-price', '* * * * *', $cmd$select net.http_post(url := 'https://ljlzpysnikwbhspzlpmu.supabase.co/functions/v1/pbm-latebet', body := '{"action":"snapshot"}'::jsonb, headers := jsonb_build_object('Content-Type','application/json','x-pbm-cron',(select value from private_config where key='cron_token')), timeout_milliseconds := 50000)$cmd$);
