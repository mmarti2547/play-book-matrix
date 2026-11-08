-- 2026-11-08: slip singles stay until kickoff+5 min (late-bet window), parlays until kickoff; fill until kickoff.
do $$
declare d text := pg_get_functiondef('public.pbm_fill_bet_slip'::regproc);
begin
  d := replace(d, 'q.first_kickoff - interval ''15 minutes''', 'q.first_kickoff');
  d := replace(d, 'q.kickoff_utc - interval ''15 minutes''', 'q.kickoff_utc + interval ''5 minutes''');
  d := replace(d, 'now() + interval ''15 minutes''', 'now()');
  execute d;
end $$;
create table if not exists public.kalshi_kickoff_price (ticker text primary key, game_id text not null, yes_bid numeric, yes_ask numeric, captured_at timestamptz not null default now());
alter table public.kalshi_kickoff_price enable row level security;
create policy kkp_read on public.kalshi_kickoff_price for select to authenticated using (true);
grant select on public.kalshi_kickoff_price to authenticated;
