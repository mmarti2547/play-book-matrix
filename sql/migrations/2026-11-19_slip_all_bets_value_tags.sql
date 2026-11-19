-- ===== PSQL WINDOW =====
-- 2026-11-19 owner request: put all A+/A winner bets (and props/parlays/spreads) back on the slip; tag each by price.
-- Applied live (backup in public.view_backups 'fn:pbm_fill_bet_slip (before restoring all bets + value_pts, 11/19)'):
alter table public.bet_cart add column if not exists value_pts numeric;   -- our chance minus Kalshi price, in points
-- pbm_fill_bet_slip: removed the 0.9x payout floor (price <= 0.526) and the winner 3-pt/85c rule (back to price < 0.95),
-- and at the end fills bet_cart.value_pts:
--   moneyline -> game_board.winner_value_pts; main_pick -> (ats_pick_prob - limit_price)*100; alt_line -> (alt_best_bets.our_prob - limit_price)*100
-- Front end (Lovable d91eaba): UNDERPRICED (>= +3, green glow), FAIR PRICE (0..3, amber), OVERPRICED (< 0, red glow).
-- 2026-11-19 later: PASS-graded spread picks go on the slip when our cover chance >= Kalshi price (stake = C max),
-- unless the game already has an A/A+ winner pick (the winner pick keeps the game's one slot). Backup: 'before PASS spreads with value, 11/19'.
