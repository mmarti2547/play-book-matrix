-- Winner grade (main grade) + winner picks on the Bet Slip. Previous definitions saved in public.view_backups.
-- game_board: appended columns winner_rating (A+ .75 / A .68 / B+ .62 / B .57 / C .52 on predicted_winner_prob),
--   winner_kalshi_ask, winner_value_pts (our chance - Kalshi ask, pts), spread_edge_pts (|adj_margin - spread|).
-- bet_sheet: same four columns appended.
-- winner_kalshi_map: predicted winner -> KXNFLGAME ticker + ask.
-- pbm_fill_bet_slip: new step 1b adds A+/A winner picks (source 'moneyline') when our chance >= Kalshi ask,
--   one bet per game, at the member's own A+/A stake.
-- (Applied live 2026-11-09 via replace() on pg_get_viewdef / pg_get_functiondef; see view_backups for the before-state.)
create or replace view public.winner_kalshi_map as
select b.season, b.week, b.game_id, b.predicted_winner, b.predicted_winner_prob, b.winner_rating, b.winner_value_pts,
  b.predicted_winner || ' to win' as pick_label,
  case when b.predicted_winner = b.home_team then km.home_ticker else km.away_ticker end as ticker,
  'yes'::text as side, b.winner_kalshi_ask as price,
  'Buy YES on "' || b.predicted_winner || ' to win"' as how_to,
  'https://kalshi.com/markets/kxnflgame'::text as kalshi_url,
  (case when b.predicted_winner = b.home_team then km.home_ticker else km.away_ticker end) is not null as on_kalshi
from bet_sheet b left join kalshi_markets km using (game_id);
