-- ===== PSQL WINDOW =====
-- Play Book Matrix schema: tables, betting-box view, slate sheets, track record, RLS

create table if not exists games (
  game_id text primary key, season int, week int, game_type text,
  kickoff_utc timestamptz, slate text, game_date_et date,
  home_team text, away_team text, home_score int, away_score int,
  stadium text, stadium_id text, roof text, surface text,
  spread_line numeric, total_line numeric, home_moneyline int, away_moneyline int,
  home_rest int, away_rest int, home_qb text, away_qb text, div_game boolean
);

create table if not exists team_ratings (
  season int, team text, as_of_game text,
  off_epa numeric, def_epa numeric, off_sr numeric, def_sr numeric,
  off_pass_epa numeric, def_pass_epa numeric, off_rush_epa numeric, def_rush_epa numeric,
  adot numeric, pythag numeric, winpct17 numeric, luck numeric, margin_epa numeric,
  home_split numeric, road_split numeric, load3 numeric,
  primary key (season, team)
);

create table if not exists weather (
  game_id text primary key references games(game_id) on delete cascade,
  source text, indoor boolean, roof_type text, temp_f numeric, wind_mph numeric, gust_mph numeric,
  wind_dir text, wind_dir_deg numeric, humidity numeric, precip_prob numeric, precip int,
  pressure_mb numeric, short_forecast text, hours_to_kickoff numeric, fetched_at timestamptz
);

create table if not exists predictions (
  game_id text primary key references games(game_id) on delete cascade,
  model_version text, model_home_prob numeric, blend_home_prob numeric, market_home_prob numeric,
  spread_home_prob numeric, model_margin numeric, home_cover_prob numeric,
  edge_home numeric, ev_home numeric, ev_away numeric,
  categories jsonb, top_features jsonb, home_starters_out jsonb, away_starters_out jsonb,
  home_inj_total numeric, away_inj_total numeric, questionable_starters int,
  weather_severity numeric, early_season int, model_market_gap numeric, updated_at timestamptz
);

create table if not exists predictions_log (
  id bigserial primary key, game_id text, model_version text, model_home_prob numeric,
  blend_home_prob numeric, market_home_prob numeric, model_margin numeric,
  home_cover_prob numeric, updated_at timestamptz
);
create index if not exists predictions_log_game on predictions_log(game_id, updated_at desc);

create table if not exists model_runs (
  id bigserial primary key, model_version text, created_at timestamptz default now(),
  train_seasons text, backtest jsonb, feature_importance jsonb
);

create table if not exists news_intel (
  game_id text primary key references games(game_id) on delete cascade,
  home_adj_pts numeric default 0, away_adj_pts numeric default 0,
  home_confidence numeric, away_confidence numeric, volatility numeric,
  home_items jsonb default '[]', away_items jsonb default '[]',
  game_brief text, agent_model text, scanned_at timestamptz default now()
);

create table if not exists slate_sheets (
  game_date_et date primary key, slate text, season int, week int,
  is_final boolean default false, generated_at timestamptz default now(), payload jsonb
);


-- ===== Expert handicappers (2nd rating method: consensus) =====
create table if not exists experts (
  id serial primary key, name text unique not null, affiliation text, where_published text,
  active boolean default true
);

create table if not exists expert_picks (
  id bigserial primary key, expert_id int references experts(id) on delete cascade,
  game_id text references games(game_id) on delete cascade, season int, week int,
  market text check (market in ('spread','moneyline','total')),
  pick_team text, pick_side text check (pick_side in ('home','away','over','under')),
  line numeric, odds int, units numeric, rationale text, source_url text, source_name text,
  published_at date, found_at timestamptz default now(),
  unique (expert_id, game_id, market)
);
alter table expert_picks add column if not exists pick_type text default 'pick';

create table if not exists expert_scans (
  expert_id int references experts(id) on delete cascade, season int, week int,
  scanned_at timestamptz default now(), picks_found int, notes text,
  primary key (expert_id, season, week)
);

insert into experts (name, affiliation, where_published) values
 ('Billy Walters','Legendary professional bettor','Rarely publishes picks; occasional interviews, podcasts, book/media appearances'),
 ('Dr. Bob Akmens','BASports.com','basports.com free picks, contest entries and press releases'),
 ('Steve Fezzik','Two-time LVH/SuperBook SuperContest winner','VSiN shows/podcasts, Fezzik''s Football Forecast, contest entries'),
 ('Drew Martin','WagerTalk','wagertalk.com articles and free picks'),
 ('David Bearman','SportsLine (former ESPN betting lead)','sportsline.com expert pages, public articles and social posts'),
 ('Al McMordie','BigAl.com newsletter','bigal.com free plays and articles'),
 ('Jimmy Boyd','Professional football handicapper','Covers.com / Doc''s Sports / public free picks'),
 ('Brian Edwards','VegasInsider','vegasinsider.com picks and articles'),
 ('Marco D''Angelo','WagerTalk','wagertalk.com articles, contest entries'),
 ('Will Rogers','High-volume documented handicapper','public free picks on handicapping sites')
on conflict (name) do nothing;

create or replace view expert_consensus with (security_invoker = on) as
with sp as (
  select ep.game_id,
         count(*) as n_spread,
         count(*) filter (where pick_side = 'home') as n_home,
         count(*) filter (where pick_side = 'away') as n_away
  from expert_picks ep join experts e on e.id = ep.expert_id and e.active
  where market = 'spread' group by ep.game_id
), tot as (
  select game_id, count(*) filter (where pick_side='over') as n_over, count(*) filter (where pick_side='under') as n_under
  from expert_picks where market = 'total' group by game_id
), allp as (
  select ep.game_id, jsonb_agg(jsonb_build_object('expert', e.name, 'type', ep.pick_type, 'market', ep.market, 'pick', ep.pick_team,
           'side', ep.pick_side, 'line', ep.line, 'odds', ep.odds, 'units', ep.units, 'rationale', ep.rationale,
           'source_url', ep.source_url, 'source_name', ep.source_name, 'published_at', ep.published_at)
           order by e.name) as picks
  from expert_picks ep join experts e on e.id = ep.expert_id and e.active group by ep.game_id
)
select g.game_id, coalesce(sp.n_spread,0) as n_spread, coalesce(sp.n_home,0) as n_home, coalesce(sp.n_away,0) as n_away,
       case when coalesce(sp.n_spread,0) = 0 then null when sp.n_home > sp.n_away then g.home_team
            when sp.n_away > sp.n_home then g.away_team else 'SPLIT' end as consensus_pick,
       case when coalesce(sp.n_spread,0) = 0 then null
            else round(greatest(sp.n_home, sp.n_away)::numeric / sp.n_spread, 3) end as consensus_pct,
       case when coalesce(sp.n_spread,0) = 0 then 0
            else round(100 * (greatest(sp.n_home, sp.n_away)::numeric / sp.n_spread) * least(1, sp.n_spread / 4.0))::int end as consensus_score,
       coalesce(tot.n_over,0) as n_over, coalesce(tot.n_under,0) as n_under,
       coalesce(allp.picks, '[]'::jsonb) as expert_picks
from games g left join sp using (game_id) left join tot using (game_id) left join allp using (game_id);

-- Normal CDF approximation (logistic, max error < 0.01)
create or replace function pbm_phi(x numeric) returns numeric language sql immutable as
$$ select 1 / (1 + exp(-1.702 * x)) $$;

create or replace function pbm_dec(ml numeric) returns numeric language sql immutable as
$$ select case when ml is null then null when ml > 0 then 1 + ml/100 else 1 + 100/abs(ml) end $$;

-- ===== Kalshi prediction-market prices (public data, refreshed by pbm-kalshi-prices) =====
create table if not exists kalshi_markets (
  game_id text primary key references games(game_id) on delete cascade,
  event_ticker text, home_ticker text, away_ticker text,
  home_yes_bid numeric, home_yes_ask numeric, away_yes_bid numeric, away_yes_ask numeric,
  home_last numeric, away_last numeric, home_prob numeric, volume numeric, fetched_at timestamptz default now()
);
alter table kalshi_markets enable row level security;
drop policy if exists "read_all" on kalshi_markets;
create policy "read_all" on kalshi_markets for select to authenticated using (true);
grant select on kalshi_markets to authenticated;

-- ===== The betting box =====
create or replace view game_board with (security_invoker = on) as
with base as (
  select g.*, p.model_home_prob, p.blend_home_prob, p.market_home_prob, p.spread_home_prob,
         p.model_margin, p.home_cover_prob, p.categories, p.top_features,
         p.home_starters_out, p.away_starters_out, p.home_inj_total, p.away_inj_total,
         p.questionable_starters, p.weather_severity, p.early_season, p.model_market_gap, p.updated_at,
         w.temp_f, w.wind_mph, w.gust_mph, w.wind_dir, w.humidity, w.precip_prob, w.pressure_mb,
         w.short_forecast, w.indoor, w.source as weather_source, w.fetched_at as weather_at,
         n.home_adj_pts, n.away_adj_pts, n.home_confidence, n.away_confidence, n.volatility,
         n.home_items, n.away_items, n.game_brief, n.scanned_at,
         greatest(-4, least(4, coalesce(n.home_adj_pts,0) - coalesce(n.away_adj_pts,0))) as news_pts
  from games g
  join predictions p using (game_id)
  left join weather w using (game_id)
  left join news_intel n using (game_id)
), calc as (
  select b.*,
    b.model_margin + b.news_pts as adj_margin,
    pbm_phi(((b.model_margin + b.news_pts) - b.spread_line) / 13.45) as adj_home_cover,
    1 / (1 + exp(-(ln(b.blend_home_prob / (1 - b.blend_home_prob)) + 0.12 * b.news_pts))) as adj_home_win
  from base b
), picks as (
  select c.*,
    case when c.adj_home_cover >= 0.5 then c.home_team else c.away_team end as ats_pick,
    greatest(c.adj_home_cover, 1 - c.adj_home_cover) as ats_pick_prob,
    c.adj_home_win * (pbm_dec(c.home_moneyline) - 1) - (1 - c.adj_home_win) as ev_home_adj,
    (1 - c.adj_home_win) * (pbm_dec(c.away_moneyline) - 1) - c.adj_home_win as ev_away_adj,
    least(1, greatest(0,
        0.20 * coalesce(c.early_season,0)
      + 0.04 * least(coalesce(c.questionable_starters,0), 6)
      + 0.25 * coalesce(c.weather_severity,0)
      + 0.30 * coalesce(c.volatility, 0.5)
      + 0.20 * least(1, greatest(0, (coalesce(c.model_market_gap,0) - 7) / 7.0))
      + case when c.scanned_at is null then 0.10 else 0 end)) as risk_index
  from calc c
), scored as (
  select p.*,
    case when p.ev_home_adj >= p.ev_away_adj then p.home_team else p.away_team end as ml_pick,
    greatest(p.ev_home_adj, p.ev_away_adj) as ml_pick_ev,
    ( 60 * least(1, greatest(0, (p.ats_pick_prob - 0.5238) / 0.10))
    + 20 * least(1, greatest(0, greatest(p.ev_home_adj, p.ev_away_adj) / 0.10))
    + case when sign(p.model_home_prob - p.market_home_prob) = sign(p.adj_margin - p.spread_line) then 10 else 0 end
    + case when p.news_pts <> 0 and sign(p.news_pts) = sign(p.adj_home_cover - 0.5)
           then 10 * coalesce(greatest(p.home_confidence, p.away_confidence), 0.5) else 0 end
    ) * (1 - 0.35 * p.risk_index) as raw_score
  from picks p
)
select s.*,
  ec.n_spread as expert_count, ec.consensus_pick, ec.consensus_pct, ec.consensus_score,
  case when ec.consensus_score >= 80 then 'A+' when ec.consensus_score >= 70 then 'A' when ec.consensus_score >= 60 then 'B+'
       when ec.consensus_score >= 50 then 'B' when ec.consensus_score >= 40 then 'C' else 'PASS' end as consensus_rating,
  (ec.consensus_pick = s.ats_pick) as pbm_agrees_with_experts,
  ec.n_over, ec.n_under, ec.expert_picks,
  round(least(100, greatest(0, s.raw_score)))::int as bet_score,
  case when s.raw_score >= 80 then 'A+' when s.raw_score >= 70 then 'A' when s.raw_score >= 60 then 'B+'
       when s.raw_score >= 50 then 'B' when s.raw_score >= 40 then 'C' else 'PASS' end as rating,
  case when s.risk_index < 0.2 then 'Low' when s.risk_index < 0.4 then 'Moderate'
       when s.risk_index < 0.6 then 'Elevated' when s.risk_index < 0.8 then 'High' else 'Extreme' end as risk_rating,
  case when s.raw_score >= 80 then 2 when s.raw_score >= 70 then 1.5 when s.raw_score >= 60 then 1
       when s.raw_score >= 50 then 0.5 else 0 end as units,
  case when s.adj_home_win >= 0.5 then s.home_team else s.away_team end as predicted_winner,
  greatest(s.adj_home_win, 1 - s.adj_home_win) as predicted_winner_prob,
  -- Kalshi market view (3rd opinion): no-vig win probability from the prediction market
  round(km.home_prob, 4) as kalshi_home_prob,
  case when km.home_prob is null then null when km.home_prob >= 0.5 then s.home_team else s.away_team end as kalshi_winner,
  round(greatest(km.home_prob, 1 - km.home_prob), 4) as kalshi_winner_prob,
  km.home_yes_ask as kalshi_home_ask, km.away_yes_ask as kalshi_away_ask, km.fetched_at as kalshi_updated_at,
  -- PBM win % for the PBM predicted winner minus Kalshi's % for that same team (percentage points)
  round(100 * (greatest(s.adj_home_win, 1 - s.adj_home_win)
        - case when s.adj_home_win >= 0.5 then km.home_prob else 1 - km.home_prob end), 1) as kalshi_edge_pts,
  (km.home_prob is not null and (km.home_prob >= 0.5) = (s.adj_home_win >= 0.5)) as pbm_agrees_with_kalshi,
  -- best Kalshi YES buy: PBM probability minus the price you would pay
  case when km.home_yes_ask is null then null
       when s.adj_home_win - km.home_yes_ask >= (1 - s.adj_home_win) - km.away_yes_ask then s.home_team else s.away_team end as kalshi_value_side,
  round(100 * greatest(s.adj_home_win - km.home_yes_ask, (1 - s.adj_home_win) - km.away_yes_ask), 1) as kalshi_value_pts,
  -- Vegas view (4th opinion): no-vig moneyline win probability (falls back to the spread when no moneyline)
  round(coalesce(s.market_home_prob, s.spread_home_prob), 4) as vegas_home_prob,
  case when coalesce(s.market_home_prob, s.spread_home_prob) is null then null
       when coalesce(s.market_home_prob, s.spread_home_prob) >= 0.5 then s.home_team else s.away_team end as vegas_winner,
  round(greatest(coalesce(s.market_home_prob, s.spread_home_prob), 1 - coalesce(s.market_home_prob, s.spread_home_prob)), 4) as vegas_winner_prob,
  case when s.spread_line > 0 then s.home_team when s.spread_line < 0 then s.away_team end as vegas_favorite,
  abs(s.spread_line) as vegas_fav_points,
  round(100 * (greatest(s.adj_home_win, 1 - s.adj_home_win)
        - case when s.adj_home_win >= 0.5 then coalesce(s.market_home_prob, s.spread_home_prob)
               else 1 - coalesce(s.market_home_prob, s.spread_home_prob) end), 1) as vegas_edge_pts,
  (coalesce(s.market_home_prob, s.spread_home_prob) is not null
     and (coalesce(s.market_home_prob, s.spread_home_prob) >= 0.5) = (s.adj_home_win >= 0.5)) as pbm_agrees_with_vegas
from scored s left join expert_consensus ec using (game_id) left join kalshi_markets km using (game_id);

-- ===== Game-day sheets (Thu / Sat / Sun / Mon ...), frozen at the slate's first kickoff =====
create or replace function snapshot_slate(d date) returns void language plpgsql security definer as $$
declare first_kick timestamptz;
begin
  if exists (select 1 from slate_sheets where game_date_et = d and is_final) then return; end if;
  select min(kickoff_utc) into first_kick from games where game_date_et = d;
  if first_kick is null then return; end if;
  insert into slate_sheets (game_date_et, slate, season, week, is_final, generated_at, payload)
  select d, max(slate), max(season), max(week), now() >= first_kick, now(),
         jsonb_agg(to_jsonb(b) order by b.kickoff_utc, b.bet_score desc)
  from game_board b where b.game_date_et = d
  on conflict (game_date_et) do update
    set payload = excluded.payload, generated_at = excluded.generated_at, is_final = excluded.is_final;
end $$;

-- ===== Track record: last prediction made before kickoff, graded =====
create or replace view track_record with (security_invoker = on) as
select g.game_id, g.season, g.week, g.game_date_et, g.slate, g.home_team, g.away_team,
       g.home_score, g.away_score, g.spread_line, l.model_margin, l.home_cover_prob, l.model_home_prob, l.market_home_prob,
       case when l.home_cover_prob >= 0.5 then g.home_team else g.away_team end as ats_pick,
       case
         when (g.home_score - g.away_score) = g.spread_line then 'PUSH'
         when (l.home_cover_prob >= 0.5) = ((g.home_score - g.away_score) > g.spread_line) then 'WIN'
         else 'LOSS' end as ats_result,
       case when (l.model_home_prob >= 0.5) = (g.home_score > g.away_score) then 'WIN' else 'LOSS' end as su_result
from games g
join lateral (select * from predictions_log pl where pl.game_id = g.game_id and pl.updated_at < g.kickoff_utc
              order by pl.updated_at desc limit 1) l on true
where g.home_score is not null;

create or replace view expert_record with (security_invoker = on) as
select e.name as expert, ep.season, ep.week, ep.game_id, ep.market, ep.pick_team, ep.line, ep.source_url,
  case
    when g.home_score is null or ep.line is null then null
    when ep.market = 'spread' and ((case when ep.pick_side='home' then g.home_score - g.away_score else g.away_score - g.home_score end) + ep.line) = 0 then 'PUSH'
    when ep.market = 'spread' and ((case when ep.pick_side='home' then g.home_score - g.away_score else g.away_score - g.home_score end) + ep.line) > 0 then 'WIN'
    when ep.market = 'spread' then 'LOSS'
    when ep.market = 'total' and (g.home_score + g.away_score) = ep.line then 'PUSH'
    when ep.market = 'total' and ((g.home_score + g.away_score) > ep.line) = (ep.pick_side = 'over') then 'WIN'
    when ep.market = 'total' then 'LOSS'
  end as result
from expert_picks ep join experts e on e.id = ep.expert_id join games g on g.game_id = ep.game_id;

-- ===== Row level security: signed-in users read, engine writes with the service role =====
do $$ declare t text;
begin
  foreach t in array array['games','team_ratings','weather','predictions','predictions_log','model_runs','news_intel','slate_sheets','experts','expert_picks','expert_scans'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists "read_%s" on %I', t, t);
    execute format('create policy "read_%s" on %I for select to authenticated using (true)', t, t);
  end loop;
end $$;

grant select on game_board, track_record, expert_consensus, expert_record to authenticated;
grant execute on function snapshot_slate(date) to authenticated;

-- ===== My bets (logged manually or placed through Kalshi) =====
create table if not exists my_bets (
  id bigserial primary key, user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  game_id text references games(game_id), book text, market text, pick text, line numeric, odds int,
  stake numeric, placed_at timestamptz default now(), status text default 'open', result text, payout numeric,
  external_order_id text
);
alter table my_bets enable row level security;
drop policy if exists "own_bets" on my_bets;
create policy "own_bets" on my_bets for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
grant select, insert, update, delete on my_bets to authenticated;
grant usage, select on sequence my_bets_id_seq to authenticated;

-- ===== Printable bet sheet (ranked by probability to win) + weekly scorecard =====
drop view if exists weekly_scorecard, bet_sheet, dashboard_stats, sheet_results cascade;

create view bet_sheet with (security_invoker = on) as
select rank() over (partition by b.season, b.week order by b.predicted_winner_prob desc, b.bet_score desc) as rank,
  -- Best-bet order: grade first, then LOWER risk first within a grade, then bet score
  rank() over (partition by b.season, b.week order by
      case b.rating when 'A+' then 6 when 'A' then 5 when 'B+' then 4 when 'B' then 3 when 'C' then 2 else 1 end desc,
      b.risk_index asc, b.bet_score desc) as bet_rank,
  b.season, b.week, b.slate, b.game_date_et, b.kickoff_utc, b.game_id, b.away_team, b.home_team,
  b.predicted_winner, round(b.predicted_winner_prob, 4) as predicted_winner_prob,
  case when b.predicted_winner = b.home_team then -b.spread_line else b.spread_line end as winner_spread,
  case when b.predicted_winner = b.home_team then b.home_moneyline else b.away_moneyline end as winner_moneyline,
  b.ats_pick, case when b.ats_pick = b.home_team then -b.spread_line else b.spread_line end as ats_pick_spread,
  round(b.ats_pick_prob, 4) as ats_pick_prob, b.rating, b.bet_score, b.risk_rating, round(b.risk_index, 3) as risk_index, b.units,
  b.consensus_pick, b.expert_count, b.total_line,
  b.kalshi_winner, b.kalshi_winner_prob, b.kalshi_home_prob, b.kalshi_edge_pts, b.pbm_agrees_with_kalshi,
  b.kalshi_value_side, b.kalshi_value_pts, b.kalshi_updated_at,
  b.vegas_winner, b.vegas_winner_prob, b.vegas_home_prob, b.vegas_favorite, b.vegas_fav_points,
  b.home_moneyline, b.away_moneyline, b.vegas_edge_pts, b.pbm_agrees_with_vegas
from game_board b
where b.home_score is null;

create view sheet_results with (security_invoker = on) as
with p as (
  select s.game_date_et, s.slate, s.season, s.week, s.is_final, e
  from slate_sheets s cross join lateral jsonb_array_elements(s.payload) e
), g as (
  select p.*, gm.home_team, gm.away_team, gm.home_score, gm.away_score,
         (gm.home_score - gm.away_score) as home_margin,
         (e->>'spread_line')::numeric as spread_line,
         coalesce(e->>'predicted_winner',
                  case when (e->>'adj_home_win')::numeric >= 0.5 then gm.home_team else gm.away_team end) as predicted_winner,
         coalesce((e->>'predicted_winner_prob')::numeric,
                  greatest((e->>'adj_home_win')::numeric, 1 - (e->>'adj_home_win')::numeric)) as predicted_winner_prob
  from p join games gm on gm.game_id = p.e->>'game_id'
  where gm.home_score is not null
)
select g.game_date_et, g.slate, g.season, g.week, g.e->>'game_id' as game_id, g.home_team, g.away_team,
  g.home_score, g.away_score, g.spread_line, g.predicted_winner, g.predicted_winner_prob,
  rank() over (partition by g.season, g.week order by g.predicted_winner_prob desc) as week_rank,
  g.e->>'ats_pick' as ats_pick, g.e->>'rating' as rating, (g.e->>'bet_score')::int as bet_score,
  g.e->>'risk_rating' as risk_rating, coalesce((g.e->>'units')::numeric, 0) as units,
  g.e->>'consensus_pick' as consensus_pick, (g.e->>'pbm_agrees_with_experts')::boolean as agrees,
  case when g.home_margin = g.spread_line then 'PUSH'
       when (g.e->>'ats_pick' = g.home_team) = (g.home_margin > g.spread_line) then 'WIN' else 'LOSS' end as ats_result,
  case when (g.e->>'consensus_pick') is null or g.e->>'consensus_pick' = 'SPLIT' then null
       when g.home_margin = g.spread_line then 'PUSH'
       when (g.e->>'consensus_pick' = g.home_team) = (g.home_margin > g.spread_line) then 'WIN' else 'LOSS' end as consensus_result,
  case when g.home_margin = 0 then 'PUSH'
       when (g.predicted_winner = g.home_team) = (g.home_margin > 0) then 'WIN' else 'LOSS' end as su_result,
  g.e->>'kalshi_winner' as kalshi_winner, (g.e->>'kalshi_winner_prob')::numeric as kalshi_winner_prob,
  case when g.e->>'kalshi_winner' is null then null when g.home_margin = 0 then 'PUSH'
       when (g.e->>'kalshi_winner' = g.home_team) = (g.home_margin > 0) then 'WIN' else 'LOSS' end as kalshi_su_result,
  g.e->>'vegas_winner' as vegas_winner,
  case when g.e->>'vegas_winner' is null then null when g.home_margin = 0 then 'PUSH'
       when (g.e->>'vegas_winner' = g.home_team) = (g.home_margin > 0) then 'WIN' else 'LOSS' end as vegas_su_result
from g;

create view dashboard_stats with (security_invoker = on) as
with r as (select *, max(week) over (partition by season) as last_week from sheet_results),
scopes as (
  select season, 'pbm_ats_all' as scope, 'PBM ATS · all picks' as label, 1 as sort, ats_result as res, units, true as use_units from r
  union all select season, 'pbm_ats_bets', 'PBM ATS · rated bets', 2, ats_result, units, true from r where units > 0
  union all select season, 'pbm_top', 'PBM A+ / A picks', 3, ats_result, units, true from r where rating in ('A+','A')
  union all select season, 'pbm_last4', 'PBM ATS · last 4 weeks', 4, ats_result, units, true from r where week > last_week - 4
  union all select season, 'pbm_su', 'Straight-up winners', 5, su_result, 0, false from r
  union all select season, 'consensus_ats', 'Expert consensus ATS', 6, consensus_result, 0, false from r where consensus_result is not null
  union all select season, 'agree_ats', 'PBM + experts agree', 7, ats_result, units, true from r where agrees
  union all select season, 'kalshi_su', 'Kalshi favorite straight-up', 8, kalshi_su_result, 0, false from r where kalshi_su_result is not null
  union all select season, 'pbm_kalshi_agree_su', 'PBM + Kalshi agree (SU)', 9, su_result, 0, false from r where kalshi_winner = predicted_winner
  union all select season, 'vegas_su', 'Vegas favorite straight-up', 8, vegas_su_result, 0, false from r where vegas_su_result is not null
  union all select season, 'grade_' || rating, 'Grade ' || rating, 10, ats_result, units, true from r where rating is not null
  union all select season, 'slate_' || slate, slate || ' sheet', 20, ats_result, units, true from r
)
select season, scope, min(label) as label, min(sort) as sort,
  count(*) filter (where res = 'WIN') as wins,
  count(*) filter (where res = 'LOSS') as losses,
  count(*) filter (where res = 'PUSH') as pushes,
  round(count(*) filter (where res = 'WIN')::numeric / nullif(count(*) filter (where res in ('WIN','LOSS')), 0), 4) as win_pct,
  round(sum(case when not use_units then 0 when res = 'WIN' then units * 100 / 110.0
                 when res = 'LOSS' then -units else 0 end), 2) as units_net,
  0.5238 as breakeven
from scopes group by season, scope;

create view weekly_scorecard with (security_invoker = on) as
with wk as (
  select season, week, count(*) as games_scheduled, count(*) filter (where home_score is not null) as games_final
  from games where game_type = 'REG' or game_type is not null group by season, week
), r as (select * from sheet_results)
select r.season, r.week, wk.games_scheduled, wk.games_final, (wk.games_final = wk.games_scheduled) as week_complete,
  count(*) as games_graded,
  count(*) filter (where su_result = 'WIN') as su_wins, count(*) filter (where su_result = 'LOSS') as su_losses,
  round(count(*) filter (where su_result = 'WIN')::numeric / nullif(count(*) filter (where su_result in ('WIN','LOSS')), 0), 4) as su_win_pct,
  count(*) filter (where week_rank <= 5 and su_result = 'WIN') as top5_su_wins,
  count(*) filter (where week_rank <= 5 and su_result = 'LOSS') as top5_su_losses,
  count(*) filter (where week_rank <= 10 and su_result = 'WIN') as top10_su_wins,
  count(*) filter (where week_rank <= 10 and su_result = 'LOSS') as top10_su_losses,
  count(*) filter (where ats_result = 'WIN') as ats_wins, count(*) filter (where ats_result = 'LOSS') as ats_losses,
  count(*) filter (where ats_result = 'PUSH') as ats_pushes,
  round(count(*) filter (where ats_result = 'WIN')::numeric / nullif(count(*) filter (where ats_result in ('WIN','LOSS')), 0), 4) as ats_win_pct,
  count(*) filter (where units > 0 and ats_result = 'WIN') as bet_wins, count(*) filter (where units > 0 and ats_result = 'LOSS') as bet_losses,
  round(sum(case when units > 0 and ats_result = 'WIN' then units * 100 / 110.0
                 when units > 0 and ats_result = 'LOSS' then -units else 0 end), 2) as units_net,
  count(*) filter (where rating in ('A+','A') and ats_result = 'WIN') as a_wins,
  count(*) filter (where rating in ('A+','A') and ats_result = 'LOSS') as a_losses,
  count(*) filter (where consensus_result = 'WIN') as consensus_wins, count(*) filter (where consensus_result = 'LOSS') as consensus_losses,
  count(*) filter (where kalshi_su_result = 'WIN') as kalshi_su_wins, count(*) filter (where kalshi_su_result = 'LOSS') as kalshi_su_losses,
  count(*) filter (where vegas_su_result = 'WIN') as vegas_su_wins, count(*) filter (where vegas_su_result = 'LOSS') as vegas_su_losses,
  jsonb_agg(jsonb_build_object('rank', week_rank, 'game_id', game_id, 'matchup', away_team || ' @ ' || home_team,
     'score', away_score || '-' || home_score, 'predicted_winner', predicted_winner, 'prob', predicted_winner_prob,
     'su', su_result, 'ats_pick', ats_pick, 'spread_line', spread_line, 'ats', ats_result, 'rating', rating,
     'bet_score', bet_score, 'units', units, 'kalshi_winner', kalshi_winner, 'kalshi_su', kalshi_su_result, 'vegas_winner', vegas_winner, 'vegas_su', vegas_su_result) order by week_rank) as games
from r join wk using (season, week)
group by r.season, r.week, wk.games_scheduled, wk.games_final;

grant select on bet_sheet, sheet_results, dashboard_stats, weekly_scorecard to authenticated;
