-- Model Health: said vs hit vs return per bet type, 2w / 4w / season, with a status light. + alert state + cron.
-- (view definition as created 2026-11-09; see public.model_health in the database for the live version)
create table if not exists public.model_health_state (product text primary key, status text, changed_at timestamptz default now());
alter table public.model_health_state enable row level security;
update model_params set value = 0.20, default_value = 0.20 where key = 'ats_shrink';
select cron.schedule('pbm-health', '7 6,13 * * *', $$select net.http_post(url:='https://ljlzpysnikwbhspzlpmu.supabase.co/functions/v1/pbm-health', headers:=jsonb_build_object('Content-Type','application/json','x-pbm-cron',(select value from private_config where key='cron_token')), body:='{}'::jsonb, timeout_milliseconds:=30000)$$);
-- view: products = Game winners (board), Spread picks (board), Jamie legs (A+ to B), Jamie parlays (not Big Coin Flip),
-- and "Your bets: ..." from my_bets by type. Status (n>=10): Red if hit < said-8pts or return < -15%; Yellow if hit < said-4 or return < -5%.
