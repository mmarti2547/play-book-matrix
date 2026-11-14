-- ===== PSQL WINDOW =====
-- 2026-11-14 News/injury scans one game at a time (applied via MCP as migration news_scan_queue).
-- Many scans at once share one edge worker, which is stopped about 200s after it starts, so most of a batch was lost
-- (11/14: 7 of 14 games never scanned; 11/12 WAS@NYG injury check stalled 1 hour).
create table if not exists public.news_requests (id bigserial primary key, game_id text not null, requested_at timestamptz not null default now(), reason text);
alter table public.news_requests enable row level security;

create or replace function public.pbm_news_next() returns text
language plpgsql security definer set search_path = public as $$
declare tok text; g record;
begin
  if exists (select 1 from news_requests where requested_at > now() - interval '4 minutes') then return 'busy'; end if;
  select x.game_id, x.reason into g from (
    select gm.game_id, 'after_inactives' reason, gm.kickoff_utc, 0 pri
      from games gm left join news_intel n using (game_id)
     where gm.home_score is null and now() >= gm.kickoff_utc - interval '90 minutes' and gm.kickoff_utc > now() + interval '10 minutes'
       and (n.scanned_at is null or n.scanned_at < gm.kickoff_utc - interval '90 minutes')
    union all
    select gm.game_id, 'never_scanned', gm.kickoff_utc, 1
      from games gm left join news_intel n using (game_id)
     where gm.home_score is null and gm.kickoff_utc between now() and now() + interval '48 hours' and n.scanned_at is null
  ) x
  where not exists (select 1 from news_requests r where r.game_id = x.game_id and r.requested_at > now() - interval '12 minutes')
  order by x.pri, x.kickoff_utc limit 1;
  if g.game_id is null then return 'nothing due'; end if;
  select value into tok from private_config where key = 'cron_token';
  insert into news_requests (game_id, reason) values (g.game_id, g.reason);
  perform net.http_post(url := 'https://ljlzpysnikwbhspzlpmu.supabase.co/functions/v1/pbm-engine-trigger',
    body := jsonb_build_object('action', 'news_test', 'game_id', g.game_id),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-pbm-cron', tok), timeout_milliseconds := 170000);
  return 'started ' || g.game_id || ' (' || g.reason || ')';
end $$;

select cron.schedule('pbm-news-queue', '* * * * *', $cmd$select public.pbm_news_next()$cmd$);
