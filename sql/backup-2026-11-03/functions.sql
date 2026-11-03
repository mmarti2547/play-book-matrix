CREATE OR REPLACE FUNCTION public.alt_parlay_bundle_pick()
 RETURNS TABLE(season integer, week integer, tickers text[], bundle_slot integer, shared_games integer)
 LANGUAGE plpgsql
 STABLE
AS $function$
#variable_conflict use_column
declare wk record; p record; used jsonb; picked int; keys text[]; ov int; maxc int; pass int; gid text;
begin
  for wk in select distinct a.season s, a.week w from alt_parlays a loop
    used := '{}'::jsonb; picked := 0; keys := '{}';
    for pass in 0..1 loop
      for p in
        select a.tickers t, array(select x->>'game_id' from jsonb_array_elements(a.leg_detail) x) gids
        from alt_parlays a
        where a.season = wk.s and a.week = wk.w and a.parlay_grade in ('A+','A','B+','B')
          and not exists (select 1 from my_placed_bets m where m.market = 'parlay' and m.bet_key = (select string_agg(t2, '|' order by t2) from unnest(a.tickers) t2))
        order by a.our_prob desc, a.parlay_rank
      loop
        exit when picked >= 3;
        continue when array_to_string(p.t, '|') = any(keys);
        select count(*) filter (where used ? g), coalesce(max((used->>g)::int), 0) into ov, maxc
          from unnest(p.gids) g;
        if ov <= pass and maxc < 2 then
          picked := picked + 1; keys := keys || array_to_string(p.t, '|');
          foreach gid in array p.gids loop
            used := jsonb_set(used, array[gid], to_jsonb(coalesce((used->>gid)::int, 0) + 1));
          end loop;
          season := wk.s; week := wk.w; tickers := p.t; bundle_slot := picked; shared_games := ov;
          return next;
        end if;
      end loop;
    end loop;
  end loop;
end $function$
;

CREATE OR REPLACE FUNCTION public.bet_cart_remember_dismiss()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
begin
  if old.auto_added and coalesce(current_setting('pbm.sync', true), '') <> 'on' then
    insert into bet_cart_dismissed (user_id, ticker, side) values (old.user_id, old.ticker, old.side) on conflict do nothing;
  end if;
  return old;
end $function$
;

CREATE OR REPLACE FUNCTION public.capture_closing_lines()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare n int := 0;
begin
  insert into closing_lines (ticker, game_id, kind, team, threshold, yes_bid, yes_ask, mid, kickoff_utc, captured_at)
  select a.ticker, a.game_id, 'alt', a.team, a.threshold, a.yes_bid, a.yes_ask, pbm_mid(a.yes_bid, a.yes_ask, a.last_price), g.kickoff_utc, now()
  from kalshi_alt_lines a join games g using (game_id)
  where g.kickoff_utc > now() and g.kickoff_utc < now() + interval '3 hours' and a.fetched_at > now() - interval '30 minutes'
  on conflict (ticker) do update set yes_bid = excluded.yes_bid, yes_ask = excluded.yes_ask, mid = excluded.mid, captured_at = excluded.captured_at;
  get diagnostics n = row_count;

  insert into closing_lines (ticker, game_id, kind, team, threshold, yes_bid, yes_ask, mid, kickoff_utc, captured_at)
  select x.ticker, k.game_id, 'game', x.team, null, x.bid, x.ask, pbm_mid(x.bid, x.ask, x.last), g.kickoff_utc, now()
  from kalshi_markets k join games g using (game_id)
  cross join lateral (values (k.home_ticker, g.home_team, k.home_yes_bid, k.home_yes_ask, k.home_last),
                             (k.away_ticker, g.away_team, k.away_yes_bid, k.away_yes_ask, k.away_last)) x(ticker, team, bid, ask, last)
  where x.ticker is not null and g.kickoff_utc > now() and g.kickoff_utc < now() + interval '3 hours' and k.fetched_at > now() - interval '30 minutes'
  on conflict (ticker) do update set yes_bid = excluded.yes_bid, yes_ask = excluded.yes_ask, mid = excluded.mid, captured_at = excluded.captured_at;

  -- hourly price trail for games in the next 8 days
  if extract(minute from now()) < 5 then
    insert into kalshi_price_history (ticker, at, game_id, yes_bid, yes_ask, mid)
    select a.ticker, date_trunc('hour', now()), a.game_id, a.yes_bid, a.yes_ask, pbm_mid(a.yes_bid, a.yes_ask, a.last_price)
    from kalshi_alt_lines a join games g using (game_id)
    where g.kickoff_utc > now() and g.kickoff_utc < now() + interval '8 days'
    on conflict do nothing;
    delete from kalshi_price_history where at < now() - interval '120 days';
  end if;
  return n;
end $function$
;

CREATE OR REPLACE FUNCTION public.claim_odds_batch(n integer)
 RETURNS timestamp with time zone[]
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare c odds_backfill; ts timestamptz; out timestamptz[] := '{}'; guard int := 0;
begin
  select * into c from odds_backfill where id = 1 for update;
  if c.done or c.paused then return out; end if;
  ts := c.next_ts;
  while coalesce(array_length(out, 1), 0) < n and ts < c.end_ts and guard < 20000 loop
    if pbm_in_season(ts) then out := out || ts; end if;
    ts := ts + make_interval(mins => c.step_min); guard := guard + 1;
  end loop;
  update odds_backfill set next_ts = ts, done = (ts >= c.end_ts), updated_at = now() where id = 1;
  return out;
end $function$
;

CREATE OR REPLACE FUNCTION public.ee_detect_kalshi_gap()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare n int := 0;
begin
  if not exists (select 1 from odds_line_history where source = 'live' and snap_at > now() - interval '6 hours') then return 0; end if;
  with cur as (
    select g.game_id, g.home_team, g.away_team, g.kickoff_utc, k.home_ticker, k.away_ticker, k.home_yes_ask, k.away_yes_ask,
           v.home_prob_now hp, v.home_spread_now hs
    from games g join kalshi_markets k using (game_id) cross join lateral ee_line_context(g.game_id) v
    where g.kickoff_utc > now() + interval '24 hours' and g.kickoff_utc < now() + interval '8 days'
      and k.fetched_at > now() - interval '30 minutes' and v.home_prob_now is not null),
  c as (select game_id, kickoff_utc, home_team bet_team, away_team fade_team, home_ticker ticker, home_yes_ask price, hp vp, hs from cur
        union all
        select game_id, kickoff_utc, away_team, home_team, away_ticker, away_yes_ask, 1 - hp, hs from cur),
  hits as (select * from c where ticker is not null and price between 0.10 and 0.90 and vp - price >= 0.02)
  insert into ee_signals (kind, game_id, bet_team, fade_team, ticker, price, vegas_prob, gap_pts, line_now, bettable, note, kickoff_utc,
                          bet_side, bet_label, bet_line, max_price)
  select 'kalshi_gap', game_id, bet_team, fade_team, ticker, price, round(vp, 4), round(100 * (vp - price), 1), hs, true,
         'Kalshi sells ' || bet_team || ' to win at ' || round(price * 100) || '¢ while Vegas gives ' || round(vp * 100, 1) || '%', kickoff_utc,
         'yes', bet_team || ' to win', null, round(vp - 0.02, 2)
  from hits
  on conflict (kind, game_id, bet_team) do update set last_seen_at = now(), active = true,
    price = excluded.price, vegas_prob = excluded.vegas_prob, gap_pts = excluded.gap_pts, line_now = excluded.line_now, note = excluded.note,
    bet_label = excluded.bet_label, max_price = excluded.max_price;
  get diagnostics n = row_count;
  update ee_signals set active = false where kind = 'kalshi_gap' and active and last_seen_at < now();
  update ee_signals set active = false where active and kickoff_utc < now();
  return n;
end $function$
;

CREATE OR REPLACE FUNCTION public.ee_line_context(p_game_id text)
 RETURNS TABLE(home_spread_now numeric, home_prob_now numeric, snap_at timestamp with time zone, home_spread_early numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
AS $function$
  with g as (select * from games where game_id = p_game_id),
  s as (select round(o.home_spread_med * 2) / 2 sp, o.home_ml_prob_med p, o.snap_at
        from g join odds_line_history o on o.home_team = g.home_team and o.away_team = g.away_team
         and abs(extract(epoch from o.commence_time - g.kickoff_utc)) < 36 * 3600
        where o.books >= 4 and o.home_spread_med is not null)
  select (select sp from s order by snap_at desc limit 1),
         (select p from s where p is not null order by snap_at desc limit 1),
         (select max(snap_at) from s),
         coalesce((select s.sp from s, g where s.snap_at <= g.kickoff_utc - interval '6 days' and s.snap_at > g.kickoff_utc - interval '10 days' order by s.snap_at desc limit 1),
                  (select s.sp from s, g where s.snap_at > g.kickoff_utc - interval '10 days' order by s.snap_at limit 1))
$function$
;

CREATE OR REPLACE FUNCTION public.ee_unread_count()
 RETURNS integer
 LANGUAGE sql
 STABLE
AS $function$
  select count(*)::int from ee_signals s
  where s.active and s.bettable
    and s.detected_at > coalesce((select seen_at from ee_seen where user_id = auth.uid()), 'epoch'::timestamptz)
$function$
;

CREATE OR REPLACE FUNCTION public.game_flow_verdict(p_game_id text)
 RETURNS TABLE(game_id text, home_team text, away_team text, home_trades integer, away_trades integer, home_contracts numeric, away_contracts numeric, home_dollars numeric, away_dollars numeric, home_avg numeric, away_avg numeric, home_big integer, away_big integer, home_price numeric, away_price numeric, lean_team text, lean_pct numeric, strength text, our_pick_team text, our_pick_label text, our_pick_grade text, vs_pick text, verdict text, headline text, detail text)
 LANGUAGE sql
 STABLE
AS $function$
with g as (select * from games where games.game_id = p_game_id),
f as (select h.backed_team t, sum(h.trades)::int tr, sum(h.contracts) c, sum(h.dollars) d
      from kalshi_flow_hourly h where h.game_id = p_game_id and h.hour > now() - interval '24 hours' group by 1),
b as (select k.backed_team t, count(*)::int n from kalshi_big_trades k
      where k.game_id = p_game_id and k.contracts >= 1000 and k.created_time > now() - interval '24 hours' group by 1),
m as (select * from kalshi_markets km where km.game_id = p_game_id),
p as (select ats_pick, pick_label, rating from pick_kalshi_map pk where pk.game_id = p_game_id order by bet_rank nulls last, rank limit 1),
x as (
  select g.game_id, g.home_team, g.away_team,
    coalesce(fh.tr,0) htr, coalesce(fa.tr,0) atr, round(coalesce(fh.c,0)) hc, round(coalesce(fa.c,0)) ac,
    round(coalesce(fh.d,0)) hd, round(coalesce(fa.d,0)) ad,
    round(fh.d / nullif(fh.tr,0), 2) hav, round(fa.d / nullif(fa.tr,0), 2) aav,
    coalesce(bh.n,0) hb, coalesce(ba.n,0) ab,
    (select home_yes_ask from m) hp, (select away_yes_ask from m) ap,
    (select ats_pick from p) pk, (select pick_label from p) pl, (select rating from p) pr
  from g left join f fh on fh.t = g.home_team left join f fa on fa.t = g.away_team
         left join b bh on bh.t = g.home_team left join b ba on ba.t = g.away_team),
y as (
  select x.*,
    case when hc >= ac then home_team else away_team end lt,
    round(100.0 * greatest(hc, ac) / nullif(hc + ac, 0), 1) lp,
    case when hc >= ac then hb - ab else ab - hb end bigedge
  from x),
z as (
  select y.*,
    case when hc + ac < 5000 or hd + ad < 2000 then 'thin'
         when lp >= 65 and bigedge >= 0 then 'strong'
         when lp >= 57 and bigedge >= -1 then 'lean'
         when lp >= 52 and bigedge >= 3 then 'lean'
         else 'split' end st
  from y)
select game_id, home_team, away_team, htr, atr, hc, ac, hd, ad, hav, aav, hb, ab, hp, ap,
  case when st in ('strong','lean') then lt end, lp, st, pk, pl, pr,
  case when st not in ('strong','lean') or pk is null then 'none' when lt = pk then 'agrees' else 'against' end,
  -- one-word verdict the card shows in a colored chip
  case when st = 'thin' then 'NO SIGNAL'
       when st = 'split' then 'NO SIGNAL'
       when pk is null then case when st = 'strong' then 'STRONG LEAN ' || lt else 'LEAN ' || lt end
       when lt = pk then 'CONFIRMS PICK'
       when st = 'strong' then 'AGAINST PICK'
       else 'LEANS AGAINST' end,
  -- one-line action
  case when st = 'thin' then 'Too little betting to read. Ignore this card' || coalesce(' and go with our pick (' || pl || ').', '.')
       when st = 'split' then 'Bettors are split. No signal' || coalesce(' — go with our pick (' || pl || ').', '.')
       when pk is null then 'Bettors lean ' || lt || ' (' || lp || '% of contracts). We have no pick on this game.'
       when lt = pk then 'Bettors are on the same side as our pick (' || pl || '). Bet it as planned.'
       when st = 'strong' then 'Most bettors are on ' || lt || ', against our pick (' || pl || '). Consider betting half, or skip it.'
       else 'Bettors lean ' || lt || ', against our pick (' || pl || '). Consider a smaller bet.' end,
  -- plain-English why
  lt || ' has ' || lp || '% of contracts bought in the last 24h (' || to_char(greatest(hc,ac),'FM999,999') || ' vs ' || to_char(least(hc,ac),'FM999,999') || ')'
    || '. Big bets (1,000+ contracts): ' || home_team || ' ' || hb || ', ' || away_team || ' ' || ab || '.'
    || case when abs(coalesce(hp,0) - coalesce(ap,0)) >= 0.3 then
         ' Dollars look lopsided toward ' || case when hp > ap then home_team else away_team end || ' only because its contracts cost '
         || round(100 * greatest(hp, ap)) || '¢ vs ' || round(100 * least(hp, ap)) || '¢.' else '' end
    || ' Tie-breaker only: this signal has not been tested for win rate.'
from z
$function$
;

CREATE OR REPLACE FUNCTION public.log_alt_picks()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
begin
  insert into alt_picks_log (ticker, game_id, season, week, team, threshold, bet_label, yes_ask, our_prob, edge_pts, grade, alt_score, logged_at,
                             first_yes_ask, first_logged_at, model_prob, kalshi_prob, team_margin)
  select b.ticker, b.game_id, b.season, b.week, b.team, b.threshold, b.bet_label, b.yes_ask, b.our_prob, b.edge_pts, b.grade, b.alt_score, now(),
         b.yes_ask, now(), b.model_prob, b.kalshi_prob,
         case when b.team = g.home_team then g.adj_margin else -g.adj_margin end
  from alt_lines_board b join game_board g using (game_id)
  where b.grade in ('A+','A','B+','B') and (b.alt_rank <= 25 or b.ticker in (select ticker from alt_best_bets))
  on conflict (ticker) do update set yes_ask = excluded.yes_ask, our_prob = excluded.our_prob, edge_pts = excluded.edge_pts,
    grade = excluded.grade, alt_score = excluded.alt_score, logged_at = excluded.logged_at,
    model_prob = excluded.model_prob, kalshi_prob = excluded.kalshi_prob, team_margin = excluded.team_margin;
  insert into parlay_log (combo_key, season, week, legs, tickers, leg_detail, our_prob, kalshi_prob, parlay_score, logged_at)
  select array_to_string(tickers, '|'), season, week, legs, tickers, leg_detail, our_prob, kalshi_prob, parlay_score, now()
  from alt_parlays where parlay_rank <= 5
  on conflict (combo_key) do update set our_prob = excluded.our_prob, kalshi_prob = excluded.kalshi_prob,
    parlay_score = excluded.parlay_score, logged_at = excluded.logged_at;
end $function$
;

CREATE OR REPLACE FUNCTION public.log_news_intel()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
begin
  insert into news_intel_log (game_id, home_adj_pts, away_adj_pts, home_confidence, away_confidence, volatility,
    home_items, away_items, game_brief, agent_model, scanned_at)
  values (new.game_id, new.home_adj_pts, new.away_adj_pts, new.home_confidence, new.away_confidence, new.volatility,
    new.home_items, new.away_items, new.game_brief, new.agent_model, new.scanned_at);
  return new;
end $function$
;

CREATE OR REPLACE FUNCTION public.parlay_control_no(legs jsonb, prefix text DEFAULT 'J'::text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select prefix || '-' || upper(left(encode(sha256(convert_to(coalesce(string_agg(t, ',' order by t collate "C"), ''), 'UTF8')), 'hex'), 5))
  from (select x->>'ticker' t from jsonb_array_elements(coalesce(legs,'[]'::jsonb)) x where x->>'ticker' is not null) s
$function$
;

CREATE OR REPLACE FUNCTION public.pbm_bankroll()
 RETURNS SETOF member_bankroll
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select * from member_bankroll
  where user_id = auth.uid() or pbm_my_role() = 'owner'
$function$
;

CREATE OR REPLACE FUNCTION public.pbm_bet_group(p_market text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select case when p_market = 'parlay' then 'parlay' when p_market = 'alt_spread' then 'alt'
              when p_market = 'moneyline' then 'ml' else 'spread' end
$function$
;

CREATE OR REPLACE FUNCTION public.pbm_bet_line_from_pick(p_pick text, p_market text)
 RETURNS numeric
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select case
    when p_market in ('moneyline','parlay') then null
    when p_pick ~* 'wins? by (\d+)\+' then -((substring(p_pick from '(?i)wins? by (\d+)\+'))::numeric - 0.5)
    when p_pick ~ '^[A-Z]{2,3} [+-]\d+(\.\d)?' then (substring(p_pick from '^[A-Z]{2,3} ([+-]\d+(?:\.\d)?)'))::numeric
    else null end
$function$
;

CREATE OR REPLACE FUNCTION public.pbm_bet_team(p_ticker text, p_side text, p_game_id text)
 RETURNS text
 LANGUAGE sql
 STABLE
AS $function$
  with t as (select nullif(regexp_replace(p_ticker, '^.*-([A-Z]+)[0-9]*$', '\1'), p_ticker) as sfx),
  g as (select home_team, away_team from games where game_id = p_game_id),
  y as (  -- team named in the contract (the YES side), matched to this game's own team codes
    select case when t.sfx = g.away_team then g.away_team
                when t.sfx = g.home_team then g.home_team
                when left(t.sfx, 2) = left(g.away_team, 2) and left(t.sfx, 2) <> left(g.home_team, 2) then g.away_team
                when left(t.sfx, 2) = left(g.home_team, 2) then g.home_team
                else null end as team, g.home_team, g.away_team
    from t, g)
  select case when y.team is null then null
              when coalesce(p_side, 'yes') = 'no' then case when y.team = y.home_team then y.away_team else y.home_team end
              else y.team end
  from y
$function$
;

CREATE OR REPLACE FUNCTION public.pbm_cancel_deposit_claim(p_id bigint)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  update member_deposit_claims set status = 'cancelled' where id = p_id and user_id = auth.uid() and status = 'pending' $function$
;

CREATE OR REPLACE FUNCTION public.pbm_claim_deposit(p_amount numeric)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare m record; nid bigint;
begin
  select * into m from app_members where user_id = auth.uid() and role = 'member';
  if not found then raise exception 'members only'; end if;
  if p_amount is null or p_amount < 5 or p_amount > 10000 then raise exception 'amount must be $5 - $10,000'; end if;
  insert into member_deposit_claims (user_id, member_email, amount) values (auth.uid(), m.email, p_amount) returning id into nid;
  return nid;
end $function$
;

CREATE OR REPLACE FUNCTION public.pbm_dec(ml numeric)
 RETURNS numeric
 LANGUAGE sql
 IMMUTABLE
AS $function$ select case when ml is null then null when ml > 0 then 1 + ml/100 else 1 + 100/abs(ml) end $function$
;

CREATE OR REPLACE FUNCTION public.pbm_fill_bet_slip()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare u record; q record; n_add int := 0; n_del int := 0; prof int; xleft numeric; want numeric; stk numeric; gspent numeric; npar int;
        ws timestamptz := (date_trunc('week', (now() at time zone 'America/New_York') - interval '1 day') + interval '1 day') at time zone 'America/New_York';   -- NFL week starts Tue 12:00 AM ET
begin
  perform set_config('pbm.sync', 'on', true);
  for u in select a.id, coalesce(s.bet_profile, 1) bet_profile, coalesce(s.extras_cap_usd, 180) extras_cap,
                  coalesce(s.include_props, true) props, coalesce(s.include_parlays, true) parlays, coalesce(s.max_parlays_week, 2) maxpar, coalesce(s.parlay_legs, 0) parlay_mode,
                  coalesce(s.parlay_max_stake, 25) parmax,
                  coalesce(s.include_bplus, false) inc_bp, coalesce(s.include_b, false) inc_b, coalesce(s.include_c, false) inc_c,
                  coalesce(s.max_bplus, 25) max_bp, coalesce(s.max_b, 10) max_b, coalesce(s.max_c, 5) max_c,
                  s.stake_aplus st_ap, s.stake_a st_a
           from auth.users a left join auto_trader_settings s on s.user_id = a.id
           where exists (select 1 from app_members m where m.user_id = a.id and m.role in ('owner','member')) loop
    prof := u.bet_profile;
    -- start fresh each run for auto-added rows (user-added rows are never touched); dismissed ones stay out
    with d as (delete from bet_cart where user_id = u.id and auto_added returning 1) select n_del + count(*) into n_del from d;
    with d as (delete from slip_parlays where user_id = u.id and auto_added returning 1) select n_del + count(*) into n_del from d;

    -- 1) main picks
    for q in select p.game_id, p.ticker, coalesce(p.side, 'yes') side, p.pick_label, p.rating, p.price, p.how_to, p.kalshi_url, g.kickoff_utc
             from pick_kalshi_map p join games g using (game_id)
             where (p.rating in ('A+', 'A') or (p.rating = 'B+' and u.inc_bp) or (p.rating = 'B' and u.inc_b) or (p.rating = 'C' and u.inc_c)) and p.on_kalshi and p.ticker is not null and p.price > 0.05 and p.price < 0.95
               and g.kickoff_utc > now() + interval '15 minutes' and g.kickoff_utc < now() + interval '8 days'
             order by g.kickoff_utc loop
      continue when exists (select 1 from bet_cart_dismissed x where x.user_id = u.id and x.ticker = q.ticker and x.side = q.side);
      continue when exists (select 1 from my_bets b where b.user_id = u.id and b.game_id = q.game_id and b.market <> 'parlay' and coalesce(b.status, '') not in ('not_placed', 'canceled') and coalesce(b.result, '') <> 'void');
      -- 2026-10-10: B+ / B / C only when switched on, at the member's own max bet for that grade
      stk := case q.rating when 'B+' then u.max_bp when 'B' then u.max_b when 'C' then u.max_c
                     when 'A+' then coalesce(u.st_ap, pbm_profile_stake(prof, 'A+')) when 'A' then coalesce(u.st_a, pbm_profile_stake(prof, 'A'))   -- 2026-10-11: your own A+ / A amounts
                     else pbm_profile_stake(prof, q.rating) end;
      insert into bet_cart (user_id, game_id, source, ticker, side, label, where_in_kalshi, kalshi_url, limit_price, count,
                            auto_added, grade, window_opens_at, window_closes_at)
      values (u.id, q.game_id, 'main_pick', q.ticker, q.side, q.pick_label, q.how_to, q.kalshi_url, q.price,
              greatest(1, floor(stk / q.price))::int, true, q.rating, q.kickoff_utc - interval '85 minutes', q.kickoff_utc - interval '15 minutes')
      on conflict (user_id, ticker, side) do nothing;
      get diagnostics npar = row_count; n_add := n_add + npar;
    end loop;

    -- 2026-10-04: the props & parlays budget is what's LEFT after this week's placed parlays / props (Early Edge excluded)
    xleft := u.extras_cap - coalesce((select sum(b.stake) from my_bets b where b.user_id = u.id and b.placed_at >= ws
               and b.market in ('parlay', 'alt_spread') and coalesce(b.status, '') not in ('not_placed', 'canceled')
               and coalesce(b.result, '') <> 'void' and b.pick not ilike '%Early Edge%' and coalesce(b.grade, '') not like 'EE-%'), 0);
    -- 2) parlays FIRST from the props & parlays budget: picked by value (same pbm_pick_parlays() as the Auto Trader)
    if u.parlays then
      -- parlays already placed this week count toward the weekly maximum and never show again in the slip
      select count(*) into npar from my_bets b where b.user_id = u.id and b.placed_at >= ws and b.market = 'parlay'
        and coalesce(b.status, '') not in ('not_placed', 'canceled');
      for q in select b.slot, b.tickers, b.leg_detail, b.our_prob, b.kalshi_prob, b.parlay_grade, b.parlay_score, b.first_kickoff, b.stake_factor,
                      (select string_agg(t, '|' order by t) from unnest(b.tickers) t) leg_key
               from pbm_pick_parlays(u.parlay_mode, u.maxpar, u.id) b
               where b.first_kickoff > now() + interval '15 minutes'
               order by b.slot loop
        exit when npar >= u.maxpar;
        continue when exists (select 1 from bet_cart_dismissed x where x.user_id = u.id and x.ticker = q.leg_key and x.side = 'parlay');
        continue when exists (select 1 from my_bets b where b.user_id = u.id and b.market = 'parlay' and b.placed_at >= ws
                               and (select string_agg(l->>'ticker', '|' order by l->>'ticker') from jsonb_array_elements(b.legs) l) = q.leg_key);
        -- a parlay's stake counts toward EVERY game it has a leg in ($100 per game, same rule as the Auto Trader)
        select coalesce(min(100 - coalesce((select sum(c.limit_price * c.count) from bet_cart c where c.user_id = u.id and c.game_id = l->>'game_id'), 0)
                                 - coalesce((select sum(sp.bet_amount) from slip_parlays sp, jsonb_array_elements(sp.legs) sl where sp.user_id = u.id and sl->>'game_id' = l->>'game_id'), 0)), 0)
          into gspent from jsonb_array_elements(q.leg_detail) l;
        stk := pbm_size_for(least(pbm_profile_stake(prof, q.parlay_grade) * q.stake_factor, u.parmax), least(xleft, gspent));   -- 2026-10-05: parlay stake capped (default $25)
        continue when stk <= 0;
        insert into slip_parlays (user_id, leg_key, tickers, legs, our_prob, kalshi_prob, grade, score, bet_amount, first_kickoff,
                                  auto_added, window_opens_at, window_closes_at)
        values (u.id, q.leg_key, (select array_agg(t order by t) from unnest(q.tickers) t),
                (select jsonb_agg(jsonb_build_object('ticker', l->>'ticker', 'label', l->>'market_title', 'bet_label', l->>'bet_label',
                    'market_title', l->>'market_title', 'event_title', l->>'event_title', 'kalshi_url', l->>'kalshi_url', 'team', l->>'team',
                    'game_id', l->>'game_id', 'our_prob', (l->>'our_prob')::numeric, 'kickoff_utc', l->>'kickoff_utc')) from jsonb_array_elements(q.leg_detail) l),
                q.our_prob, q.kalshi_prob, q.parlay_grade, round(q.parlay_score)::int, stk, q.first_kickoff,
                true, q.first_kickoff - interval '85 minutes', q.first_kickoff - interval '15 minutes')
        on conflict (user_id, leg_key) do nothing;
        get diagnostics want = row_count;
        if want > 0 then npar := npar + 1; n_add := n_add + 1; xleft := xleft - stk; end if;
      end loop;
    end if;
    -- 3) props (best alt line per game) get only what is left after parlays, same team as the main pick only, within the game's $100
    if u.props then
      for q in select a.game_id, a.ticker, a.bet_label, a.grade, a.yes_ask price, a.kalshi_url, g.kickoff_utc
               from alt_best_bets a join games g using (game_id)
               where a.grade in ('A+', 'A', 'B+') and a.ticker is not null and a.yes_ask > 0.05 and a.yes_ask < 0.95
                 and g.kickoff_utc > now() + interval '15 minutes' and g.kickoff_utc < now() + interval '8 days'
               order by g.kickoff_utc, case a.grade when 'A+' then 1 when 'A' then 2 else 3 end loop
        continue when exists (select 1 from bet_cart_dismissed x where x.user_id = u.id and x.ticker = q.ticker and x.side = 'yes');
        continue when exists (select 1 from my_bets b where b.user_id = u.id and b.game_id = q.game_id and b.market <> 'parlay' and coalesce(b.status, '') not in ('not_placed', 'canceled') and coalesce(b.result, '') <> 'void');
        -- never the other team of the slip's main pick on that game
        continue when exists (select 1 from bet_cart c where c.user_id = u.id and c.game_id = q.game_id
                               and pbm_bet_team(c.ticker, c.side, c.game_id) is distinct from pbm_bet_team(q.ticker, 'yes', q.game_id));
        select coalesce(sum(c.limit_price * c.count), 0)
             + coalesce((select sum(sp.bet_amount) from slip_parlays sp, jsonb_array_elements(sp.legs) sl where sp.user_id = u.id and sl->>'game_id' = q.game_id), 0)
          into gspent from bet_cart c where c.user_id = u.id and c.game_id = q.game_id;
        stk := pbm_size_for(pbm_profile_stake(prof, q.grade), least(xleft, 100 - gspent));
        continue when stk <= 0;
        insert into bet_cart (user_id, game_id, source, ticker, side, label, where_in_kalshi, kalshi_url, limit_price, count,
                              auto_added, grade, window_opens_at, window_closes_at)
        values (u.id, q.game_id, 'alt_line', q.ticker, 'yes', q.bet_label, 'Buy YES on "' || q.bet_label || '"', q.kalshi_url, q.price,
                greatest(1, floor(stk / q.price))::int, true, q.grade, q.kickoff_utc - interval '85 minutes', q.kickoff_utc - interval '15 minutes')
        on conflict (user_id, ticker, side) do nothing;
        get diagnostics npar = row_count;
        if npar > 0 then n_add := n_add + 1; xleft := xleft - floor(stk / q.price) * q.price; end if;
      end loop;
    end if;

  end loop;
  delete from bet_cart_dismissed where dismissed_at < now() - interval '10 days';
  return jsonb_build_object('added', n_add, 'replaced', n_del);
end $function$
;

CREATE OR REPLACE FUNCTION public.pbm_fill_leg_games()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  if new.legs is not null and jsonb_typeof(new.legs) = 'array' and exists (select 1 from jsonb_array_elements(new.legs) x where x->>'game_id' is null) then
    new.legs := (select jsonb_agg(case when x->>'game_id' is null and pbm_game_from_ticker(x->>'ticker') is not null
                                       then x || jsonb_build_object('game_id', pbm_game_from_ticker(x->>'ticker')) else x end order by o)
                 from jsonb_array_elements(new.legs) with ordinality e(x, o));
  end if;
  return new;
end $function$
;

CREATE OR REPLACE FUNCTION public.pbm_fill_sheet_week()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
declare s int; w int;
begin
  if new.season is null or new.week is null then
    select g.season, g.week into s, w from jsonb_array_elements(new.payload) e join games g on g.game_id = e->>'game_id' limit 1;
    new.season := coalesce(new.season, s); new.week := coalesce(new.week, w);
  end if;
  if new.slate is null and new.game_date_et is not null then
    new.slate := upper(to_char(new.game_date_et::date, 'Dy'));
  end if;
  return new;
end $function$
;

CREATE OR REPLACE FUNCTION public.pbm_fit_jamie_weight()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
-- 2026-10-26 weekly: how much to trust the Jamie player-stat model vs Kalshi's price. Grid 0.05..0.60, best log loss on all graded legs.
-- Moves at most max_step a week, only with min_games graded legs. Logged in model_param_history.
declare p record; n int; best numeric; best_ll numeric; cur_ll numeric; newv numeric; act text;
begin
  select * into p from model_params where key = 'jamie_model_weight';
  with r as (select distinct on (ticker, side) coalesce(model_prob, our_prob) mp, price m, (result = 'win')::int y
             from jamie_leg_results l where result in ('win','loss') and price between 0.02 and 0.98 order by ticker, side, logged_at),
  g as (select w::numeric / 100 w from generate_series(5, 60, 5) w),
  ll as (select g.w, avg(-(y * ln(greatest(least(g.w * mp + (1 - g.w) * m, 0.99), 0.01)) + (1 - y) * ln(1 - greatest(least(g.w * mp + (1 - g.w) * m, 0.99), 0.01)))) v, count(*) c
         from g, r group by g.w)
  select (select w from ll order by v limit 1), (select v from ll order by v limit 1), (select max(c) from ll),
         (select v from ll order by abs(w - p.value) limit 1) into best, best_ll, n, cur_ll;
  if n < p.min_games then newv := p.value; act := format('held: only %s of %s graded legs', n, p.min_games);
  else newv := round(greatest(p.min_value, least(p.max_value, p.value + greatest(-p.max_step, least(p.max_step, best - p.value)))), 2);
       act := case when newv = p.value then 'held: already best' else format('moved toward %s', best) end; end if;
  update model_params set value = newv, updated_at = now() where key = 'jamie_model_weight';
  insert into model_param_history (key, season, week, old_value, new_value, best_value, n_games, n_lines, logloss_current, logloss_best, action, run_at)
  values ('jamie_model_weight', 2026, (select max(week) from games where kickoff_utc < now()), p.value, newv, best, n, n, round(cur_ll, 4), round(best_ll, 4), act, now());
  return jsonb_build_object('old', p.value, 'new', newv, 'best', best, 'legs', n, 'logloss_best', round(best_ll,4), 'action', act);
end $function$
;

CREATE OR REPLACE FUNCTION public.pbm_game_from_ticker(p_ticker text)
 RETURNS text
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  select g.game_id from games g
  where upper(to_char(g.kickoff_utc at time zone 'America/New_York', 'YYMONDD')) = left(split_part(p_ticker, '-', 2), 7)
    and pbm_kalshi_team(g.away_team) || pbm_kalshi_team(g.home_team) = substr(split_part(p_ticker, '-', 2), 8)
  limit 1 $function$
;

CREATE OR REPLACE FUNCTION public.pbm_game_teams_held(p_user uuid, p_game_id text)
 RETURNS SETOF text
 LANGUAGE sql
 STABLE SECURITY DEFINER
AS $function$
  select distinct t from (
    select pbm_bet_team(b.ticker, b.side, b.game_id) t from my_bets b
    where b.user_id = p_user and b.game_id = p_game_id and coalesce(b.market, '') <> 'parlay'
      and coalesce(b.result, '') <> 'void' and coalesce(b.status, '') not in ('canceled', 'not_placed')
    union all
    select pbm_bet_team(l->>'ticker', coalesce(l->>'side', 'yes'), p_game_id) from my_bets b, jsonb_array_elements(b.legs) l
    where b.user_id = p_user and b.market = 'parlay' and jsonb_typeof(b.legs) = 'array' and l->>'game_id' = p_game_id
      and coalesce(b.result, '') <> 'void' and coalesce(b.status, '') not in ('canceled', 'not_placed')
  ) x where t is not null
$function$
;

CREATE OR REPLACE FUNCTION public.pbm_hr_grade(edge numeric)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select case when edge is null then null when edge >= 0.08 then 'A' when edge >= 0.05 then 'B' when edge >= 0.02 then 'C' else 'PASS' end $function$
;

CREATE OR REPLACE FUNCTION public.pbm_implied(am numeric)
 RETURNS numeric
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select case when am is null then null when am > 0 then 100 / (am + 100) else -am / (-am + 100) end $function$
;

CREATE OR REPLACE FUNCTION public.pbm_in_season(ts timestamp with time zone)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select (extract(month from ts at time zone 'UTC') >= 9) or (extract(month from ts at time zone 'UTC') <= 1)
      or (extract(month from ts at time zone 'UTC') = 2 and extract(day from ts at time zone 'UTC') <= 15)
$function$
;

CREATE OR REPLACE FUNCTION public.pbm_jamie_ticker_map()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  insert into jamie_ticker_map (ticker, game_id, player_key, player_name, stat, strike, label, updated_at)
  values (new.ticker, new.game_id, new.player_key, new.player_name, new.stat, new.strike, new.label, now())
  on conflict (ticker) do update set strike = excluded.strike, updated_at = now();
  return new;
end $function$
;

CREATE OR REPLACE FUNCTION public.pbm_kalshi_fee(p numeric)
 RETURNS numeric
 LANGUAGE sql
 IMMUTABLE
AS $function$ select ceil(7 * p * (1 - p)) / 100 $function$
;

CREATE OR REPLACE FUNCTION public.pbm_kalshi_team(t text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select case t when 'JAX' then 'JAC' when 'LA' then 'LAR' else t end $function$
;

CREATE OR REPLACE FUNCTION public.pbm_last_odds(ids text[])
 RETURNS SETOF odds_line_history
 LANGUAGE sql
 STABLE
AS $function$
  select distinct on (event_id) * from odds_line_history where event_id = any(ids) order by event_id, snap_at desc
$function$
;

CREATE OR REPLACE FUNCTION public.pbm_link_member()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare m record;
begin
  update app_members set user_id = new.id where lower(email) = lower(new.email) and user_id is null returning * into m;
  if found and m.role = 'member' and not exists (select 1 from auto_trader_settings where user_id = new.id) then
    insert into auto_trader_settings
    select (jsonb_populate_record(null::auto_trader_settings,
             to_jsonb(s) || jsonb_build_object('user_id', new.id, 'enabled', false, 'enabled_at', null, 'disabled_at', null,
                                               'disabled_reason', null, 'jamie_auto', false, 'updated_at', now()))).*
    from auto_trader_settings s join app_members o on o.user_id = s.user_id and o.role = 'owner' limit 1;
  end if;
  -- members and research get their own alert row (bet emails on for members)
  if found and not exists (select 1 from alert_settings where user_id = new.id) then
    insert into alert_settings (user_id, email, enabled, early_edge, line_moves, weekly_briefing, auto_bets)
    values (new.id, new.email, true, false, false, true, m.role = 'member');
  end if;
  return new;
end $function$
;

CREATE OR REPLACE FUNCTION public.pbm_location_reminder()
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
-- 2026-10-20 Kalshi API location check lasts 7 days (renewed Tuesdays ~9:26 AM ET). Email the owner Tuesday 8 AM ET to renew. Read-only, never bets.
declare owner_id uuid; et timestamp := now() at time zone 'America/New_York';
begin
  if extract(dow from et) <> 2 or extract(hour from et) <> 8 then return 'not now'; end if;
  if exists (select 1 from kalshi_status where key = 'location' and last_alert_at > now() - interval '20 hours') then return 'already sent'; end if;
  select user_id into owner_id from app_members where role = 'owner' limit 1;
  perform net.http_post(url := 'https://ljlzpysnikwbhspzlpmu.supabase.co/functions/v1/pbm-email',
    body := jsonb_build_object('action','send','kind','system','user_id', owner_id,
      'subject', 'Renew your Kalshi location today (expires this morning)',
      'title', 'Kalshi location check',
      'html', 'Kalshi''s location check for API trading lasts 7 days and runs out this morning. Until you renew it, <b>every bet from Play Book Matrix fails</b> - yours, Tyler''s and the Auto Better''s.<br><br>' ||
              'On your phone: open the Kalshi app (or kalshi.com), allow location access, and it renews for another 7 days. Takes about 30 seconds.<br><br>' ||
              '<a href="https://kalshi.com" style="display:inline-block;padding:12px 18px;background:#22c55e;color:#04110a;font-weight:bold;border-radius:8px;text-decoration:none">Open Kalshi</a>'),
    headers := jsonb_build_object('Content-Type','application/json','x-pbm-cron',(select value from private_config where key='cron_token')),
    timeout_milliseconds := 15000);
  update kalshi_status set last_alert_at = now() where key = 'location';
  return 'sent';
end $function$
;

CREATE OR REPLACE FUNCTION public.pbm_match_deposits()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare d record; c record; n int := 0;
begin
  update member_deposit_claims set status = 'expired' where status = 'pending' and created_at < now() - interval '7 days';
  for d in select * from kalshi_deposits where status = 'applied' and credited_to is null order by created_at loop
    select * into c from member_deposit_claims
     where status = 'pending' and abs(amount - d.amount) <= 5
       and created_at between d.created_at - interval '7 days' and d.created_at + interval '1 day'
     order by created_at limit 1;
    if found then
      update app_members set bankroll_start = coalesce(bankroll_start, 0) + c.amount where lower(email) = lower(c.member_email);
      insert into member_money_log (member_email, amount, kind, note) values (c.member_email, c.amount, 'deposit',
        'auto: Kalshi deposit ' || d.id || ' ($' || d.amount || ' received, fee $' || coalesce(d.fee, 0) || ')');
      update member_deposit_claims set status = 'matched', kalshi_deposit_id = d.id, matched_at = now() where id = c.id;
      update kalshi_deposits set credited_to = c.member_email, claim_id = c.id where id = d.id;
      n := n + 1;
    elsif d.created_at < now() - interval '1 day' then
      update kalshi_deposits set credited_to = 'owner' where id = d.id;   -- nobody claimed it within a day: it's the owner's
    end if;
  end loop;
  return jsonb_build_object('credited', n);
end $function$
;

CREATE OR REPLACE FUNCTION public.pbm_member_bets(p_user uuid)
 RETURNS SETOF my_bets
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select b.* from my_bets b
  where pbm_my_role() = 'owner' and b.user_id = p_user and exists (select 1 from app_members m where m.user_id = p_user and m.role = 'member')
  order by b.placed_at desc
$function$
;

CREATE OR REPLACE FUNCTION public.pbm_member_money(p_email text, p_amount numeric, p_kind text, p_note text DEFAULT NULL::text)
 RETURNS numeric
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare nb numeric;
begin
  if pbm_my_role() is distinct from 'owner' then raise exception 'owner only'; end if;
  if p_kind not in ('deposit','withdrawal') or p_amount is null or p_amount <= 0 or p_amount > 10000 then raise exception 'bad amount or kind'; end if;
  update app_members set bankroll_start = coalesce(bankroll_start,0) + case when p_kind = 'deposit' then p_amount else -p_amount end
   where lower(email) = lower(p_email) and role = 'member' returning bankroll_start into nb;
  if nb is null then raise exception 'not a member'; end if;
  insert into member_money_log (member_email, amount, kind, note, created_by) values (lower(p_email), p_amount, p_kind, p_note, auth.uid());
  return nb;
end $function$
;

CREATE OR REPLACE FUNCTION public.pbm_mid(bid numeric, ask numeric, last numeric)
 RETURNS numeric
 LANGUAGE sql
 IMMUTABLE
AS $function$ select case when bid > 0 and ask > bid then (bid + ask) / 2 else coalesce(last, ask, bid) end $function$
;

CREATE OR REPLACE FUNCTION public.pbm_my_bets_fill_line()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  if new.line is null then new.line := pbm_bet_line_from_pick(new.pick, new.market); end if;
  return new;
end $function$
;

CREATE OR REPLACE FUNCTION public.pbm_my_role()
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select role from app_members where lower(email) = lower(auth.jwt() ->> 'email')
$function$
;

CREATE OR REPLACE FUNCTION public.pbm_ncdf(z numeric)
 RETURNS numeric
 LANGUAGE sql
 IMMUTABLE
AS $function$ select (0.5 * (1 + erf((z / sqrt(2))::float8)))::numeric $function$
;

CREATE OR REPLACE FUNCTION public.pbm_param(p_key text, p_default numeric)
 RETURNS numeric
 LANGUAGE sql
 STABLE
AS $function$ select coalesce((select value from model_params where key = p_key), p_default) $function$
;

CREATE OR REPLACE FUNCTION public.pbm_phi(x numeric)
 RETURNS numeric
 LANGUAGE sql
 IMMUTABLE
AS $function$ select 1 / (1 + exp(-1.702 * x)) $function$
;

CREATE OR REPLACE FUNCTION public.pbm_pick_parlays(p_mode integer, p_max integer, p_user uuid DEFAULT NULL::uuid)
 RETURNS TABLE(slot integer, role text, stake_factor numeric, legs integer, tickers text[], leg_detail jsonb, our_prob numeric, kalshi_prob numeric, max_price_to_pay numeric, first_kickoff timestamp with time zone, parlay_grade text, parlay_score numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
AS $function$
declare used text[] := '{}'; n int := 0; r record; want int[];
begin
  if coalesce(p_mode, 0) = 0 then
    return query select b.bundle_slot::int, 'bundle'::text, 1::numeric, b.legs::int, b.tickers, b.leg_detail, b.our_prob, b.kalshi_prob,
                        b.max_price_to_pay, b.first_kickoff, b.parlay_grade, b.parlay_score::numeric
                 from alt_parlay_bundle b where b.parlay_grade in ('A+', 'A', 'B+') order by b.bundle_slot limit greatest(p_max, 0);
    return;
  end if;
  want := case when p_mode = 24 then array[2, 4, 3, 2, 2, 2, 2, 2, 2, 2] else array_fill(p_mode, array[10]) end;
  for i in 1 .. array_length(want, 1) loop
    exit when n >= p_max;
    -- the long-shot slot tries 4 legs; if the 4-leg was taken (or none fits) skip the 3-leg fallback
    continue when p_mode = 24 and want[i] = 3 and n >= 2;
    select a.* into r from alt_parlays a
    where a.legs = want[i] and a.parlay_grade in ('A+', 'A')
      -- 2026-10-05: the user's minimum parlay grade (default A+ only)
      and (a.parlay_grade = 'A+' or coalesce((select s.parlay_min_grade from auto_trader_settings s where s.user_id = p_user), 'A+') = 'A') and a.first_kickoff > now() + interval '15 minutes' and a.kalshi_prob > 0
      and not exists (select 1 from jsonb_array_elements(a.leg_detail) l where (l->>'game_id') = any(used))
      -- never a leg on the other team of a game the user already holds
      and (p_user is null or not exists (select 1 from jsonb_array_elements(a.leg_detail) l
            where exists (select 1 from pbm_game_teams_held(p_user, l->>'game_id') h(t) where h.t <> pbm_bet_team(l->>'ticker', 'yes', l->>'game_id'))))
    order by (a.parlay_grade = 'A+') desc, a.our_prob / a.kalshi_prob desc, a.our_prob desc limit 1;
    continue when not found;
    n := n + 1;
    used := used || (select array_agg(l->>'game_id') from jsonb_array_elements(r.leg_detail) l);
    slot := n; legs := r.legs; tickers := r.tickers; leg_detail := r.leg_detail; our_prob := r.our_prob; kalshi_prob := r.kalshi_prob;
    max_price_to_pay := r.max_price_to_pay; first_kickoff := r.first_kickoff; parlay_grade := r.parlay_grade; parlay_score := r.parlay_score;
    role := case when p_mode = 24 and r.legs >= 3 then 'long_shot' else 'core' end;
    stake_factor := case when role = 'long_shot' then 0.5 else 1 end;
    return next;
  end loop;
end $function$
;

CREATE OR REPLACE FUNCTION public.pbm_profile_stake(p_profile integer, p_grade text)
 RETURNS numeric
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select case coalesce(p_profile, 1)
    when 1 then case p_grade when 'A+' then 100 when 'A' then 50 when 'B+' then 25 else 0 end
    when 2 then case p_grade when 'A+' then 50 when 'A' then 25 when 'B+' then 10 else 0 end
    else        case p_grade when 'A+' then 25 when 'A' then 10 when 'B+' then 5 else 0 end end
$function$
;

CREATE OR REPLACE FUNCTION public.pbm_refresh_kalshi_totals()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'net'
AS $function$
declare rid bigint; body jsonb; n int := 0;
begin
  select req_id into rid from kalshi_total_fetch where id = 1;
  if rid is not null then
    select content::jsonb into body from net._http_response where id = rid and status_code = 200;
    if body is not null then
      insert into kalshi_total_lines (ticker, event_ticker, strike, yes_ask, no_ask, yes_bid, no_bid, status, updated_at)
      select m->>'ticker', ev->>'event_ticker', (m->>'floor_strike')::numeric,
             nullif(m->>'yes_ask_dollars','')::numeric, nullif(m->>'no_ask_dollars','')::numeric,
             nullif(m->>'yes_bid_dollars','')::numeric, nullif(m->>'no_bid_dollars','')::numeric, m->>'status', now()
      from jsonb_array_elements(body->'events') ev, jsonb_array_elements(ev->'markets') m
      where m->>'floor_strike' is not null
      on conflict (ticker) do update set yes_ask = excluded.yes_ask, no_ask = excluded.no_ask, yes_bid = excluded.yes_bid,
        no_bid = excluded.no_bid, status = excluded.status, strike = excluded.strike, updated_at = excluded.updated_at;
      get diagnostics n = row_count;
      delete from kalshi_total_lines where updated_at < now() - interval '3 days';
    end if;
  end if;
  select net.http_get(url := 'https://api.elections.kalshi.com/trade-api/v2/events?series_ticker=KXNFLTOTAL&status=open&with_nested_markets=true&limit=200') into rid;
  insert into kalshi_total_fetch (id, req_id, asked_at) values (1, rid, now())
  on conflict (id) do update set req_id = excluded.req_id, asked_at = excluded.asked_at;
  return jsonb_build_object('stored', n);
end $function$
;

CREATE OR REPLACE FUNCTION public.pbm_request_withdrawal(p_amount numeric, p_note text DEFAULT NULL::text)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare m record; av numeric; nid bigint; owner_id uuid;
begin
  select * into m from app_members where user_id = auth.uid() and role = 'member';
  if not found then raise exception 'members only'; end if;
  select available into av from member_bankroll where user_id = auth.uid();
  if p_amount is null or p_amount < 1 or p_amount > coalesce(av, 0) then raise exception 'amount must be between $1 and your available $%', round(coalesce(av,0), 2); end if;
  update app_members set bankroll_start = bankroll_start - p_amount where user_id = auth.uid();
  insert into member_withdrawals (user_id, member_email, amount, note) values (auth.uid(), m.email, p_amount, p_note) returning id into nid;
  insert into member_money_log (member_email, amount, kind, note, created_by) values (m.email, p_amount, 'withdrawal', 'requested #' || nid || coalesce(' - ' || p_note, ''), auth.uid());
  select user_id into owner_id from app_members where role = 'owner' limit 1;
  perform net.http_post(url := 'https://ljlzpysnikwbhspzlpmu.supabase.co/functions/v1/pbm-email',
    body := jsonb_build_object('action','send','kind','system','user_id', owner_id,
      'subject', coalesce(m.display_name, m.email) || ' requested a $' || p_amount || ' withdrawal',
      'title', 'Withdrawal request',
      'html', '<b>' || coalesce(m.display_name, m.email) || '</b> asked to withdraw <b>$' || p_amount || '</b> from his Play Book Matrix bankroll.' ||
              coalesce('<br>Note: ' || p_note, '') || '<br><br>It has already been taken out of his bankroll so he cannot bet it. ' ||
              'Kalshi pays out only to your linked bank, so withdraw it from Kalshi (or pay him directly), then mark it Paid on My Bets &rarr; View: ' ||
              coalesce(m.display_name, 'member') || '.<br><br><a href="https://playbookmatrix.com/bets" style="display:inline-block;padding:12px 18px;background:#22c55e;color:#04110a;font-weight:bold;border-radius:8px;text-decoration:none">Open My Bets</a>'),
    headers := jsonb_build_object('Content-Type','application/json','x-pbm-cron',(select value from private_config where key='cron_token')),
    timeout_milliseconds := 15000);
  return nid;
end $function$
;

CREATE OR REPLACE FUNCTION public.pbm_settings_refill()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  perform pbm_fill_bet_slip();
  return null;
end $function$
;

CREATE OR REPLACE FUNCTION public.pbm_size_for(p_want numeric, p_fit numeric)
 RETURNS numeric
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select coalesce((select v from unnest(array[100, 50, 25, 10, 5]::numeric[]) v where v <= p_want and v <= p_fit order by v desc limit 1), 0)
$function$
;

CREATE OR REPLACE FUNCTION public.pbm_watchdog_health()
 RETURNS TABLE(key text, title text, detail text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'cron', 'net', 'auth'
AS $function$
declare t timestamptz; n int; g int;
begin
  return query select 'cron:' || j.jobname, 'Scheduled job failing: ' || j.jobname,
    count(*) || ' failed run(s) in the last 2 hours. Last error: ' || left(coalesce(max(d.return_message), ''), 200)
    from cron.job_run_details d join cron.job j using (jobid)
    where d.status = 'failed' and d.start_time > now() - interval '2 hours' group by j.jobname;

  select max(fetched_at) into t from kalshi_markets;
  if t is null or t < now() - interval '45 minutes' then
    return query select 'stale:kalshi_markets', 'Kalshi prices are not updating',
      'Last price update: ' || coalesce(to_char(t at time zone 'America/New_York', 'Mon DD HH12:MI AM') || ' ET', 'never') || '. Picks and the Auto Trader use these prices.';
  end if;

  select max(l.at) into t from kalshi_balance_log l;
  if t is null or t < now() - interval '3 hours' then
    return query select 'stale:kalshi_balance', 'Kalshi account check is not running',
      'Last balance check: ' || coalesce(to_char(t at time zone 'America/New_York', 'Mon DD HH12:MI AM') || ' ET', 'never') || '. Bet results may not be settling.';
  end if;

  select count(*) into n from email_log where status = 'failed' and sent_at > now() - interval '2 hours';
  if n > 0 then
    return query select 'email:failed', 'Alert emails are failing',
      n || ' email(s) failed in the last 2 hours: ' || coalesce((select left(error, 200) from email_log where status = 'failed' order by sent_at desc limit 1), '');
  end if;

  -- background functions answering with server errors (timeouts are normal and ignored).
  -- Errors from our own functions count at 3+. Hosting-gateway blips (502/520 HTML pages from
  -- Supabase/Cloudflare, not our code) only count when sustained: 8+ in the hour and still happening.
  select count(*) filter (where not (status_code between 520 and 524 or coalesce(content::text,'') ilike '%<html%')),
         count(*) filter (where status_code between 520 and 524 or coalesce(content::text,'') ilike '%<html%')
    into n, g
    from net._http_response where created > now() - interval '1 hour' and status_code >= 500;
  if n >= 3 then
    return query select 'http:5xx', 'Background functions are erroring',
      n || ' server error(s) from scheduled function calls in the last hour.';
  elsif g >= 8 and exists (select 1 from net._http_response where created > now() - interval '15 minutes' and status_code >= 500) then
    return query select 'http:5xx', 'Background functions are erroring',
      g || ' hosting gateway error(s) (Supabase/Cloudflare) in the last hour, still happening.';
  end if;

  select count(*) into n from engine_triggers where status = 'error' and requested_at > now() - interval '3 hours';
  if n > 0 then
    return query select 'engine:trigger', 'Engine could not be started',
      coalesce((select left(detail, 250) from engine_triggers where status = 'error' order by requested_at desc limit 1), '');
  end if;

  select count(*) into n from auto_trader_log where status in ('error', 'failed', 'rejected') and run_at > now() - interval '2 hours';
  if n > 0 then
    return query select 'auto:errors', 'Auto Trader orders are failing',
      n || ' failed order attempt(s) in the last 2 hours. Last: ' ||
      coalesce((select left(coalesce(pick, '') || ' — ' || coalesce(reason, ''), 250) from auto_trader_log where status in ('error', 'failed', 'rejected') order by run_at desc limit 1), '');
  end if;
end $function$
;

CREATE OR REPLACE FUNCTION public.pbm_watchdog_security()
 RETURNS TABLE(key text, title text, detail text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
#variable_conflict use_column
declare known jsonb; s record; fp jsonb; old_fp jsonb; u record; f record; uid text;
begin
  -- 1) sign-ins from an IP + browser we have not seen before
  select value into known from watchdog_state where watchdog_state.key = 'known_devices';
  known := coalesce(known, '{}'::jsonb);
  -- "device" = network area (IPv4 /24, IPv6 /48) + operating system + browser, so browser updates don't trigger alerts
  for s in select se.id, se.user_id, host(se.ip) ip, coalesce(se.user_agent, '') ua, se.created_at, greatest(se.created_at, coalesce(se.refreshed_at at time zone 'UTC', se.updated_at, se.created_at)) last_used, se.aal::text aal, us.email,
                  coalesce(text(network(set_masklen(se.ip, case when family(se.ip) = 4 then 24 else 48 end))), '?') || '|' ||
                  coalesce(substring(se.user_agent from '(Windows|iPhone|iPad|Android|Mac OS|CrOS|Linux)'), 'other') || '|' ||
                  coalesce(substring(se.user_agent from '(Edg|OPR|Firefox|CriOS|Chrome|Safari)'), 'other') dev
           from auth.sessions se join auth.users us on us.id = se.user_id order by se.created_at loop
    continue when known ? s.dev;
    if (select value from watchdog_state where watchdog_state.key = 'baseline_done') is not null then
      -- the session's ip is the address of its LAST use, so say which happened: a fresh sign-in, or an existing sign-in used from a new place
      key := 'sec:session:' || s.id || ':' || md5(s.dev);
      if s.last_used > s.created_at + interval '10 minutes' then
        title := 'Your sign-in was used from a new location';
        detail := 'The sign-in for ' || s.email || ' from ' || to_char(s.created_at at time zone 'America/New_York', 'Mon DD HH12:MI AM') ||
                  ' ET (authenticator used: ' || case when s.aal = 'aal2' then 'yes' else 'NO' end || ') was used at ' ||
                  to_char(s.last_used at time zone 'America/New_York', 'Mon DD HH12:MI AM') || ' ET from IP ' || coalesce(s.ip, '?') || ' (' || left(s.ua, 120) || ').';
      else
        title := 'New sign-in from a new device or location';
        detail := s.email || ' signed in at ' || to_char(s.created_at at time zone 'America/New_York', 'Mon DD HH12:MI AM') || ' ET from IP ' || coalesce(s.ip, '?') ||
                  ' (' || left(s.ua, 120) || '). Authenticator used: ' || case when s.aal = 'aal2' then 'yes' else 'NO' end || '.';
      end if;
      return next;
    end if;
    known := known || jsonb_build_object(s.dev, s.created_at);
  end loop;
  insert into watchdog_state values ('known_devices', known, now()) on conflict (key) do update set value = excluded.value, updated_at = now();

  -- 2) users, password/email and authenticator fingerprints
  fp := '{}'::jsonb;
  for u in select us.id::text id, us.email, md5(coalesce(us.encrypted_password, '')) pw,
                  coalesce((select string_agg(mf.id::text || ':' || mf.status::text, ',' order by mf.id) from auth.mfa_factors mf where mf.user_id = us.id), '') mfa
           from auth.users us loop
    fp := fp || jsonb_build_object(u.id, jsonb_build_object('email', u.email, 'pw', u.pw, 'mfa', u.mfa));
  end loop;
  select value into old_fp from watchdog_state where watchdog_state.key = 'auth_fingerprint';
  if old_fp is not null and (select value from watchdog_state where watchdog_state.key = 'baseline_done') is not null then
    for uid in select jsonb_object_keys(fp) loop
      if not old_fp ? uid then
        key := 'sec:newuser:' || uid; title := 'A new account was created';
        detail := 'New account ' || (fp -> uid ->> 'email') || ' now exists in your app. If you did not create it, tell Claude right away.'; return next;
        continue;
      end if;
      if (fp -> uid ->> 'email') is distinct from (old_fp -> uid ->> 'email') then
        key := 'sec:email:' || uid || ':' || md5(fp -> uid ->> 'email'); title := 'Account email address changed';
        detail := 'Sign-in email changed from ' || (old_fp -> uid ->> 'email') || ' to ' || (fp -> uid ->> 'email') || '.'; return next;
      end if;
      if (fp -> uid ->> 'pw') is distinct from (old_fp -> uid ->> 'pw') then
        key := 'sec:pw:' || uid || ':' || (fp -> uid ->> 'pw'); title := 'Password changed';
        detail := 'The password for ' || (fp -> uid ->> 'email') || ' was changed.'; return next;
      end if;
      if (fp -> uid ->> 'mfa') is distinct from (old_fp -> uid ->> 'mfa') then
        key := 'sec:mfa:' || uid || ':' || md5(fp -> uid ->> 'mfa'); title := 'Authenticator settings changed';
        detail := 'An authenticator was added, removed or re-verified for ' || (fp -> uid ->> 'email') || '.'; return next;
      end if;
    end loop;
  end if;
  insert into watchdog_state values ('auth_fingerprint', fp, now()) on conflict (key) do update set value = excluded.value, updated_at = now();
  insert into watchdog_state values ('baseline_done', 'true'::jsonb, now()) on conflict (key) do nothing;
end $function$
;

CREATE OR REPLACE FUNCTION public.pbm_weekly_learn()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  w_cur numeric := pbm_param('alt_model_weight', 0.5);
  s_cur numeric := pbm_param('margin_sigma', 13.45);
  p record; n_games int; n_lines int; best_w numeric; best_s numeric; ll_cur numeric; ll_best numeric;
  cur_season int; cur_week int; out jsonb := '[]'::jsonb; act text; newv numeric;
begin
  select season, week into cur_season, cur_week from games where home_score is not null order by kickoff_utc desc limit 1;

  create temp table _d on commit drop as
  select l.game_id, l.model_prob, l.kalshi_prob, l.team_margin, l.threshold,
         case when r.result = 'WIN' then 1 else 0 end as hit
  from alt_picks_log l join alt_record r using (ticker)
  where r.result in ('WIN', 'LOSS') and l.model_prob is not null and l.kalshi_prob is not null and l.team_margin is not null
    and l.logged_at > now() - interval '8 weeks';
  select count(distinct game_id), count(*) into n_games, n_lines from _d;

  -- 1) model weight: which blend of our model and Kalshi predicted best?
  with g as (select generate_series(20, 70, 5) / 100.0 as w),
  s as (select g.w, -avg(d.hit * ln(greatest(least(g.w * pbm_phi((d.team_margin - d.threshold) / s_cur) + (1 - g.w) * d.kalshi_prob, 0.999), 0.001))
                   + (1 - d.hit) * ln(greatest(1 - least(g.w * pbm_phi((d.team_margin - d.threshold) / s_cur) + (1 - g.w) * d.kalshi_prob, 0.999), 0.001))) as ll
        from g cross join _d d group by g.w)
  select (select w from s order by ll limit 1), (select ll from s order by ll limit 1),
         (select ll from s where abs(w - w_cur) < 0.001) into best_w, ll_best, ll_cur;
  select * into p from model_params where key = 'alt_model_weight';
  if n_games < p.min_games then act := 'held: only ' || n_games || ' of ' || p.min_games || ' games needed'; newv := w_cur;
  elsif ll_cur is null or ll_best >= ll_cur * 0.99 then act := 'held: no clearly better value'; newv := w_cur;
  else newv := round(w_cur + sign(best_w - w_cur) * least(p.max_step, abs(best_w - w_cur)), 3);
       newv := greatest(p.min_value, least(p.max_value, newv)); act := 'changed';
       update model_params set value = newv, updated_at = now() where key = p.key;
  end if;
  insert into model_param_history (season, week, key, old_value, new_value, best_value, n_games, n_lines, logloss_current, logloss_best, action)
  values (cur_season, cur_week, 'alt_model_weight', w_cur, newv, best_w, n_games, n_lines, round(ll_cur, 4), round(ll_best, 4), act);
  out := out || jsonb_build_object('key', 'alt_model_weight', 'from', w_cur, 'to', newv, 'best', best_w, 'action', act);
  w_cur := newv;

  -- 2) margin spread (sigma), using the (possibly updated) weight
  with g as (select generate_series(1100, 1600, 25) / 100.0 as s),
  x as (select g.s, -avg(d.hit * ln(greatest(least(w_cur * pbm_phi((d.team_margin - d.threshold) / g.s) + (1 - w_cur) * d.kalshi_prob, 0.999), 0.001))
                   + (1 - d.hit) * ln(greatest(1 - least(w_cur * pbm_phi((d.team_margin - d.threshold) / g.s) + (1 - w_cur) * d.kalshi_prob, 0.999), 0.001))) as ll
        from g cross join _d d group by g.s)
  select (select s from x order by ll limit 1), (select ll from x order by ll limit 1),
         (select ll from x order by abs(s - s_cur) limit 1) into best_s, ll_best, ll_cur;
  select * into p from model_params where key = 'margin_sigma';
  if n_games < p.min_games then act := 'held: only ' || n_games || ' of ' || p.min_games || ' games needed'; newv := s_cur;
  elsif ll_cur is null or ll_best >= ll_cur * 0.99 then act := 'held: no clearly better value'; newv := s_cur;
  else newv := round(s_cur + sign(best_s - s_cur) * least(p.max_step, abs(best_s - s_cur)), 3);
       newv := greatest(p.min_value, least(p.max_value, newv)); act := 'changed';
       update model_params set value = newv, updated_at = now() where key = p.key;
  end if;
  insert into model_param_history (season, week, key, old_value, new_value, best_value, n_games, n_lines, logloss_current, logloss_best, action)
  values (cur_season, cur_week, 'margin_sigma', s_cur, newv, best_s, n_games, n_lines, round(ll_cur, 4), round(ll_best, 4), act);
  out := out || jsonb_build_object('key', 'margin_sigma', 'from', s_cur, 'to', newv, 'best', best_s, 'action', act);
  return out;
end $function$
;

CREATE OR REPLACE FUNCTION public.pbm_withdrawal_update(p_id bigint, p_action text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare w record; is_owner boolean := pbm_my_role() = 'owner';
begin
  select * into w from member_withdrawals where id = p_id;
  if not found or w.status <> 'requested' then raise exception 'not an open request'; end if;
  if p_action = 'paid' then
    if not is_owner then raise exception 'owner only'; end if;
    update member_withdrawals set status = 'paid', done_at = now() where id = p_id;
  elsif p_action = 'cancel' then
    if not (is_owner or w.user_id = auth.uid()) then raise exception 'not allowed'; end if;
    update member_withdrawals set status = 'cancelled', done_at = now() where id = p_id;
    update app_members set bankroll_start = bankroll_start + w.amount where user_id = w.user_id;
    insert into member_money_log (member_email, amount, kind, note, created_by) values (w.member_email, w.amount, 'deposit', 'withdrawal #' || p_id || ' cancelled - money back', auth.uid());
  else raise exception 'bad action'; end if;
  return p_action;
end $function$
;

CREATE OR REPLACE FUNCTION public.pbm_y_snapshot()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare n int := 0; c int;
begin
  -- Y tracking only (no bets): the first time a team in a LIVE game is priced 85-97c to win
  insert into public.y_log (game_id, team, kind, price)
  select g.game_id, x.team, 'leader85', x.ask
  from public.games g join public.kalshi_markets k using (game_id)
  cross join lateral (values (g.home_team, k.home_yes_ask::numeric), (g.away_team, k.away_yes_ask::numeric)) x(team, ask)
  where g.kickoff_utc < now() and g.kickoff_utc > now() - interval '5 hours' and g.home_score is null
    and k.fetched_at > now() - interval '20 minutes' and x.ask between 0.85 and 0.97
  on conflict do nothing;
  get diagnostics c = row_count; n := n + c;
  -- after a Bail Out: the price of the OTHER (winning) team at that moment
  insert into public.y_log (game_id, team, kind, price, bet_id)
  select b.game_id, case when b.ticker = k.home_ticker then g.away_team else g.home_team end, 'after_bailout',
         case when b.ticker = k.home_ticker then k.away_yes_ask::numeric else k.home_yes_ask::numeric end, b.id
  from public.my_bets b join public.games g using (game_id) join public.kalshi_markets k using (game_id)
  where b.status = 'cashed_out' and b.market <> 'parlay' and b.side = 'yes' and b.settled_at > now() - interval '30 minutes'
  on conflict do nothing;
  get diagnostics c = row_count; n := n + c;
  update public.y_log l set result = case when (case when l.team = g.home_team then g.home_score - g.away_score else g.away_score - g.home_score end) > 0 then 'win'
                                          when g.home_score = g.away_score then 'tie' else 'loss' end
  from public.games g where g.game_id = l.game_id and l.result is null and g.home_score is not null;
  return n;
end $function$
;

CREATE OR REPLACE FUNCTION public.pbm_zplus_snapshot()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare n int;
begin
  insert into public.zplus_log as l (game_id, team, season, week, kickoff_utc, ticker, first_model, first_ask, last_seen, last_model, last_ask, tier)
  select game_id, team, season, week, kickoff_utc, ticker, model_prob, ask, now(), model_prob, ask, tier
  from public.zplus_board where open
  on conflict (game_id, team) do update set last_seen = now(), last_model = excluded.last_model, last_ask = excluded.last_ask, ticker = excluded.ticker, tier = excluded.tier;
  get diagnostics n = row_count;
  update public.zplus_log l set result = case when (case when l.team = g.home_team then g.home_score - g.away_score else g.away_score - g.home_score end) > 0 then 'win'
                                               when g.home_score = g.away_score then 'tie' else 'loss' end
  from public.games g where g.game_id = l.game_id and l.result is null and g.home_score is not null;
  return n;
end $function$
;

CREATE OR REPLACE FUNCTION public.run_engine_after_inactives()
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare k timestamptz; tok text; n int := 0;
begin
  select value into tok from private_config where key = 'cron_token';
  for k in
    select distinct kickoff_utc from games
    where home_score is null and kickoff_utc between now() + interval '20 minutes' and now() + interval '90 minutes'
      and now() >= kickoff_utc - interval '85 minutes'
  loop
    if not exists (select 1 from engine_triggers where slot = k and status in ('started', 'already_running')) then
      insert into engine_triggers (source, slot, status) values ('schedule', k, 'requested');
      perform net.http_post(url := 'https://ljlzpysnikwbhspzlpmu.supabase.co/functions/v1/pbm-engine-trigger',
        body := jsonb_build_object('action', 'run', 'slot', k),
        headers := jsonb_build_object('Content-Type', 'application/json', 'x-pbm-cron', tok), timeout_milliseconds := 15000);
      n := n + 1;
    end if;
  end loop;
  return format('%s refresh(es) requested', n);
end $function$
;

CREATE OR REPLACE FUNCTION public.run_gameday_scans_if_due()
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare d date := (now() at time zone 'America/New_York')::date;
        k timestamptz; tok text; s int; w int; o record; n_out int := 0; n_core int := 0;
begin
  select min(kickoff_utc), min(season), min(week) into k, s, w
  from games where game_date_et = d and home_score is null;
  if k is null then return 'no games today'; end if;
  if now() < k - interval '2 hours' or now() >= k then return 'not in window'; end if;
  if exists (select 1 from agent_runs where run_date = d) then return 'already ran today'; end if;
  insert into agent_runs (run_date, first_kickoff) values (d, k);

  select value into tok from private_config where key = 'cron_token';
  for o in select id from panel_outlets where active loop
    perform net.http_post(url := 'https://ljlzpysnikwbhspzlpmu.supabase.co/functions/v1/pbm-panel-agent',
      body := jsonb_build_object('outlet_id', o.id, 'season', s, 'week', w),
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-pbm-cron', tok), timeout_milliseconds := 10000);
    n_out := n_out + 1;
  end loop;
  for o in select id from experts where active and coalesce(tier, 'core') = 'core' loop
    perform net.http_post(url := 'https://ljlzpysnikwbhspzlpmu.supabase.co/functions/v1/pbm-expert-agent',
      body := jsonb_build_object('expert_id', o.id, 'season', s, 'week', w),
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-pbm-cron', tok), timeout_milliseconds := 10000);
    n_core := n_core + 1;
  end loop;
  update agent_runs set outlets = n_out, core_experts = n_core where run_date = d;
  return format('scanned %s outlets + %s core experts', n_out, n_core);
end $function$
;

CREATE OR REPLACE FUNCTION public.run_panel_agents()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare o record; tok text; s int; w int;
begin
  select value into tok from private_config where key = 'cron_token';
  select season, week into s, w from games where home_score is null and kickoff_utc > now() order by kickoff_utc limit 1;
  if s is null then return; end if;
  for o in select id from panel_outlets where active loop
    perform net.http_post(
      url := 'https://ljlzpysnikwbhspzlpmu.supabase.co/functions/v1/pbm-panel-agent',
      body := jsonb_build_object('outlet_id', o.id, 'season', s, 'week', w),
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-pbm-cron', tok),
      timeout_milliseconds := 10000);
  end loop;
end $function$
;

CREATE OR REPLACE FUNCTION public.slip_parlays_remember_dismiss()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
begin
  if old.auto_added and coalesce(current_setting('pbm.sync', true), '') <> 'on' then
    insert into bet_cart_dismissed (user_id, ticker, side) values (old.user_id, old.leg_key, 'parlay') on conflict do nothing;
  end if;
  return old;
end $function$
;

CREATE OR REPLACE FUNCTION public.snapshot_shadow_slate(d date)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare first_kick timestamptz;
begin
  if exists (select 1 from shadow_slate_sheets where game_date_et = d and is_final) then return; end if;
  select min(kickoff_utc) into first_kick from games where game_date_et = d;
  if first_kick is null then return; end if;
  insert into shadow_slate_sheets (game_date_et, slate, season, week, is_final, generated_at, payload)
  select d, max(slate), max(season), max(week), now() >= first_kick, now(),
         jsonb_agg(to_jsonb(b) order by b.kickoff_utc, b.bet_score desc)
  from shadow_game_board b where b.game_date_et = d
  on conflict (game_date_et) do update
    set payload = excluded.payload, generated_at = excluded.generated_at, is_final = excluded.is_final;
end $function$
;

CREATE OR REPLACE FUNCTION public.snapshot_slate(d date)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
-- 2026-10-19: lock each GAME at its own kickoff (was: the whole day froze at the day's first kickoff,
-- so a 1 PM / 4 PM game kept its 9:30 AM grade from before injury news and the scorecard disagreed with the grade we bet at)
declare first_kick timestamptz; last_kick timestamptz; old jsonb; fin boolean;
begin
  begin perform snapshot_shadow_slate(d); exception when others then null; end;
  if exists (select 1 from slate_sheets where game_date_et = d and is_final) then return; end if;
  select min(kickoff_utc), max(kickoff_utc) into first_kick, last_kick from games where game_date_et = d;
  if first_kick is null then return; end if;
  select payload into old from slate_sheets where game_date_et = d;
  fin := now() >= last_kick;
  insert into slate_sheets (game_date_et, slate, season, week, is_final, generated_at, payload)
  select d, max(b.slate), max(b.season), max(b.week), fin, now(),
         jsonb_agg(coalesce(
           case when b.kickoff_utc <= now() then
             (select e from jsonb_array_elements(coalesce(old, '[]'::jsonb)) e where e->>'game_id' = b.game_id limit 1) end,
           to_jsonb(b)) order by b.kickoff_utc, b.bet_score desc)
  from game_board b where b.game_date_et = d
  on conflict (game_date_et) do update
    set payload = excluded.payload, generated_at = excluded.generated_at, is_final = excluded.is_final;
end $function$
;
