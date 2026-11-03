create policy read_all on public.agent_lessons as PERMISSIVE for SELECT to authenticated
  using (true);

create policy read_all on public.agent_runs as PERMISSIVE for SELECT to authenticated
  using (true);

create policy read_all on public.agent_usage as PERMISSIVE for SELECT to authenticated
  using (true);

create policy own_insert on public.alert_settings as PERMISSIVE for INSERT to authenticated
  with check ((user_id = auth.uid()));

create policy own_select on public.alert_settings as PERMISSIVE for SELECT to authenticated
  using ((user_id = auth.uid()));

create policy own_update on public.alert_settings as PERMISSIVE for UPDATE to authenticated
  using ((user_id = auth.uid()))
  with check ((user_id = auth.uid()));

create policy read_all on public.alt_picks_log as PERMISSIVE for SELECT to authenticated
  using (true);

create policy app_members_self on public.app_members as PERMISSIVE for SELECT to authenticated
  using (((lower(email) = lower((auth.jwt() ->> 'email'::text))) OR (pbm_my_role() = 'owner'::text)));

create policy own_select on public.auto_trader_log as PERMISSIVE for SELECT to authenticated
  using ((user_id = auth.uid()));

create policy own_select on public.auto_trader_settings as PERMISSIVE for SELECT to authenticated
  using ((user_id = auth.uid()));

create policy own_briefings on public.bet_briefings as PERMISSIVE for SELECT to authenticated
  using ((user_id = auth.uid()));

create policy own_cart on public.bet_cart as PERMISSIVE for ALL to authenticated
  using ((user_id = auth.uid()))
  with check ((user_id = auth.uid()));

create policy own_dismissed on public.bet_cart_dismissed as PERMISSIVE for SELECT to authenticated
  using ((user_id = auth.uid()));

create policy read_all on public.closing_lines as PERMISSIVE for SELECT to authenticated
  using (true);

create policy read_all on public.ee_findings as PERMISSIVE for SELECT to authenticated
  using (true);

create policy read_all on public.ee_injury_events as PERMISSIVE for SELECT to authenticated
  using (true);

create policy read_all on public.ee_kalshi_vegas as PERMISSIVE for SELECT to authenticated
  using (true);

create policy own_seen on public.ee_seen as PERMISSIVE for ALL to authenticated
  using ((user_id = auth.uid()))
  with check ((user_id = auth.uid()));

create policy read_all on public.ee_signals as PERMISSIVE for SELECT to authenticated
  using (true);

create policy own_select on public.email_log as PERMISSIVE for SELECT to authenticated
  using ((user_id = auth.uid()));

create policy read_all on public.engine_triggers as PERMISSIVE for SELECT to authenticated
  using (true);

create policy read_expert_picks on public.expert_picks as PERMISSIVE for SELECT to authenticated
  using (true);

create policy read_expert_scans on public.expert_scans as PERMISSIVE for SELECT to authenticated
  using (true);

create policy read_experts on public.experts as PERMISSIVE for SELECT to authenticated
  using (true);

create policy fa_own on public.funds_alerts as PERMISSIVE for SELECT to authenticated
  using ((user_id = auth.uid()));

create policy read_games on public.games as PERMISSIVE for SELECT to authenticated
  using (true);

create policy read_all on public.hist_games as PERMISSIVE for SELECT to authenticated
  using (true);

create policy read_all on public.hist_injuries as PERMISSIVE for SELECT to authenticated
  using (true);

create policy read_all on public.hist_kalshi_markets as PERMISSIVE for SELECT to authenticated
  using (true);

create policy read_all on public.hist_kalshi_prices as PERMISSIVE for SELECT to authenticated
  using (true);

create policy read_all on public.hist_load_log as PERMISSIVE for SELECT to authenticated
  using (true);

create policy read_all on public.hist_snaps as PERMISSIVE for SELECT to authenticated
  using (true);

create policy hr_read on public.hr_game_lines as PERMISSIVE for SELECT to authenticated
  using (true);

create policy jamie_baselines_read on public.jamie_baselines as PERMISSIVE for SELECT to authenticated
  using (true);

create policy jamie_game_parlays_read on public.jamie_game_parlays as PERMISSIVE for SELECT to authenticated
  using (true);

create policy jamie_leg_log_read on public.jamie_leg_log as PERMISSIVE for SELECT to authenticated
  using (true);

create policy jamie_legs_read on public.jamie_legs as PERMISSIVE for SELECT to authenticated
  using (true);

create policy jamie_market_prior_read on public.jamie_market_prior as PERMISSIVE for SELECT to authenticated
  using (true);

create policy jamie_parlay_log_read on public.jamie_parlay_log as PERMISSIVE for SELECT to authenticated
  using (true);

create policy jamie_parlays_read on public.jamie_parlays as PERMISSIVE for SELECT to authenticated
  using (true);

create policy jamie_player_stats_read on public.jamie_player_stats as PERMISSIVE for SELECT to authenticated
  using (true);

create policy jtm_read on public.jamie_ticker_map as PERMISSIVE for SELECT to authenticated
  using (true);

create policy read_all on public.kalshi_alt_lines as PERMISSIVE for SELECT to authenticated
  using (true);

create policy read_all on public.kalshi_big_trades as PERMISSIVE for SELECT to authenticated
  using (true);

create policy kd_owner on public.kalshi_deposits as PERMISSIVE for SELECT to authenticated
  using ((pbm_my_role() = 'owner'::text));

create policy read_all on public.kalshi_flow_cursor as PERMISSIVE for SELECT to authenticated
  using (true);

create policy read_all on public.kalshi_flow_hourly as PERMISSIVE for SELECT to authenticated
  using (true);

create policy read_all on public.kalshi_markets as PERMISSIVE for SELECT to authenticated
  using (true);

create policy read_all on public.kalshi_price_history as PERMISSIVE for SELECT to authenticated
  using (true);

create policy kalshi_status_read on public.kalshi_status as PERMISSIVE for SELECT to authenticated
  using (true);

create policy ktl_read on public.kalshi_total_lines as PERMISSIVE for SELECT to authenticated
  using (true);

create policy read_all on public.learning_runs as PERMISSIVE for SELECT to authenticated
  using (true);

create policy mdc_read on public.member_deposit_claims as PERMISSIVE for SELECT to authenticated
  using (((user_id = auth.uid()) OR (pbm_my_role() = 'owner'::text)));

create policy mml_read on public.member_money_log as PERMISSIVE for SELECT to authenticated
  using (((pbm_my_role() = 'owner'::text) OR (lower(member_email) = lower((auth.jwt() ->> 'email'::text)))));

create policy mw_read on public.member_withdrawals as PERMISSIVE for SELECT to authenticated
  using (((user_id = auth.uid()) OR (pbm_my_role() = 'owner'::text)));

create policy read_all on public.model_param_history as PERMISSIVE for SELECT to authenticated
  using (true);

create policy read_all on public.model_params as PERMISSIVE for SELECT to authenticated
  using (true);

create policy read_model_runs on public.model_runs as PERMISSIVE for SELECT to authenticated
  using (true);

create policy own_bets on public.my_bets as PERMISSIVE for ALL to authenticated
  using ((user_id = auth.uid()))
  with check ((user_id = auth.uid()));

create policy read_news_intel on public.news_intel as PERMISSIVE for SELECT to authenticated
  using (true);

create policy read_all on public.news_intel_log as PERMISSIVE for SELECT to authenticated
  using (true);

create policy read_all on public.odds_backfill as PERMISSIVE for SELECT to authenticated
  using (true);

create policy read_all on public.odds_line_history as PERMISSIVE for SELECT to authenticated
  using (true);

create policy read_all on public.panel_outlets as PERMISSIVE for SELECT to authenticated
  using (true);

create policy read_all on public.panel_scans as PERMISSIVE for SELECT to authenticated
  using (true);

create policy read_all on public.parlay_log as PERMISSIVE for SELECT to authenticated
  using (true);

create policy read_predictions on public.predictions as PERMISSIVE for SELECT to authenticated
  using (true);

create policy read_predictions_log on public.predictions_log as PERMISSIVE for SELECT to authenticated
  using (true);

create policy qb_regular_read on public.qb_regular as PERMISSIVE for SELECT to authenticated
  using (true);

create policy qb_status_read on public.qb_status as PERMISSIVE for SELECT to authenticated
  using (true);

create policy roll_chains_own on public.roll_chains as PERMISSIVE for SELECT to authenticated
  using ((user_id = auth.uid()));

create policy sp_read on public.shadow_predictions as PERMISSIVE for SELECT to authenticated
  using (true);

create policy sss_read on public.shadow_slate_sheets as PERMISSIVE for SELECT to authenticated
  using (true);

create policy st_read on public.shadow_totals as PERMISSIVE for SELECT to authenticated
  using (true);

create policy stl_read on public.shadow_totals_log as PERMISSIVE for SELECT to authenticated
  using (true);

create policy site_pages_read on public.site_pages as PERMISSIVE for SELECT to anon, authenticated
  using (true);

create policy read_slate_sheets on public.slate_sheets as PERMISSIVE for SELECT to authenticated
  using (true);

create policy own_parlays on public.slip_parlays as PERMISSIVE for ALL to authenticated
  using ((user_id = auth.uid()))
  with check ((user_id = auth.uid()));

create policy sl_exp_read on public.sportsline_expert_picks as PERMISSIVE for SELECT to authenticated
  using (true);

create policy sl_proj_read on public.sportsline_projection as PERMISSIVE for SELECT to authenticated
  using (true);

create policy sl_hist_read on public.sportsline_projection_history as PERMISSIVE for SELECT to authenticated
  using (true);

create policy read_team_ratings on public.team_ratings as PERMISSIVE for SELECT to authenticated
  using (true);

create policy ta_own on public.terms_acceptances as PERMISSIVE for ALL to authenticated
  using ((user_id = auth.uid()))
  with check ((user_id = auth.uid()));

create policy wd_alerts_read on public.watchdog_alerts as PERMISSIVE for SELECT to authenticated
  using (true);

create policy read_weather on public.weather as PERMISSIVE for SELECT to authenticated
  using (true);

create policy zplus_log_read on public.zplus_log as PERMISSIVE for SELECT to authenticated
  using (true);
