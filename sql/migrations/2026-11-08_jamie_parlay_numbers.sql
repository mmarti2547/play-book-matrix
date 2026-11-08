-- Jamie's Pick parlay numbers: sequential, starting at 100, stable per ticker set
create sequence if not exists public.parlay_no_seq start with 100 minvalue 100;
create table if not exists public.parlay_numbers (
  ticker_key text primary key,
  no integer not null unique default nextval('public.parlay_no_seq'),
  created_at timestamptz not null default now()
);
alter table public.parlay_numbers enable row level security;
drop policy if exists parlay_numbers_read on public.parlay_numbers;
create policy parlay_numbers_read on public.parlay_numbers for select to authenticated using (true);
create or replace function public.pbm_parlay_no(p_key text)
returns integer language plpgsql security definer set search_path = public as $$
declare v integer;
begin
  if p_key is null or length(p_key) = 0 or length(p_key) > 4000 then return null; end if;
  if auth.uid() is null then return null; end if;
  select no into v from parlay_numbers where ticker_key = p_key;
  if v is not null then return v; end if;
  insert into parlay_numbers(ticker_key) values (p_key) on conflict (ticker_key) do nothing;
  select no into v from parlay_numbers where ticker_key = p_key;
  return v;
end $$;
revoke all on function public.pbm_parlay_no(text) from public, anon;
grant execute on function public.pbm_parlay_no(text) to authenticated;
