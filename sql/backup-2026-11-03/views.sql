create or replace view public.agent_cost_daily as
 SELECT ((created_at AT TIME ZONE 'America/New_York'::text))::date AS day,
    agent,
    count(*) AS calls,
    sum(input_tokens) AS input_tokens,
    sum(output_tokens) AS output_tokens,
    sum(web_searches) AS web_searches,
    round(sum(cost_usd), 2) AS cost_usd
   FROM agent_usage
  GROUP BY (((created_at AT TIME ZONE 'America/New_York'::text))::date), agent;

create or replace view public.agent_cost_weekly as
 SELECT w.season,
    w.week,
    u.agent,
    count(*) AS calls,
    sum(u.web_searches) AS web_searches,
    round(sum(u.cost_usd), 2) AS cost_usd
   FROM (agent_usage u
     JOIN LATERAL ( SELECT g.season,
            g.week
           FROM games g
          WHERE (((g.kickoff_utc AT TIME ZONE 'America/New_York'::text))::date >= (((u.created_at AT TIME ZONE 'America/New_York'::text))::date - 1))
          ORDER BY g.kickoff_utc
         LIMIT 1) w ON (true))
  GROUP BY w.season, w.week, u.agent;

create or replace view public.agent_progress as
 WITH t AS (
         SELECT max(engine_triggers.requested_at) AS last_trigger
           FROM engine_triggers
          WHERE (engine_triggers.status = ANY (ARRAY['requested'::text, 'started'::text, 'already_running'::text]))
        ), s AS (
         SELECT g.kickoff_utc,
            (g.kickoff_utc - '01:30:00'::interval) AS inactives_at,
            count(*) AS games,
            count(*) FILTER (WHERE (p.updated_at >= (g.kickoff_utc - '01:30:00'::interval))) AS model_done,
            count(*) FILTER (WHERE (n.scanned_at >= (g.kickoff_utc - '01:30:00'::interval))) AS news_done,
            max(n.scanned_at) AS last_news_at,
            max(p.updated_at) AS last_model_at
           FROM ((games g
             LEFT JOIN predictions p ON ((p.game_id = g.game_id)))
             LEFT JOIN news_intel n ON ((n.game_id = g.game_id)))
          WHERE ((g.home_score IS NULL) AND (g.kickoff_utc > (now() - '04:00:00'::interval)) AND (((g.kickoff_utc AT TIME ZONE 'America/New_York'::text))::date = ((now() AT TIME ZONE 'America/New_York'::text))::date))
          GROUP BY g.kickoff_utc
        )
 SELECT s.kickoff_utc,
    s.inactives_at,
    s.games,
    s.model_done,
    s.news_done,
    s.last_news_at,
    s.last_model_at,
    t.last_trigger,
        CASE
            WHEN (now() < s.inactives_at) THEN 'waiting'::text
            WHEN ((s.model_done = s.games) AND (s.news_done = s.games)) THEN 'finished'::text
            WHEN (now() >= s.kickoff_utc) THEN 'closed'::text
            WHEN ((t.last_trigger >= s.inactives_at) AND ((now() - t.last_trigger) < '00:25:00'::interval)) THEN 'running'::text
            WHEN (t.last_trigger >= s.inactives_at) THEN 'stalled'::text
            ELSE 'not_started'::text
        END AS status
   FROM (s
     CROSS JOIN t)
  ORDER BY s.kickoff_utc;

create or replace view public.alt_best_bets as
 SELECT ticker,
    event_ticker,
    game_id,
    season,
    week,
    slate,
    game_date_et,
    kickoff_utc,
    away_team,
    home_team,
    team,
    threshold,
    bet_label,
    yes_bid,
    yes_ask,
    kalshi_prob,
    volume,
    open_interest,
    fetched_at,
    model_prob,
    our_prob,
    fee,
    edge,
    edge_pts,
    roi,
    payout_multiple,
    risk_rating,
    risk_index,
    spread_line,
    ats_pick,
    game_rating,
    alt_score,
    grade,
    alt_rank,
    game_leg_rank,
    event_title,
    market_title,
    kalshi_url,
    prob_rank,
    rank() OVER (PARTITION BY season, week ORDER BY our_prob DESC, alt_score DESC) AS best_rank
   FROM ( SELECT DISTINCT ON (alt_lines_board.game_id) alt_lines_board.ticker,
            alt_lines_board.event_ticker,
            alt_lines_board.game_id,
            alt_lines_board.season,
            alt_lines_board.week,
            alt_lines_board.slate,
            alt_lines_board.game_date_et,
            alt_lines_board.kickoff_utc,
            alt_lines_board.away_team,
            alt_lines_board.home_team,
            alt_lines_board.team,
            alt_lines_board.threshold,
            alt_lines_board.bet_label,
            alt_lines_board.yes_bid,
            alt_lines_board.yes_ask,
            alt_lines_board.kalshi_prob,
            alt_lines_board.volume,
            alt_lines_board.open_interest,
            alt_lines_board.fetched_at,
            alt_lines_board.model_prob,
            alt_lines_board.our_prob,
            alt_lines_board.fee,
            alt_lines_board.edge,
            alt_lines_board.edge_pts,
            alt_lines_board.roi,
            alt_lines_board.payout_multiple,
            alt_lines_board.risk_rating,
            alt_lines_board.risk_index,
            alt_lines_board.spread_line,
            alt_lines_board.ats_pick,
            alt_lines_board.game_rating,
            alt_lines_board.alt_score,
            alt_lines_board.grade,
            alt_lines_board.alt_rank,
            alt_lines_board.game_leg_rank,
            alt_lines_board.event_title,
            alt_lines_board.market_title,
            alt_lines_board.kalshi_url,
            alt_lines_board.prob_rank
           FROM alt_lines_board
          WHERE (alt_lines_board.grade = ANY (ARRAY['A+'::text, 'A'::text, 'B+'::text, 'B'::text]))
          ORDER BY alt_lines_board.game_id, alt_lines_board.our_prob DESC, alt_lines_board.alt_score DESC) x;

create or replace view public.alt_lines_board as
 WITH legs AS (
         SELECT a.ticker,
            a.game_id,
            a.event_ticker,
            a.team,
            a.threshold,
            a.yes_bid,
            a.yes_ask,
            a.last_price,
            a.volume,
            a.open_interest,
            a.status,
            a.fetched_at,
            a.event_title,
            a.market_title,
            b.season,
            b.week,
            b.slate,
            b.game_date_et,
            b.kickoff_utc,
            b.home_team,
            b.away_team,
            b.adj_margin,
            b.risk_index,
            b.risk_rating,
            b.spread_line,
            b.ats_pick,
            b.rating AS game_rating,
                CASE
                    WHEN (a.team = b.home_team) THEN b.adj_margin
                    ELSE (- b.adj_margin)
                END AS team_margin,
                CASE
                    WHEN ((a.yes_bid > (0)::numeric) AND (a.yes_ask > a.yes_bid)) THEN ((a.yes_bid + a.yes_ask) / (2)::numeric)
                    ELSE COALESCE(a.last_price, a.yes_ask)
                END AS mid
           FROM (kalshi_alt_lines a
             JOIN game_board b USING (game_id))
          WHERE ((a.status = ANY (ARRAY['active'::text, 'open'::text])) AND (b.home_score IS NULL) AND (b.kickoff_utc > now()) AND (a.yes_ask >= 0.05) AND (a.yes_ask <= 0.95))
        ), priced AS (
         SELECT l.ticker,
            l.game_id,
            l.event_ticker,
            l.team,
            l.threshold,
            l.yes_bid,
            l.yes_ask,
            l.last_price,
            l.volume,
            l.open_interest,
            l.status,
            l.fetched_at,
            l.event_title,
            l.market_title,
            l.season,
            l.week,
            l.slate,
            l.game_date_et,
            l.kickoff_utc,
            l.home_team,
            l.away_team,
            l.adj_margin,
            l.risk_index,
            l.risk_rating,
            l.spread_line,
            l.ats_pick,
            l.game_rating,
            l.team_margin,
            l.mid,
            pbm_phi(((l.team_margin - l.threshold) / pbm_param('margin_sigma'::text, 13.45))) AS model_prob,
            ((pbm_param('alt_model_weight'::text, 0.5) * pbm_phi(((l.team_margin - l.threshold) / pbm_param('margin_sigma'::text, 13.45)))) + (((1)::numeric - pbm_param('alt_model_weight'::text, 0.5)) * l.mid)) AS blend_prob,
            pbm_kalshi_fee(l.yes_ask) AS fee
           FROM legs l
        ), scored AS (
         SELECT p.ticker,
            p.game_id,
            p.event_ticker,
            p.team,
            p.threshold,
            p.yes_bid,
            p.yes_ask,
            p.last_price,
            p.volume,
            p.open_interest,
            p.status,
            p.fetched_at,
            p.event_title,
            p.market_title,
            p.season,
            p.week,
            p.slate,
            p.game_date_et,
            p.kickoff_utc,
            p.home_team,
            p.away_team,
            p.adj_margin,
            p.risk_index,
            p.risk_rating,
            p.spread_line,
            p.ats_pick,
            p.game_rating,
            p.team_margin,
            p.mid,
            p.model_prob,
            p.blend_prob,
            p.fee,
            ((p.blend_prob - p.yes_ask) - p.fee) AS edge,
            (((p.blend_prob - p.yes_ask) - p.fee) / (p.yes_ask + p.fee)) AS roi,
            LEAST((
                CASE
                    WHEN (((p.blend_prob - p.yes_ask) - p.fee) <= (0)::numeric) THEN 35
                    ELSE 100
                END)::numeric, ((((100)::numeric * ((0.5 * LEAST((1)::numeric, GREATEST((0)::numeric, (((p.blend_prob - p.yes_ask) - p.fee) / 0.06)))) + (0.5 * LEAST((1)::numeric, (p.blend_prob / 0.65))))) * ((1)::numeric - (0.35 * COALESCE(p.risk_index, 0.5)))) *
                CASE
                    WHEN (((p.yes_ask - p.yes_bid) > 0.04) OR (COALESCE(p.volume, (0)::numeric) < (200)::numeric)) THEN 0.8
                    ELSE (1)::numeric
                END)) AS raw_score
           FROM priced p
        )
 SELECT ticker,
    event_ticker,
    game_id,
    season,
    week,
    slate,
    game_date_et,
    kickoff_utc,
    away_team,
    home_team,
    team,
    threshold,
    (((team || ' wins by '::text) || ((floor(threshold) + (1)::numeric))::integer) || '+'::text) AS bet_label,
    yes_bid,
    yes_ask,
    round(mid, 4) AS kalshi_prob,
    volume,
    open_interest,
    fetched_at,
    round(model_prob, 4) AS model_prob,
    round(blend_prob, 4) AS our_prob,
    round(fee, 2) AS fee,
    round(edge, 4) AS edge,
    round(((100)::numeric * edge), 1) AS edge_pts,
    round(roi, 3) AS roi,
    round(((1)::numeric / NULLIF((yes_ask + fee), (0)::numeric)), 2) AS payout_multiple,
    risk_rating,
    round(risk_index, 3) AS risk_index,
    spread_line,
    ats_pick,
    game_rating,
    (round(LEAST((100)::numeric, GREATEST((0)::numeric, raw_score))))::integer AS alt_score,
        CASE
            WHEN (raw_score >= (80)::numeric) THEN 'A+'::text
            WHEN (raw_score >= (70)::numeric) THEN 'A'::text
            WHEN (raw_score >= (60)::numeric) THEN 'B+'::text
            WHEN (raw_score >= (50)::numeric) THEN 'B'::text
            WHEN (raw_score >= (40)::numeric) THEN 'C'::text
            WHEN (raw_score >= (20)::numeric) THEN 'D'::text
            ELSE 'F'::text
        END AS grade,
    rank() OVER (PARTITION BY season, week ORDER BY raw_score DESC, s.edge DESC) AS alt_rank,
    rank() OVER (PARTITION BY game_id ORDER BY raw_score DESC, s.edge DESC) AS game_leg_rank,
    event_title,
    market_title,
    ('https://kalshi.com/markets/kxnflspread/pro-football-spread/'::text || lower(event_ticker)) AS kalshi_url,
    rank() OVER (PARTITION BY season, week ORDER BY blend_prob DESC) AS prob_rank
   FROM scored s;

create or replace view public.alt_parlay_bundle as
 SELECT b.bundle_slot,
    b.shared_games,
    a.season,
    a.week,
    a.legs,
    a.tickers,
    a.leg_detail,
    a.first_kickoff,
    a.our_prob,
    a.kalshi_prob,
    a.fair_cost_if_legs_bought_separately,
    a.max_price_to_pay,
    a.edge_vs_kalshi,
    a.parlay_score,
    a.variance,
    a.parlay_rank,
    a.prob_rank,
    a.parlay_grade
   FROM (alt_parlays a
     JOIN alt_parlay_bundle_pick() b(season, week, tickers, bundle_slot, shared_games) ON (((a.season = b.season) AND (a.week = b.week) AND (a.tickers = b.tickers))));

create or replace view public.alt_parlay_swaps as
 WITH b AS (
         SELECT alt_parlay_bundle.bundle_slot,
            alt_parlay_bundle.season,
            alt_parlay_bundle.week,
            alt_parlay_bundle.tickers,
            alt_parlay_bundle.our_prob,
            alt_parlay_bundle.kalshi_prob,
            alt_parlay_bundle.leg_detail
           FROM alt_parlay_bundle
        ), legs AS (
         SELECT b.bundle_slot,
            b.season,
            b.week,
            b.tickers,
            b.our_prob,
            b.kalshi_prob,
            b.leg_detail,
            (l.ord)::integer AS leg_no,
            l.leg
           FROM b,
            LATERAL jsonb_array_elements(b.leg_detail) WITH ORDINALITY l(leg, ord)
        ), cand AS (
         SELECT alt_lines_board.ticker,
            alt_lines_board.event_ticker,
            alt_lines_board.game_id,
            alt_lines_board.season,
            alt_lines_board.week,
            alt_lines_board.slate,
            alt_lines_board.game_date_et,
            alt_lines_board.kickoff_utc,
            alt_lines_board.away_team,
            alt_lines_board.home_team,
            alt_lines_board.team,
            alt_lines_board.threshold,
            alt_lines_board.bet_label,
            alt_lines_board.yes_bid,
            alt_lines_board.yes_ask,
            alt_lines_board.kalshi_prob,
            alt_lines_board.volume,
            alt_lines_board.open_interest,
            alt_lines_board.fetched_at,
            alt_lines_board.model_prob,
            alt_lines_board.our_prob,
            alt_lines_board.fee,
            alt_lines_board.edge,
            alt_lines_board.edge_pts,
            alt_lines_board.roi,
            alt_lines_board.payout_multiple,
            alt_lines_board.risk_rating,
            alt_lines_board.risk_index,
            alt_lines_board.spread_line,
            alt_lines_board.ats_pick,
            alt_lines_board.game_rating,
            alt_lines_board.alt_score,
            alt_lines_board.grade,
            alt_lines_board.alt_rank,
            alt_lines_board.game_leg_rank,
            alt_lines_board.event_title,
            alt_lines_board.market_title,
            alt_lines_board.kalshi_url,
            alt_lines_board.prob_rank
           FROM alt_lines_board
          WHERE ((alt_lines_board.grade = ANY (ARRAY['A+'::text, 'A'::text, 'B+'::text, 'B'::text])) AND (alt_lines_board.our_prob >= 0.35))
        ), s AS (
         SELECT lg.bundle_slot,
            lg.season,
            lg.week,
            lg.leg_no,
            (lg.leg ->> 'ticker'::text) AS replace_ticker,
            (lg.leg ->> 'bet_label'::text) AS replace_label,
            ((lg.leg ->> 'our_prob'::text))::numeric AS replace_prob,
            c.ticker,
            c.bet_label,
            c.game_id,
            c.away_team,
            c.home_team,
            c.kickoff_utc,
            c.grade,
            c.alt_score,
            c.our_prob AS leg_prob,
            c.yes_ask,
            c.kalshi_url,
            c.risk_index,
                CASE
                    WHEN (c.game_id = (lg.leg ->> 'game_id'::text)) THEN 'Same game, different line'::text
                    ELSE 'Different game'::text
                END AS swap_type,
            lg.our_prob AS old_parlay_prob,
            ((lg.our_prob / NULLIF(((lg.leg ->> 'our_prob'::text))::numeric, (0)::numeric)) * c.our_prob) AS new_prob,
            ((lg.kalshi_prob / NULLIF(((lg.leg ->> 'kalshi_prob'::text))::numeric, (0)::numeric)) * c.kalshi_prob) AS new_kalshi,
            ( SELECT count(*) AS count
                   FROM alt_parlay_bundle o,
                    LATERAL jsonb_array_elements(o.leg_detail) x(value)
                  WHERE ((o.bundle_slot <> lg.bundle_slot) AND ((x.value ->> 'game_id'::text) = c.game_id))) AS used_in_other_parlays,
            ( SELECT max(((x.value ->> 'risk_index'::text))::numeric) AS max
                   FROM jsonb_array_elements(lg.leg_detail) x(value)
                  WHERE ((x.value ->> 'ticker'::text) <> (lg.leg ->> 'ticker'::text))) AS other_risk
           FROM (legs lg
             JOIN cand c ON (((c.season = lg.season) AND (c.week = lg.week) AND (c.ticker <> (lg.leg ->> 'ticker'::text)) AND ((c.game_id = (lg.leg ->> 'game_id'::text)) OR (NOT (EXISTS ( SELECT 1
                   FROM jsonb_array_elements(lg.leg_detail) x(value)
                  WHERE ((x.value ->> 'game_id'::text) = c.game_id))))))))
        ), g AS (
         SELECT s.bundle_slot,
            s.season,
            s.week,
            s.leg_no,
            s.replace_ticker,
            s.replace_label,
            s.replace_prob,
            s.ticker,
            s.bet_label,
            s.game_id,
            s.away_team,
            s.home_team,
            s.kickoff_utc,
            s.grade,
            s.alt_score,
            s.leg_prob,
            s.yes_ask,
            s.kalshi_url,
            s.risk_index,
            s.swap_type,
            s.old_parlay_prob,
            s.new_prob,
            s.new_kalshi,
            s.used_in_other_parlays,
            s.other_risk,
            (((100)::numeric * ((0.5 * LEAST((1)::numeric, GREATEST((0)::numeric, (((s.new_prob / NULLIF(s.new_kalshi, (0)::numeric)) - (1)::numeric) / 0.25)))) + (0.5 * LEAST((1)::numeric, (s.new_prob / 0.30))))) * ((1)::numeric - (0.35 * GREATEST(COALESCE(s.other_risk, (0)::numeric), COALESCE(s.risk_index, (0)::numeric))))) AS raw
           FROM s
        )
 SELECT bundle_slot,
    season,
    week,
    leg_no,
    replace_ticker,
    replace_label,
    round(replace_prob, 4) AS replace_prob,
    ticker,
    bet_label,
    game_id,
    away_team,
    home_team,
    kickoff_utc,
    grade AS leg_grade,
    alt_score,
    round(leg_prob, 4) AS leg_prob,
    yes_ask,
    kalshi_url,
    swap_type,
    used_in_other_parlays,
    round(old_parlay_prob, 4) AS old_parlay_prob,
    round(new_prob, 4) AS new_parlay_prob,
    round((new_prob - old_parlay_prob), 4) AS prob_change,
    round(new_kalshi, 4) AS new_kalshi_prob,
    round(new_prob, 4) AS new_max_price_to_pay,
    (round(raw))::integer AS new_parlay_score,
        CASE
            WHEN (raw >= (80)::numeric) THEN 'A+'::text
            WHEN (raw >= (70)::numeric) THEN 'A'::text
            WHEN (raw >= (60)::numeric) THEN 'B+'::text
            WHEN (raw >= (50)::numeric) THEN 'B'::text
            WHEN (raw >= (40)::numeric) THEN 'C'::text
            WHEN (raw >= (20)::numeric) THEN 'D'::text
            ELSE 'F'::text
        END AS new_parlay_grade,
    rank() OVER (PARTITION BY bundle_slot, leg_no ORDER BY (used_in_other_parlays = 0) DESC, raw DESC, new_prob DESC) AS swap_rank
   FROM g;

create or replace view public.alt_parlays as
 WITH best AS (
         SELECT DISTINCT ON (b.game_id) b.ticker,
            b.event_ticker,
            b.game_id,
            b.season,
            b.week,
            b.slate,
            b.game_date_et,
            b.kickoff_utc,
            b.away_team,
            b.home_team,
            b.team,
            b.threshold,
            b.bet_label,
            b.yes_bid,
            b.yes_ask,
            b.kalshi_prob,
            b.volume,
            b.open_interest,
            b.fetched_at,
            b.model_prob,
            b.our_prob,
            b.fee,
            b.edge,
            b.edge_pts,
            b.roi,
            b.payout_multiple,
            b.risk_rating,
            b.risk_index,
            b.spread_line,
            b.ats_pick,
            b.game_rating,
            b.alt_score,
            b.grade,
            b.alt_rank,
            b.game_leg_rank,
            b.event_title,
            b.market_title,
            b.kalshi_url,
            b.prob_rank
           FROM alt_lines_board b
          WHERE ((b.grade = ANY (ARRAY['A+'::text, 'A'::text, 'B+'::text, 'B'::text])) AND (b.our_prob >= 0.35))
          ORDER BY b.game_id, b.our_prob DESC
        ), two AS (
         SELECT a.season,
            a.week,
            2 AS legs,
            ARRAY[a.ticker, b.ticker] AS tickers,
            jsonb_build_array((to_jsonb(a.*) - 'fetched_at'::text), (to_jsonb(b.*) - 'fetched_at'::text)) AS leg_detail,
            (a.our_prob * b.our_prob) AS our_prob,
            ((a.yes_ask + a.fee) * (b.yes_ask + b.fee)) AS cost_separate,
            (a.kalshi_prob * b.kalshi_prob) AS kalshi_prob,
            LEAST(a.kickoff_utc, b.kickoff_utc) AS first_kickoff,
            GREATEST(a.risk_index, b.risk_index) AS max_risk
           FROM (best a
             JOIN best b ON (((a.season = b.season) AND (a.week = b.week) AND (a.game_id < b.game_id))))
        ), three AS (
         SELECT a.season,
            a.week,
            3 AS "?column?",
            ARRAY[a.ticker, b.ticker, c.ticker] AS "array",
            jsonb_build_array((to_jsonb(a.*) - 'fetched_at'::text), (to_jsonb(b.*) - 'fetched_at'::text), (to_jsonb(c.*) - 'fetched_at'::text)) AS jsonb_build_array,
            ((a.our_prob * b.our_prob) * c.our_prob) AS "?column?",
            (((a.yes_ask + a.fee) * (b.yes_ask + b.fee)) * (c.yes_ask + c.fee)) AS "?column?",
            ((a.kalshi_prob * b.kalshi_prob) * c.kalshi_prob) AS "?column?",
            LEAST(a.kickoff_utc, b.kickoff_utc, c.kickoff_utc) AS "least",
            GREATEST(a.risk_index, b.risk_index, c.risk_index) AS "greatest"
           FROM ((best a
             JOIN best b ON (((a.season = b.season) AND (a.week = b.week) AND (a.game_id < b.game_id))))
             JOIN best c ON (((b.season = c.season) AND (b.week = c.week) AND (b.game_id < c.game_id))))
        ), four AS (
         SELECT a.season,
            a.week,
            4 AS "?column?",
            ARRAY[a.ticker, b.ticker, c.ticker, d.ticker] AS "array",
            jsonb_build_array((to_jsonb(a.*) - 'fetched_at'::text), (to_jsonb(b.*) - 'fetched_at'::text), (to_jsonb(c.*) - 'fetched_at'::text), (to_jsonb(d.*) - 'fetched_at'::text)) AS jsonb_build_array,
            (((a.our_prob * b.our_prob) * c.our_prob) * d.our_prob) AS "?column?",
            ((((a.yes_ask + a.fee) * (b.yes_ask + b.fee)) * (c.yes_ask + c.fee)) * (d.yes_ask + d.fee)) AS "?column?",
            (((a.kalshi_prob * b.kalshi_prob) * c.kalshi_prob) * d.kalshi_prob) AS "?column?",
            LEAST(a.kickoff_utc, b.kickoff_utc, c.kickoff_utc, d.kickoff_utc) AS "least",
            GREATEST(a.risk_index, b.risk_index, c.risk_index, d.risk_index) AS "greatest"
           FROM (((best a
             JOIN best b ON (((a.season = b.season) AND (a.week = b.week) AND (a.game_id < b.game_id))))
             JOIN best c ON (((b.season = c.season) AND (b.week = c.week) AND (b.game_id < c.game_id))))
             JOIN best d ON (((c.season = d.season) AND (c.week = d.week) AND (c.game_id < d.game_id))))
        ), allp AS (
         SELECT two.season,
            two.week,
            two.legs,
            two.tickers,
            two.leg_detail,
            two.our_prob,
            two.cost_separate,
            two.kalshi_prob,
            two.first_kickoff,
            two.max_risk
           FROM two
        UNION ALL
         SELECT three.season,
            three.week,
            three."?column?",
            three."array",
            three.jsonb_build_array,
            three."?column?_1" AS "?column?",
            three."?column?_2" AS "?column?",
            three."?column?_3" AS "?column?",
            three."least",
            three."greatest"
           FROM three three(season, week, "?column?", "array", jsonb_build_array, "?column?_1", "?column?_2", "?column?_3", "least", "greatest")
        UNION ALL
         SELECT four.season,
            four.week,
            four."?column?",
            four."array",
            four.jsonb_build_array,
            four."?column?_1" AS "?column?",
            four."?column?_2" AS "?column?",
            four."?column?_3" AS "?column?",
            four."least",
            four."greatest"
           FROM four four(season, week, "?column?", "array", jsonb_build_array, "?column?_1", "?column?_2", "?column?_3", "least", "greatest")
        ), sc AS (
         SELECT p.season,
            p.week,
            p.legs,
            p.tickers,
            p.leg_detail,
            p.our_prob,
            p.cost_separate,
            p.kalshi_prob,
            p.first_kickoff,
            p.max_risk,
            (((100)::numeric * ((0.5 * LEAST((1)::numeric, GREATEST((0)::numeric, (((p.our_prob / NULLIF(p.kalshi_prob, (0)::numeric)) - (1)::numeric) / 0.25)))) + (0.5 * LEAST((1)::numeric, (p.our_prob /
                CASE
                    WHEN (p.legs = 4) THEN 0.15
                    ELSE 0.30
                END))))) * ((1)::numeric - (0.35 * p.max_risk))) AS raw
           FROM allp p
        )
 SELECT season,
    week,
    legs,
    tickers,
    leg_detail,
    first_kickoff,
    round(our_prob, 4) AS our_prob,
    round(kalshi_prob, 4) AS kalshi_prob,
    round(cost_separate, 4) AS fair_cost_if_legs_bought_separately,
    round(our_prob, 4) AS max_price_to_pay,
    round(((our_prob / NULLIF(kalshi_prob, (0)::numeric)) - (1)::numeric), 3) AS edge_vs_kalshi,
    (round(raw))::integer AS parlay_score,
        CASE
            WHEN (legs = 4) THEN 'Very high variance'::text
            WHEN (legs = 3) THEN 'High variance'::text
            ELSE 'Medium variance'::text
        END AS variance,
    rank() OVER (PARTITION BY season, week ORDER BY raw DESC, sc.our_prob DESC) AS parlay_rank,
    rank() OVER (PARTITION BY season, week ORDER BY sc.our_prob DESC) AS prob_rank,
        CASE
            WHEN (raw >= (80)::numeric) THEN 'A+'::text
            WHEN (raw >= (70)::numeric) THEN 'A'::text
            WHEN (raw >= (60)::numeric) THEN 'B+'::text
            WHEN (raw >= (50)::numeric) THEN 'B'::text
            WHEN (raw >= (40)::numeric) THEN 'C'::text
            WHEN (raw >= (20)::numeric) THEN 'D'::text
            ELSE 'F'::text
        END AS parlay_grade
   FROM sc;

create or replace view public.alt_record as
 SELECT l.ticker,
    l.game_id,
    l.season,
    l.week,
    l.team,
    l.threshold,
    l.bet_label,
    l.yes_ask,
    l.our_prob,
    l.edge_pts,
    l.grade,
    l.alt_score,
    l.logged_at,
    g.home_team,
    g.away_team,
    g.home_score,
    g.away_score,
        CASE
            WHEN (g.home_score IS NULL) THEN NULL::text
            WHEN ((
            CASE
                WHEN (l.team = g.home_team) THEN (g.home_score - g.away_score)
                ELSE (g.away_score - g.home_score)
            END)::numeric > l.threshold) THEN 'WIN'::text
            ELSE 'LOSS'::text
        END AS result,
        CASE
            WHEN (g.home_score IS NULL) THEN NULL::numeric
            WHEN ((
            CASE
                WHEN (l.team = g.home_team) THEN (g.home_score - g.away_score)
                ELSE (g.away_score - g.home_score)
            END)::numeric > l.threshold) THEN round(((1)::numeric - l.yes_ask), 2)
            ELSE (- l.yes_ask)
        END AS profit_per_contract
   FROM (alt_picks_log l
     JOIN games g USING (game_id));

create or replace view public.bet_cart_detail as
 SELECT c.id,
    c.user_id,
    c.game_id,
    c.source,
    c.ticker,
    c.side,
    c.label,
    c.where_in_kalshi,
    c.kalshi_url,
    c.limit_price,
    c.count,
    c.added_at,
    COALESCE(a.grade, b.rating) AS grade,
    COALESCE(a.alt_score, b.bet_score) AS score,
    COALESCE(a.risk_rating, b.risk_rating) AS risk_rating,
    (round(((100)::numeric * COALESCE(a.risk_index, b.risk_index))))::integer AS risk_score,
    round(((100)::numeric * COALESCE(a.our_prob, b.ats_pick_prob)), 1) AS hit_pct,
    COALESCE(a.edge_pts, NULL::numeric) AS edge_pts,
    b.units AS suggested_units,
    g.away_team,
    g.home_team,
    g.kickoff_utc
   FROM (((bet_cart c
     LEFT JOIN alt_lines_board a ON (((c.source = 'alt_line'::text) AND (a.ticker = c.ticker))))
     LEFT JOIN bet_sheet b ON (((c.source = ANY (ARRAY['main_pick'::text, 'moneyline'::text])) AND (b.game_id = c.game_id))))
     LEFT JOIN games g ON ((g.game_id = c.game_id)));

create or replace view public.bet_sheet as
 SELECT rank() OVER (PARTITION BY season, week ORDER BY b.predicted_winner_prob DESC, bet_score DESC) AS rank,
    rank() OVER (PARTITION BY season, week ORDER BY
        CASE rating
            WHEN 'A+'::text THEN 6
            WHEN 'A'::text THEN 5
            WHEN 'B+'::text THEN 4
            WHEN 'B'::text THEN 3
            WHEN 'C'::text THEN 2
            ELSE 1
        END DESC, b.risk_index, bet_score DESC) AS bet_rank,
    season,
    week,
    slate,
    game_date_et,
    kickoff_utc,
    game_id,
    away_team,
    home_team,
    predicted_winner,
    round(predicted_winner_prob, 4) AS predicted_winner_prob,
        CASE
            WHEN (predicted_winner = home_team) THEN (- spread_line)
            ELSE spread_line
        END AS winner_spread,
        CASE
            WHEN (predicted_winner = home_team) THEN home_moneyline
            ELSE away_moneyline
        END AS winner_moneyline,
    ats_pick,
        CASE
            WHEN (ats_pick = home_team) THEN (- spread_line)
            ELSE spread_line
        END AS ats_pick_spread,
    round(ats_pick_prob, 4) AS ats_pick_prob,
    rating,
    bet_score,
    risk_rating,
    round(risk_index, 3) AS risk_index,
    units,
    consensus_pick,
    expert_count,
    total_line,
    kalshi_winner,
    kalshi_winner_prob,
    kalshi_home_prob,
    kalshi_edge_pts,
    pbm_agrees_with_kalshi,
    kalshi_value_side,
    kalshi_value_pts,
    kalshi_updated_at,
    vegas_winner,
    vegas_winner_prob,
    vegas_home_prob,
    vegas_favorite,
    vegas_fav_points,
    home_moneyline,
    away_moneyline,
    vegas_edge_pts,
    pbm_agrees_with_vegas
   FROM game_board b
  WHERE (home_score IS NULL);

create or replace view public.clv_summary as
 SELECT 'my_bets'::text AS source,
    my_bet_clv.market AS bucket,
    count(*) AS n,
    round(avg(my_bet_clv.clv_pts), 2) AS avg_clv_pts,
    round((100.0 * avg(
        CASE
            WHEN my_bet_clv.beat_close THEN 1
            ELSE 0
        END)), 1) AS pct_beat_close
   FROM my_bet_clv
  GROUP BY my_bet_clv.market
UNION ALL
 SELECT 'app_picks'::text AS source,
    pick_clv.grade AS bucket,
    count(*) AS n,
    round(avg(pick_clv.clv_pts), 2) AS avg_clv_pts,
    round((100.0 * avg(
        CASE
            WHEN pick_clv.beat_close THEN 1
            ELSE 0
        END)), 1) AS pct_beat_close
   FROM pick_clv
  GROUP BY pick_clv.grade;

create or replace view public.dashboard_stats as
 WITH r AS (
         SELECT sheet_results.game_date_et,
            sheet_results.slate,
            sheet_results.season,
            sheet_results.week,
            sheet_results.game_id,
            sheet_results.home_team,
            sheet_results.away_team,
            sheet_results.home_score,
            sheet_results.away_score,
            sheet_results.spread_line,
            sheet_results.predicted_winner,
            sheet_results.predicted_winner_prob,
            sheet_results.week_rank,
            sheet_results.ats_pick,
            sheet_results.rating,
            sheet_results.bet_score,
            sheet_results.risk_rating,
            sheet_results.units,
            sheet_results.consensus_pick,
            sheet_results.agrees,
            sheet_results.ats_result,
            sheet_results.consensus_result,
            sheet_results.su_result,
            sheet_results.kalshi_winner,
            sheet_results.kalshi_winner_prob,
            sheet_results.kalshi_su_result,
            sheet_results.vegas_winner,
            sheet_results.vegas_su_result,
            max(sheet_results.week) OVER (PARTITION BY sheet_results.season) AS last_week
           FROM sheet_results
        ), scopes AS (
         SELECT r.season,
            'pbm_ats_all'::text AS scope,
            'PBM ATS · all picks'::text AS label,
            1 AS sort,
            r.ats_result AS res,
            r.units,
            true AS use_units
           FROM r
        UNION ALL
         SELECT r.season,
            'pbm_ats_bets'::text,
            'PBM ATS · rated bets'::text,
            2,
            r.ats_result,
            r.units,
            true
           FROM r
          WHERE (r.units > (0)::numeric)
        UNION ALL
         SELECT r.season,
            'pbm_top'::text,
            'PBM A+ / A picks'::text,
            3,
            r.ats_result,
            r.units,
            true
           FROM r
          WHERE (r.rating = ANY (ARRAY['A+'::text, 'A'::text]))
        UNION ALL
         SELECT r.season,
            'pbm_last4'::text,
            'PBM ATS · last 4 weeks'::text,
            4,
            r.ats_result,
            r.units,
            true
           FROM r
          WHERE (r.week > (r.last_week - 4))
        UNION ALL
         SELECT r.season,
            'pbm_su'::text,
            'Straight-up winners'::text,
            5,
            r.su_result,
            0,
            false
           FROM r
        UNION ALL
         SELECT r.season,
            'consensus_ats'::text,
            'Expert consensus ATS'::text,
            6,
            r.consensus_result,
            0,
            false
           FROM r
          WHERE (r.consensus_result IS NOT NULL)
        UNION ALL
         SELECT r.season,
            'agree_ats'::text,
            'PBM + experts agree'::text,
            7,
            r.ats_result,
            r.units,
            true
           FROM r
          WHERE r.agrees
        UNION ALL
         SELECT r.season,
            'kalshi_su'::text,
            'Kalshi favorite straight-up'::text,
            8,
            r.kalshi_su_result,
            0,
            false
           FROM r
          WHERE (r.kalshi_su_result IS NOT NULL)
        UNION ALL
         SELECT r.season,
            'pbm_kalshi_agree_su'::text,
            'PBM + Kalshi agree (SU)'::text,
            9,
            r.su_result,
            0,
            false
           FROM r
          WHERE (r.kalshi_winner = r.predicted_winner)
        UNION ALL
         SELECT r.season,
            'vegas_su'::text,
            'Vegas favorite straight-up'::text,
            8,
            r.vegas_su_result,
            0,
            false
           FROM r
          WHERE (r.vegas_su_result IS NOT NULL)
        UNION ALL
         SELECT r.season,
            ('grade_'::text || r.rating),
            ('Grade '::text || r.rating),
            10,
            r.ats_result,
            r.units,
            true
           FROM r
          WHERE (r.rating IS NOT NULL)
        UNION ALL
         SELECT r.season,
            ('slate_'::text || r.slate),
            (r.slate || ' sheet'::text),
            20,
            r.ats_result,
            r.units,
            true
           FROM r
        )
 SELECT season,
    scope,
    min(label) AS label,
    min(sort) AS sort,
    count(*) FILTER (WHERE (res = 'WIN'::text)) AS wins,
    count(*) FILTER (WHERE (res = 'LOSS'::text)) AS losses,
    count(*) FILTER (WHERE (res = 'PUSH'::text)) AS pushes,
    round(((count(*) FILTER (WHERE (res = 'WIN'::text)))::numeric / (NULLIF(count(*) FILTER (WHERE (res = ANY (ARRAY['WIN'::text, 'LOSS'::text]))), 0))::numeric), 4) AS win_pct,
    round(sum(
        CASE
            WHEN (NOT use_units) THEN (0)::numeric
            WHEN (res = 'WIN'::text) THEN ((units * (100)::numeric) / 110.0)
            WHEN (res = 'LOSS'::text) THEN (- units)
            ELSE (0)::numeric
        END), 2) AS units_net,
    0.5238 AS breakeven
   FROM scopes
  GROUP BY season, scope;

create or replace view public.data_freshness as
 SELECT g.game_id,
    g.kickoff_utc,
    (g.kickoff_utc - '01:30:00'::interval) AS inactives_at,
    p.updated_at AS model_updated_at,
    n.scanned_at AS news_scanned_at,
    ( SELECT max(a.ran_at) AS max
           FROM agent_runs a
          WHERE (a.run_date = g.game_date_et)) AS experts_scanned_at,
    km.fetched_at AS prices_updated_at,
    (p.updated_at >= (g.kickoff_utc - '01:30:00'::interval)) AS model_after_inactives,
    (n.scanned_at >= (g.kickoff_utc - '01:30:00'::interval)) AS news_after_inactives,
    ( SELECT max(t.requested_at) AS max
           FROM engine_triggers t
          WHERE (t.status = ANY (ARRAY['started'::text, 'already_running'::text]))) AS engine_last_started_at
   FROM (((games g
     LEFT JOIN predictions p ON ((p.game_id = g.game_id)))
     LEFT JOIN news_intel n ON ((n.game_id = g.game_id)))
     LEFT JOIN kalshi_markets km ON ((km.game_id = g.game_id)))
  WHERE (g.home_score IS NULL);

create or replace view public.engine_compare as
 SELECT o.season,
    o.week,
    o.game_id,
    o.kickoff_utc,
    o.away_team,
    o.home_team,
    o.status,
    o.ats_pick AS live_pick,
    o.pick_spread AS live_spread,
    o.rating AS live_rating,
    o.bet_score AS live_bet_score,
    o.result AS live_result,
    COALESCE(sr.ats_pick, sb.ats_pick) AS shadow_pick,
    COALESCE(
        CASE
            WHEN (sr.ats_pick IS NULL) THEN NULL::numeric
            WHEN (sr.ats_pick = sr.home_team) THEN (- sr.spread_line)
            ELSE sr.spread_line
        END, sb.ats_pick_spread) AS shadow_spread,
    COALESCE(sr.rating, sb.rating) AS shadow_rating,
    (COALESCE(sr.bet_score, sb.bet_score))::numeric AS shadow_bet_score,
    lower(sr.ats_result) AS shadow_result,
    ((COALESCE(sr.ats_pick, sb.ats_pick) IS NOT NULL) AND (COALESCE(sr.ats_pick, sb.ats_pick) <> o.ats_pick)) AS disagree,
    o.away_score,
    o.home_score
   FROM ((overall_picks o
     LEFT JOIN shadow_sheet_results sr ON ((sr.game_id = o.game_id)))
     LEFT JOIN shadow_bet_sheet sb ON (((sb.game_id = o.game_id) AND (sr.game_id IS NULL))));

create or replace view public.expert_consensus as
 WITH sp AS (
         SELECT ep.game_id,
            count(*) AS n_spread,
            count(*) FILTER (WHERE (ep.pick_side = 'home'::text)) AS n_home,
            count(*) FILTER (WHERE (ep.pick_side = 'away'::text)) AS n_away
           FROM (expert_picks ep
             JOIN experts e ON (((e.id = ep.expert_id) AND e.active AND (COALESCE(e.tier, 'core'::text) = 'core'::text))))
          WHERE (ep.market = 'spread'::text)
          GROUP BY ep.game_id
        ), tot AS (
         SELECT ep.game_id,
            count(*) FILTER (WHERE (ep.pick_side = 'over'::text)) AS n_over,
            count(*) FILTER (WHERE (ep.pick_side = 'under'::text)) AS n_under
           FROM (expert_picks ep
             JOIN experts e ON (((e.id = ep.expert_id) AND (COALESCE(e.tier, 'core'::text) = 'core'::text))))
          WHERE (ep.market = 'total'::text)
          GROUP BY ep.game_id
        ), allp AS (
         SELECT ep.game_id,
            jsonb_agg(jsonb_build_object('expert', e.name, 'type', ep.pick_type, 'market', ep.market, 'pick', ep.pick_team, 'side', ep.pick_side, 'line', ep.line, 'odds', ep.odds, 'units', ep.units, 'rationale', ep.rationale, 'source_url', ep.source_url, 'source_name', ep.source_name, 'published_at', ep.published_at) ORDER BY e.name) AS picks
           FROM (expert_picks ep
             JOIN experts e ON (((e.id = ep.expert_id) AND e.active AND (COALESCE(e.tier, 'core'::text) = 'core'::text))))
          GROUP BY ep.game_id
        )
 SELECT g.game_id,
    COALESCE(sp.n_spread, (0)::bigint) AS n_spread,
    COALESCE(sp.n_home, (0)::bigint) AS n_home,
    COALESCE(sp.n_away, (0)::bigint) AS n_away,
        CASE
            WHEN (COALESCE(sp.n_spread, (0)::bigint) = 0) THEN NULL::text
            WHEN (sp.n_home > sp.n_away) THEN g.home_team
            WHEN (sp.n_away > sp.n_home) THEN g.away_team
            ELSE 'SPLIT'::text
        END AS consensus_pick,
        CASE
            WHEN (COALESCE(sp.n_spread, (0)::bigint) = 0) THEN NULL::numeric
            ELSE round(((GREATEST(sp.n_home, sp.n_away))::numeric / (sp.n_spread)::numeric), 3)
        END AS consensus_pct,
        CASE
            WHEN (COALESCE(sp.n_spread, (0)::bigint) = 0) THEN 0
            ELSE (round((((100)::numeric * ((GREATEST(sp.n_home, sp.n_away))::numeric / (sp.n_spread)::numeric)) * LEAST((1)::numeric, ((sp.n_spread)::numeric / 4.0)))))::integer
        END AS consensus_score,
    COALESCE(tot.n_over, (0)::bigint) AS n_over,
    COALESCE(tot.n_under, (0)::bigint) AS n_under,
    COALESCE(allp.picks, '[]'::jsonb) AS expert_picks
   FROM (((games g
     LEFT JOIN sp USING (game_id))
     LEFT JOIN tot USING (game_id))
     LEFT JOIN allp USING (game_id));

create or replace view public.expert_record as
 SELECT e.name AS expert,
    ep.season,
    ep.week,
    ep.game_id,
    ep.market,
    ep.pick_team,
    ep.line,
    ep.source_url,
        CASE
            WHEN (g.home_score IS NULL) THEN NULL::text
            WHEN ((ep.market = 'moneyline'::text) AND (g.home_score = g.away_score)) THEN 'PUSH'::text
            WHEN ((ep.market = 'moneyline'::text) AND ((ep.pick_side = 'home'::text) = (g.home_score > g.away_score))) THEN 'WIN'::text
            WHEN (ep.market = 'moneyline'::text) THEN 'LOSS'::text
            WHEN (ep.line IS NULL) THEN NULL::text
            WHEN ((ep.market = 'spread'::text) AND (((
            CASE
                WHEN (ep.pick_side = 'home'::text) THEN (g.home_score - g.away_score)
                ELSE (g.away_score - g.home_score)
            END)::numeric + ep.line) = (0)::numeric)) THEN 'PUSH'::text
            WHEN ((ep.market = 'spread'::text) AND (((
            CASE
                WHEN (ep.pick_side = 'home'::text) THEN (g.home_score - g.away_score)
                ELSE (g.away_score - g.home_score)
            END)::numeric + ep.line) > (0)::numeric)) THEN 'WIN'::text
            WHEN (ep.market = 'spread'::text) THEN 'LOSS'::text
            WHEN ((ep.market = 'total'::text) AND (((g.home_score + g.away_score))::numeric = ep.line)) THEN 'PUSH'::text
            WHEN ((ep.market = 'total'::text) AND ((((g.home_score + g.away_score))::numeric > ep.line) = (ep.pick_side = 'over'::text))) THEN 'WIN'::text
            WHEN (ep.market = 'total'::text) THEN 'LOSS'::text
            ELSE NULL::text
        END AS result,
    ep.expert_id,
    e.tier,
    e.outlet
   FROM ((expert_picks ep
     JOIN experts e ON ((e.id = ep.expert_id)))
     JOIN games g ON ((g.game_id = ep.game_id)));

create or replace view public.expert_weights as
 WITH r AS (
         SELECT e.id AS expert_id,
            e.name,
            e.tier,
            COALESCE(e.outlet, e.affiliation) AS outlet,
            count(*) FILTER (WHERE ((x.market = 'spread'::text) AND (x.result = 'WIN'::text))) AS ats_w,
            count(*) FILTER (WHERE ((x.market = 'spread'::text) AND (x.result = 'LOSS'::text))) AS ats_l,
            count(*) FILTER (WHERE ((x.market = 'moneyline'::text) AND (x.result = 'WIN'::text))) AS su_w,
            count(*) FILTER (WHERE ((x.market = 'moneyline'::text) AND (x.result = 'LOSS'::text))) AS su_l
           FROM (experts e
             LEFT JOIN expert_record x ON ((x.expert_id = e.id)))
          WHERE e.active
          GROUP BY e.id, e.name, e.tier, e.outlet, e.affiliation
        )
 SELECT expert_id,
    name,
    tier,
    outlet,
    ats_w,
    ats_l,
    su_w,
    su_l,
    round((((ats_w)::numeric + 5.0) / (((ats_w + ats_l) + 10))::numeric), 4) AS ats_rate_shrunk,
    round(GREATEST(0.25, LEAST(2.0, ((1)::numeric + ((20)::numeric * ((((ats_w)::numeric + 5.0) / (((ats_w + ats_l) + 10))::numeric) - 0.5))))), 3) AS ats_weight,
    round((((su_w)::numeric + 6.2) / (((su_w + su_l) + 10))::numeric), 4) AS su_rate_shrunk,
    round(GREATEST(0.25, LEAST(2.0, ((1)::numeric + ((10)::numeric * ((((su_w)::numeric + 6.2) / (((su_w + su_l) + 10))::numeric) - 0.62))))), 3) AS su_weight,
    (ats_w + ats_l) AS ats_graded,
    (su_w + su_l) AS su_graded
   FROM r;

create or replace view public.game_board as
 WITH base AS (
         SELECT g.game_id,
            g.season,
            g.week,
            g.game_type,
            g.kickoff_utc,
            g.slate,
            g.game_date_et,
            g.home_team,
            g.away_team,
            g.home_score,
            g.away_score,
            g.stadium,
            g.stadium_id,
            g.roof,
            g.surface,
            g.spread_line,
            g.total_line,
            g.home_moneyline,
            g.away_moneyline,
            g.home_rest,
            g.away_rest,
            g.home_qb,
            g.away_qb,
            g.div_game,
            p.model_home_prob,
            p.blend_home_prob,
            p.market_home_prob,
            p.spread_home_prob,
            p.model_margin,
            p.home_cover_prob,
            p.categories,
            p.top_features,
            p.home_starters_out,
            p.away_starters_out,
            p.home_inj_total,
            p.away_inj_total,
            p.questionable_starters,
            p.weather_severity,
            p.early_season,
            p.model_market_gap,
            p.updated_at,
            w.temp_f,
            w.wind_mph,
            w.gust_mph,
            w.wind_dir,
            w.humidity,
            w.precip_prob,
            w.pressure_mb,
            w.short_forecast,
            w.indoor,
            w.source AS weather_source,
            w.fetched_at AS weather_at,
            n.home_adj_pts,
            n.away_adj_pts,
            n.home_confidence,
            n.away_confidence,
            n.volatility,
            n.home_items,
            n.away_items,
            n.game_brief,
            n.scanned_at,
                CASE
                    WHEN (COALESCE(qh.starter_out, false) OR COALESCE(qa.starter_out, false)) THEN GREATEST((- (10)::numeric), LEAST((10)::numeric, (
                    CASE
                        WHEN COALESCE(qh.starter_out, false) THEN LEAST(COALESCE(n.home_adj_pts, (0)::numeric), qh.pts)
                        ELSE GREATEST((- (4)::numeric), LEAST((4)::numeric, COALESCE(n.home_adj_pts, (0)::numeric)))
                    END -
                    CASE
                        WHEN COALESCE(qa.starter_out, false) THEN LEAST(COALESCE(n.away_adj_pts, (0)::numeric), qa.pts)
                        ELSE GREATEST((- (4)::numeric), LEAST((4)::numeric, COALESCE(n.away_adj_pts, (0)::numeric)))
                    END)))
                    ELSE GREATEST(('-4'::integer)::numeric, LEAST((4)::numeric, (COALESCE(n.home_adj_pts, (0)::numeric) - COALESCE(n.away_adj_pts, (0)::numeric))))
                END AS news_pts
           FROM (((((games g
             JOIN predictions p USING (game_id))
             LEFT JOIN weather w USING (game_id))
             LEFT JOIN news_intel n USING (game_id))
             LEFT JOIN qb_status qh ON (((qh.game_id = g.game_id) AND (qh.team = g.home_team))))
             LEFT JOIN qb_status qa ON (((qa.game_id = g.game_id) AND (qa.team = g.away_team))))
        ), calc AS (
         SELECT b.game_id,
            b.season,
            b.week,
            b.game_type,
            b.kickoff_utc,
            b.slate,
            b.game_date_et,
            b.home_team,
            b.away_team,
            b.home_score,
            b.away_score,
            b.stadium,
            b.stadium_id,
            b.roof,
            b.surface,
            b.spread_line,
            b.total_line,
            b.home_moneyline,
            b.away_moneyline,
            b.home_rest,
            b.away_rest,
            b.home_qb,
            b.away_qb,
            b.div_game,
            b.model_home_prob,
            b.blend_home_prob,
            b.market_home_prob,
            b.spread_home_prob,
            b.model_margin,
            b.home_cover_prob,
            b.categories,
            b.top_features,
            b.home_starters_out,
            b.away_starters_out,
            b.home_inj_total,
            b.away_inj_total,
            b.questionable_starters,
            b.weather_severity,
            b.early_season,
            b.model_market_gap,
            b.updated_at,
            b.temp_f,
            b.wind_mph,
            b.gust_mph,
            b.wind_dir,
            b.humidity,
            b.precip_prob,
            b.pressure_mb,
            b.short_forecast,
            b.indoor,
            b.weather_source,
            b.weather_at,
            b.home_adj_pts,
            b.away_adj_pts,
            b.home_confidence,
            b.away_confidence,
            b.volatility,
            b.home_items,
            b.away_items,
            b.game_brief,
            b.scanned_at,
            b.news_pts,
            (b.model_margin + b.news_pts) AS adj_margin,
            pbm_phi((((b.model_margin + b.news_pts) - b.spread_line) / 13.45)) AS adj_home_cover,
            ((1)::numeric / ((1)::numeric + exp((- (ln((b.blend_home_prob / ((1)::numeric - b.blend_home_prob))) + (0.12 * b.news_pts)))))) AS adj_home_win
           FROM base b
        ), picks AS (
         SELECT c.game_id,
            c.season,
            c.week,
            c.game_type,
            c.kickoff_utc,
            c.slate,
            c.game_date_et,
            c.home_team,
            c.away_team,
            c.home_score,
            c.away_score,
            c.stadium,
            c.stadium_id,
            c.roof,
            c.surface,
            c.spread_line,
            c.total_line,
            c.home_moneyline,
            c.away_moneyline,
            c.home_rest,
            c.away_rest,
            c.home_qb,
            c.away_qb,
            c.div_game,
            c.model_home_prob,
            c.blend_home_prob,
            c.market_home_prob,
            c.spread_home_prob,
            c.model_margin,
            c.home_cover_prob,
            c.categories,
            c.top_features,
            c.home_starters_out,
            c.away_starters_out,
            c.home_inj_total,
            c.away_inj_total,
            c.questionable_starters,
            c.weather_severity,
            c.early_season,
            c.model_market_gap,
            c.updated_at,
            c.temp_f,
            c.wind_mph,
            c.gust_mph,
            c.wind_dir,
            c.humidity,
            c.precip_prob,
            c.pressure_mb,
            c.short_forecast,
            c.indoor,
            c.weather_source,
            c.weather_at,
            c.home_adj_pts,
            c.away_adj_pts,
            c.home_confidence,
            c.away_confidence,
            c.volatility,
            c.home_items,
            c.away_items,
            c.game_brief,
            c.scanned_at,
            c.news_pts,
            c.adj_margin,
            c.adj_home_cover,
            c.adj_home_win,
                CASE
                    WHEN (c.adj_home_cover >= 0.5) THEN c.home_team
                    ELSE c.away_team
                END AS ats_pick,
            GREATEST(c.adj_home_cover, ((1)::numeric - c.adj_home_cover)) AS ats_pick_prob,
            ((c.adj_home_win * (pbm_dec((c.home_moneyline)::numeric) - (1)::numeric)) - ((1)::numeric - c.adj_home_win)) AS ev_home_adj,
            ((((1)::numeric - c.adj_home_win) * (pbm_dec((c.away_moneyline)::numeric) - (1)::numeric)) - c.adj_home_win) AS ev_away_adj,
            LEAST((1)::numeric, GREATEST((0)::numeric, ((((((0.20 * (COALESCE(c.early_season, 0))::numeric) + (0.04 * (LEAST(COALESCE(c.questionable_starters, 0), 6))::numeric)) + (0.25 * COALESCE(c.weather_severity, (0)::numeric))) + (0.30 * COALESCE(c.volatility, 0.5))) + (0.20 * LEAST((1)::numeric, GREATEST((0)::numeric, ((COALESCE(c.model_market_gap, (0)::numeric) - (7)::numeric) / 7.0))))) +
                CASE
                    WHEN (c.scanned_at IS NULL) THEN 0.10
                    ELSE (0)::numeric
                END))) AS risk_index
           FROM calc c
        ), scored AS (
         SELECT p.game_id,
            p.season,
            p.week,
            p.game_type,
            p.kickoff_utc,
            p.slate,
            p.game_date_et,
            p.home_team,
            p.away_team,
            p.home_score,
            p.away_score,
            p.stadium,
            p.stadium_id,
            p.roof,
            p.surface,
            p.spread_line,
            p.total_line,
            p.home_moneyline,
            p.away_moneyline,
            p.home_rest,
            p.away_rest,
            p.home_qb,
            p.away_qb,
            p.div_game,
            p.model_home_prob,
            p.blend_home_prob,
            p.market_home_prob,
            p.spread_home_prob,
            p.model_margin,
            p.home_cover_prob,
            p.categories,
            p.top_features,
            p.home_starters_out,
            p.away_starters_out,
            p.home_inj_total,
            p.away_inj_total,
            p.questionable_starters,
            p.weather_severity,
            p.early_season,
            p.model_market_gap,
            p.updated_at,
            p.temp_f,
            p.wind_mph,
            p.gust_mph,
            p.wind_dir,
            p.humidity,
            p.precip_prob,
            p.pressure_mb,
            p.short_forecast,
            p.indoor,
            p.weather_source,
            p.weather_at,
            p.home_adj_pts,
            p.away_adj_pts,
            p.home_confidence,
            p.away_confidence,
            p.volatility,
            p.home_items,
            p.away_items,
            p.game_brief,
            p.scanned_at,
            p.news_pts,
            p.adj_margin,
            p.adj_home_cover,
            p.adj_home_win,
            p.ats_pick,
            p.ats_pick_prob,
            p.ev_home_adj,
            p.ev_away_adj,
            p.risk_index,
                CASE
                    WHEN (p.ev_home_adj >= p.ev_away_adj) THEN p.home_team
                    ELSE p.away_team
                END AS ml_pick,
            GREATEST(p.ev_home_adj, p.ev_away_adj) AS ml_pick_ev,
            ((((((60)::numeric * LEAST((1)::numeric, GREATEST((0)::numeric, ((p.ats_pick_prob - 0.5238) / 0.10)))) + ((20)::numeric * LEAST((1)::numeric, GREATEST((0)::numeric, (GREATEST(p.ev_home_adj, p.ev_away_adj) / 0.10))))) + (
                CASE
                    WHEN (sign((p.model_home_prob - p.market_home_prob)) = sign((p.adj_margin - p.spread_line))) THEN 10
                    ELSE 0
                END)::numeric) +
                CASE
                    WHEN ((p.news_pts <> (0)::numeric) AND (sign(p.news_pts) = sign((p.adj_home_cover - 0.5)))) THEN ((10)::numeric * COALESCE(GREATEST(p.home_confidence, p.away_confidence), 0.5))
                    ELSE (0)::numeric
                END) * ((1)::numeric - (0.35 * p.risk_index))) AS raw_score
           FROM picks p
        )
 SELECT s.game_id,
    s.season,
    s.week,
    s.game_type,
    s.kickoff_utc,
    s.slate,
    s.game_date_et,
    s.home_team,
    s.away_team,
    s.home_score,
    s.away_score,
    s.stadium,
    s.stadium_id,
    s.roof,
    s.surface,
    s.spread_line,
    s.total_line,
    s.home_moneyline,
    s.away_moneyline,
    s.home_rest,
    s.away_rest,
    s.home_qb,
    s.away_qb,
    s.div_game,
    s.model_home_prob,
    s.blend_home_prob,
    s.market_home_prob,
    s.spread_home_prob,
    s.model_margin,
    s.home_cover_prob,
    s.categories,
    s.top_features,
    s.home_starters_out,
    s.away_starters_out,
    s.home_inj_total,
    s.away_inj_total,
    s.questionable_starters,
    s.weather_severity,
    s.early_season,
    s.model_market_gap,
    s.updated_at,
    s.temp_f,
    s.wind_mph,
    s.gust_mph,
    s.wind_dir,
    s.humidity,
    s.precip_prob,
    s.pressure_mb,
    s.short_forecast,
    s.indoor,
    s.weather_source,
    s.weather_at,
    s.home_adj_pts,
    s.away_adj_pts,
    s.home_confidence,
    s.away_confidence,
    s.volatility,
    s.home_items,
    s.away_items,
    s.game_brief,
    s.scanned_at,
    s.news_pts,
    s.adj_margin,
    s.adj_home_cover,
    s.adj_home_win,
    s.ats_pick,
    s.ats_pick_prob,
    s.ev_home_adj,
    s.ev_away_adj,
    s.risk_index,
    s.ml_pick,
    s.ml_pick_ev,
    s.raw_score,
    ec.n_spread AS expert_count,
    ec.consensus_pick,
    ec.consensus_pct,
    ec.consensus_score,
        CASE
            WHEN (ec.consensus_score >= 80) THEN 'A+'::text
            WHEN (ec.consensus_score >= 70) THEN 'A'::text
            WHEN (ec.consensus_score >= 60) THEN 'B+'::text
            WHEN (ec.consensus_score >= 50) THEN 'B'::text
            WHEN (ec.consensus_score >= 40) THEN 'C'::text
            ELSE 'PASS'::text
        END AS consensus_rating,
    (ec.consensus_pick = s.ats_pick) AS pbm_agrees_with_experts,
    ec.n_over,
    ec.n_under,
    ec.expert_picks,
    (round(LEAST((100)::numeric, GREATEST((0)::numeric, s.raw_score))))::integer AS bet_score,
        CASE
            WHEN (s.raw_score >= (80)::numeric) THEN 'A+'::text
            WHEN (s.raw_score >= (70)::numeric) THEN 'A'::text
            WHEN (s.raw_score >= (60)::numeric) THEN 'B+'::text
            WHEN (s.raw_score >= (50)::numeric) THEN 'B'::text
            WHEN (s.raw_score >= (40)::numeric) THEN 'C'::text
            ELSE 'PASS'::text
        END AS rating,
        CASE
            WHEN (s.risk_index < 0.2) THEN 'Low'::text
            WHEN (s.risk_index < 0.4) THEN 'Moderate'::text
            WHEN (s.risk_index < 0.6) THEN 'Elevated'::text
            WHEN (s.risk_index < 0.8) THEN 'High'::text
            ELSE 'Extreme'::text
        END AS risk_rating,
        CASE
            WHEN (s.raw_score >= (80)::numeric) THEN (2)::numeric
            WHEN (s.raw_score >= (70)::numeric) THEN 1.5
            WHEN (s.raw_score >= (60)::numeric) THEN (1)::numeric
            WHEN (s.raw_score >= (50)::numeric) THEN 0.5
            ELSE (0)::numeric
        END AS units,
        CASE
            WHEN (s.adj_home_win >= 0.5) THEN s.home_team
            ELSE s.away_team
        END AS predicted_winner,
    GREATEST(s.adj_home_win, ((1)::numeric - s.adj_home_win)) AS predicted_winner_prob,
    round(km.home_prob, 4) AS kalshi_home_prob,
        CASE
            WHEN (km.home_prob IS NULL) THEN NULL::text
            WHEN (km.home_prob >= 0.5) THEN s.home_team
            ELSE s.away_team
        END AS kalshi_winner,
    round(GREATEST(km.home_prob, ((1)::numeric - km.home_prob)), 4) AS kalshi_winner_prob,
    km.home_yes_ask AS kalshi_home_ask,
    km.away_yes_ask AS kalshi_away_ask,
    km.fetched_at AS kalshi_updated_at,
    round(((100)::numeric * (GREATEST(s.adj_home_win, ((1)::numeric - s.adj_home_win)) -
        CASE
            WHEN (s.adj_home_win >= 0.5) THEN km.home_prob
            ELSE ((1)::numeric - km.home_prob)
        END)), 1) AS kalshi_edge_pts,
    ((km.home_prob IS NOT NULL) AND ((km.home_prob >= 0.5) = (s.adj_home_win >= 0.5))) AS pbm_agrees_with_kalshi,
        CASE
            WHEN (km.home_yes_ask IS NULL) THEN NULL::text
            WHEN ((s.adj_home_win - km.home_yes_ask) >= (((1)::numeric - s.adj_home_win) - km.away_yes_ask)) THEN s.home_team
            ELSE s.away_team
        END AS kalshi_value_side,
    round(((100)::numeric * GREATEST((s.adj_home_win - km.home_yes_ask), (((1)::numeric - s.adj_home_win) - km.away_yes_ask))), 1) AS kalshi_value_pts,
    round(COALESCE(s.market_home_prob, s.spread_home_prob), 4) AS vegas_home_prob,
        CASE
            WHEN (COALESCE(s.market_home_prob, s.spread_home_prob) IS NULL) THEN NULL::text
            WHEN (COALESCE(s.market_home_prob, s.spread_home_prob) >= 0.5) THEN s.home_team
            ELSE s.away_team
        END AS vegas_winner,
    round(GREATEST(COALESCE(s.market_home_prob, s.spread_home_prob), ((1)::numeric - COALESCE(s.market_home_prob, s.spread_home_prob))), 4) AS vegas_winner_prob,
        CASE
            WHEN (s.spread_line > (0)::numeric) THEN s.home_team
            WHEN (s.spread_line < (0)::numeric) THEN s.away_team
            ELSE NULL::text
        END AS vegas_favorite,
    abs(s.spread_line) AS vegas_fav_points,
    round(((100)::numeric * (GREATEST(s.adj_home_win, ((1)::numeric - s.adj_home_win)) -
        CASE
            WHEN (s.adj_home_win >= 0.5) THEN COALESCE(s.market_home_prob, s.spread_home_prob)
            ELSE ((1)::numeric - COALESCE(s.market_home_prob, s.spread_home_prob))
        END)), 1) AS vegas_edge_pts,
    ((COALESCE(s.market_home_prob, s.spread_home_prob) IS NOT NULL) AND ((COALESCE(s.market_home_prob, s.spread_home_prob) >= 0.5) = (s.adj_home_win >= 0.5))) AS pbm_agrees_with_vegas,
    ( SELECT x.detail
           FROM qb_status x
          WHERE ((x.game_id = s.game_id) AND (x.team = s.home_team) AND x.starter_out)) AS home_qb_out,
    ( SELECT x.detail
           FROM qb_status x
          WHERE ((x.game_id = s.game_id) AND (x.team = s.away_team) AND x.starter_out)) AS away_qb_out
   FROM ((scored s
     LEFT JOIN expert_consensus ec USING (game_id))
     LEFT JOIN kalshi_markets km USING (game_id));

create or replace view public.game_money_flow as
 WITH f AS (
         SELECT h.game_id,
            h.backed_team,
            sum(h.trades) AS trades,
            sum(h.contracts) AS contracts,
            sum(h.dollars) AS dollars,
            sum(h.big_trades) AS big_trades,
            sum(h.big_dollars) AS big_dollars,
            sum(h.dollars) FILTER (WHERE (h.hour > (now() - '24:00:00'::interval))) AS dollars_24h,
            sum(h.trades) FILTER (WHERE (h.hour > (now() - '24:00:00'::interval))) AS trades_24h,
            sum(h.dollars) FILTER (WHERE (h.hour > (now() - '03:00:00'::interval))) AS dollars_3h
           FROM kalshi_flow_hourly h
          GROUP BY h.game_id, h.backed_team
        )
 SELECT f.game_id,
    f.backed_team,
    f.trades,
    f.contracts,
    f.dollars,
    f.big_trades,
    f.big_dollars,
    f.dollars_24h,
    f.trades_24h,
    f.dollars_3h,
    g.home_team,
    g.away_team,
    g.kickoff_utc,
    round(((100.0 * f.dollars) / NULLIF(sum(f.dollars) OVER (PARTITION BY f.game_id), (0)::numeric)), 1) AS pct_dollars,
    round(((100.0 * (f.trades)::numeric) / NULLIF(sum(f.trades) OVER (PARTITION BY f.game_id), (0)::numeric)), 1) AS pct_trades,
    round((f.dollars / (NULLIF(f.trades, 0))::numeric), 2) AS avg_trade_usd,
    ( SELECT bool_or(c.partial) AS bool_or
           FROM (kalshi_flow_cursor c
             JOIN kalshi_markets k ON (((c.ticker = k.home_ticker) OR (c.ticker = k.away_ticker))))
          WHERE (k.game_id = f.game_id)) AS partial
   FROM (f
     JOIN games g USING (game_id));

create or replace view public.grade_scorecard as
 WITH r AS (
         SELECT sheet_results.season,
            sheet_results.week,
                CASE
                    WHEN (sheet_results.rating = 'PASS'::text) THEN
                    CASE
                        WHEN (sheet_results.bet_score >= 30) THEN 'D'::text
                        ELSE 'F'::text
                    END
                    ELSE sheet_results.rating
                END AS grade,
            sheet_results.ats_result,
            sheet_results.su_result
           FROM sheet_results
          WHERE ((sheet_results.ats_result IS NOT NULL) OR (sheet_results.su_result IS NOT NULL))
        ), g AS (
         SELECT r.season,
            r.week,
            r.grade,
            count(*) AS games,
            count(*) FILTER (WHERE (r.ats_result = 'WIN'::text)) AS ats_w,
            count(*) FILTER (WHERE (r.ats_result = 'LOSS'::text)) AS ats_l,
            count(*) FILTER (WHERE (r.ats_result = 'PUSH'::text)) AS ats_p,
            count(*) FILTER (WHERE (r.su_result = 'WIN'::text)) AS su_w,
            count(*) FILTER (WHERE (r.su_result = 'LOSS'::text)) AS su_l
           FROM r
          GROUP BY GROUPING SETS ((r.season, r.week, r.grade), (r.season, r.grade))
        )
 SELECT season,
    week,
    grade,
    (grade = ANY (ARRAY['A+'::text, 'A'::text])) AS is_pick,
        CASE grade
            WHEN 'A+'::text THEN 1
            WHEN 'A'::text THEN 2
            WHEN 'B+'::text THEN 3
            WHEN 'B'::text THEN 4
            WHEN 'C'::text THEN 5
            WHEN 'D'::text THEN 6
            WHEN 'F'::text THEN 7
            ELSE 8
        END AS grade_sort,
    games,
    ats_w,
    ats_l,
    ats_p,
    round(((100.0 * (ats_w)::numeric) / (NULLIF((ats_w + ats_l), 0))::numeric), 1) AS ats_win_pct,
    su_w,
    su_l,
    round(((100.0 * (su_w)::numeric) / (NULLIF((su_w + su_l), 0))::numeric), 1) AS su_win_pct,
    round((((ats_w)::numeric * (100.0 / (110)::numeric)) - (ats_l)::numeric), 2) AS flat_units
   FROM g;

create or replace view public.hr_research_board as
 WITH b AS (
         SELECT h.game_id,
            h.book,
            h.home_team,
            h.away_team,
            h.kickoff_utc,
            h.home_spread,
            h.home_spread_price,
            h.away_spread_price,
            h.home_ml,
            h.away_ml,
            h.total,
            h.over_price,
            h.under_price,
            h.book_updated,
            h.fetched_at,
            g.season,
            g.week,
            p.model_margin,
            p.blend_home_prob,
            t.pred_total,
            ((0.3 * pbm_ncdf(((p.model_margin + h.home_spread) / 13.45))) + (0.7 * (pbm_implied((h.home_spread_price)::numeric) / NULLIF((pbm_implied((h.home_spread_price)::numeric) + pbm_implied((h.away_spread_price)::numeric)), (0)::numeric)))) AS home_cover,
            pbm_ncdf(((t.pred_total - h.total) / 13.2)) AS over_p
           FROM (((hr_game_lines h
             JOIN games g ON ((g.game_id = h.game_id)))
             LEFT JOIN predictions p ON ((p.game_id = h.game_id)))
             LEFT JOIN shadow_totals t ON ((t.game_id = h.game_id)))
        )
 SELECT game_id,
    season,
    week,
    kickoff_utc,
    away_team,
    home_team,
    fetched_at,
    home_spread,
    home_spread_price,
    away_spread_price,
        CASE
            WHEN ((home_cover - pbm_implied((home_spread_price)::numeric)) >= (((1)::numeric - home_cover) - pbm_implied((away_spread_price)::numeric))) THEN (((home_team || ' '::text) ||
            CASE
                WHEN (home_spread > (0)::numeric) THEN '+'::text
                ELSE ''::text
            END) || home_spread)
            ELSE (((away_team || ' '::text) ||
            CASE
                WHEN ((- home_spread) > (0)::numeric) THEN '+'::text
                ELSE ''::text
            END) || (- home_spread))
        END AS spread_pick,
    round(GREATEST(home_cover, ((1)::numeric - home_cover)), 3) AS spread_prob,
    round(GREATEST((home_cover - pbm_implied((home_spread_price)::numeric)), (((1)::numeric - home_cover) - pbm_implied((away_spread_price)::numeric))), 3) AS spread_edge,
        CASE
            WHEN ((home_cover - pbm_implied((home_spread_price)::numeric)) >= (((1)::numeric - home_cover) - pbm_implied((away_spread_price)::numeric))) THEN home_spread_price
            ELSE away_spread_price
        END AS spread_odds,
    home_ml,
    away_ml,
        CASE
            WHEN ((blend_home_prob - pbm_implied((home_ml)::numeric)) >= (((1)::numeric - blend_home_prob) - pbm_implied((away_ml)::numeric))) THEN home_team
            ELSE away_team
        END AS ml_pick,
    round(
        CASE
            WHEN ((blend_home_prob - pbm_implied((home_ml)::numeric)) >= (((1)::numeric - blend_home_prob) - pbm_implied((away_ml)::numeric))) THEN blend_home_prob
            ELSE ((1)::numeric - blend_home_prob)
        END, 3) AS ml_prob,
    round(GREATEST((blend_home_prob - pbm_implied((home_ml)::numeric)), (((1)::numeric - blend_home_prob) - pbm_implied((away_ml)::numeric))), 3) AS ml_edge,
        CASE
            WHEN ((blend_home_prob - pbm_implied((home_ml)::numeric)) >= (((1)::numeric - blend_home_prob) - pbm_implied((away_ml)::numeric))) THEN home_ml
            ELSE away_ml
        END AS ml_odds,
    total,
    over_price,
    under_price,
    pred_total,
        CASE
            WHEN ((over_p - pbm_implied((over_price)::numeric)) >= (((1)::numeric - over_p) - pbm_implied((under_price)::numeric))) THEN ('Over '::text || total)
            ELSE ('Under '::text || total)
        END AS total_pick,
    round(GREATEST(over_p, ((1)::numeric - over_p)), 3) AS total_prob,
    round(GREATEST((over_p - pbm_implied((over_price)::numeric)), (((1)::numeric - over_p) - pbm_implied((under_price)::numeric))), 3) AS total_edge,
        CASE
            WHEN ((over_p - pbm_implied((over_price)::numeric)) >= (((1)::numeric - over_p) - pbm_implied((under_price)::numeric))) THEN over_price
            ELSE under_price
        END AS total_odds,
    pbm_hr_grade(round(GREATEST((home_cover - pbm_implied((home_spread_price)::numeric)), (((1)::numeric - home_cover) - pbm_implied((away_spread_price)::numeric))), 3)) AS spread_grade,
    pbm_hr_grade(round(GREATEST((blend_home_prob - pbm_implied((home_ml)::numeric)), (((1)::numeric - blend_home_prob) - pbm_implied((away_ml)::numeric))), 3)) AS ml_grade,
    pbm_hr_grade(round(GREATEST((over_p - pbm_implied((over_price)::numeric)), (((1)::numeric - over_p) - pbm_implied((under_price)::numeric))), 3)) AS total_grade
   FROM b;

create or replace view public.jamie_leg_results as
 SELECT l.id,
    l.ticker,
    l.side,
    l.game_id,
    l.player_key,
    l.player_name,
    l.stat,
    l.strike,
    l.label,
    l.our_prob,
    l.price,
    l.edge,
    l.grade,
    l.game_state,
    l.minutes_left,
    l.logged_at,
    s.value AS final_value,
    s.final,
        CASE
            WHEN ((s.value IS NOT NULL) AND (s.value > l.strike)) THEN
            CASE
                WHEN (l.side = 'yes'::text) THEN 'win'::text
                ELSE 'loss'::text
            END
            WHEN (s.final IS TRUE) THEN
            CASE
                WHEN (l.side = 'yes'::text) THEN 'loss'::text
                ELSE 'win'::text
            END
            ELSE NULL::text
        END AS result,
    g.season,
    g.week,
    ((s.final IS NOT TRUE) AND (s.value > l.strike)) AS decided_early,
    l.model_prob
   FROM ((jamie_leg_log l
     LEFT JOIN jamie_player_stats s ON (((s.game_id = l.game_id) AND (s.player_key = l.player_key) AND (s.stat = l.stat))))
     LEFT JOIN games g ON ((g.game_id = l.game_id)));

create or replace view public.jamie_parlay_results as
 SELECT id,
    leg_key,
    n_legs,
    legs,
    our_prob,
    cost,
    grade,
    logged_at,
    ( SELECT count(*) AS count
           FROM (jsonb_array_elements(p.legs) x(value)
             JOIN jamie_player_stats s ON (((s.game_id = (x.value ->> 'game_id'::text)) AND (s.player_key = (x.value ->> 'player_key'::text)) AND (s.stat = (x.value ->> 'stat'::text)))))
          WHERE (((s.value > ((x.value ->> 'strike'::text))::numeric) AND ((x.value ->> 'side'::text) = 'yes'::text)) OR (s.final AND (s.value <= ((x.value ->> 'strike'::text))::numeric) AND ((x.value ->> 'side'::text) = 'no'::text)))) AS legs_won,
    ( SELECT count(*) AS count
           FROM (jsonb_array_elements(p.legs) x(value)
             JOIN jamie_player_stats s ON (((s.game_id = (x.value ->> 'game_id'::text)) AND (s.player_key = (x.value ->> 'player_key'::text)) AND (s.stat = (x.value ->> 'stat'::text)))))
          WHERE (((s.value > ((x.value ->> 'strike'::text))::numeric) AND ((x.value ->> 'side'::text) = 'no'::text)) OR (s.final AND (s.value <= ((x.value ->> 'strike'::text))::numeric) AND ((x.value ->> 'side'::text) = 'yes'::text)))) AS legs_lost,
    ( SELECT count(*) AS count
           FROM (jsonb_array_elements(p.legs) x(value)
             JOIN jamie_player_stats s ON (((s.game_id = (x.value ->> 'game_id'::text)) AND (s.player_key = (x.value ->> 'player_key'::text)) AND (s.stat = (x.value ->> 'stat'::text)))))
          WHERE (s.final OR (s.value > ((x.value ->> 'strike'::text))::numeric))) AS legs_final,
    kind
   FROM jamie_parlay_log p;

create or replace view public.jamie_parlay_scorecard as
 WITH cur AS (
         SELECT games.week,
            games.season
           FROM games
          WHERE (games.kickoff_utc <= (now() + '12:00:00'::interval))
          ORDER BY games.kickoff_utc DESC
         LIMIT 1
        ), r AS (
         SELECT x.id,
            x.leg_key,
            x.n_legs,
            x.legs,
            x.our_prob,
            x.cost,
            x.grade,
            x.logged_at,
            x.legs_won,
            x.legs_lost,
            x.legs_final,
            x.kind,
                CASE
                    WHEN (x.legs_lost > 0) THEN 'loss'::text
                    WHEN (x.legs_won = x.n_legs) THEN 'win'::text
                    ELSE NULL::text
                END AS result,
                CASE
                    WHEN (x.kind = 'big'::text) THEN 'Big Coin Flip'::text
                    ELSE (x.n_legs || '-leg'::text)
                END AS parlay_type,
            (((x.logged_at AT TIME ZONE 'America/New_York'::text))::date = ((now() AT TIME ZONE 'America/New_York'::text))::date) AS is_today,
            (((x.logged_at AT TIME ZONE 'America/New_York'::text))::date >= (((now() AT TIME ZONE 'America/New_York'::text))::date - (((EXTRACT(dow FROM (now() AT TIME ZONE 'America/New_York'::text)))::integer + 5) % 7))) AS is_week
           FROM jamie_parlay_results x
        ), scoped AS (
         SELECT 'today'::text AS scope,
            r.id,
            r.leg_key,
            r.n_legs,
            r.legs,
            r.our_prob,
            r.cost,
            r.grade,
            r.logged_at,
            r.legs_won,
            r.legs_lost,
            r.legs_final,
            r.kind,
            r.result,
            r.parlay_type,
            r.is_today,
            r.is_week
           FROM r
          WHERE r.is_today
        UNION ALL
         SELECT 'week'::text,
            r.id,
            r.leg_key,
            r.n_legs,
            r.legs,
            r.our_prob,
            r.cost,
            r.grade,
            r.logged_at,
            r.legs_won,
            r.legs_lost,
            r.legs_final,
            r.kind,
            r.result,
            r.parlay_type,
            r.is_today,
            r.is_week
           FROM r
          WHERE r.is_week
        UNION ALL
         SELECT 'season'::text,
            r.id,
            r.leg_key,
            r.n_legs,
            r.legs,
            r.our_prob,
            r.cost,
            r.grade,
            r.logged_at,
            r.legs_won,
            r.legs_lost,
            r.legs_final,
            r.kind,
            r.result,
            r.parlay_type,
            r.is_today,
            r.is_week
           FROM r
        )
 SELECT scope,
    parlay_type,
    g AS grade,
    count(*) FILTER (WHERE (result = 'win'::text)) AS wins,
    count(*) FILTER (WHERE (result = 'loss'::text)) AS losses,
    count(*) FILTER (WHERE (result IS NULL)) AS pending,
    round(((100.0 * (count(*) FILTER (WHERE (result = 'win'::text)))::numeric) / (NULLIF(count(*) FILTER (WHERE (result IS NOT NULL)), 0))::numeric), 1) AS win_pct,
    round(((100)::numeric * avg(our_prob) FILTER (WHERE (result IS NOT NULL))), 1) AS said_pct,
    round(((100)::numeric * avg(cost) FILTER (WHERE (result IS NOT NULL))), 1) AS avg_price_cents,
    round((((100)::numeric * sum(
        CASE
            WHEN (result = 'win'::text) THEN ((1)::numeric - cost)
            WHEN (result = 'loss'::text) THEN (- cost)
            ELSE (0)::numeric
        END)) / NULLIF(sum(cost) FILTER (WHERE (result IS NOT NULL)), (0)::numeric)), 1) AS return_pct
   FROM ( SELECT scoped.scope,
            scoped.parlay_type,
            scoped.grade AS g,
            scoped.result,
            scoped.our_prob,
            scoped.cost
           FROM scoped
        UNION ALL
         SELECT scoped.scope,
            scoped.parlay_type,
            'ALL'::text,
            scoped.result,
            scoped.our_prob,
            scoped.cost
           FROM scoped) z
  GROUP BY scope, parlay_type, g;

create or replace view public.jamie_record as
 SELECT 'legs'::text AS kind,
    jamie_leg_results.grade,
    count(*) FILTER (WHERE (jamie_leg_results.result = 'win'::text)) AS wins,
    count(*) FILTER (WHERE (jamie_leg_results.result = 'loss'::text)) AS losses,
    round(sum(
        CASE
            WHEN (jamie_leg_results.result = 'win'::text) THEN ((1)::numeric - jamie_leg_results.price)
            WHEN (jamie_leg_results.result = 'loss'::text) THEN (- jamie_leg_results.price)
            ELSE (0)::numeric
        END), 2) AS profit_per_contract,
    round(avg(jamie_leg_results.our_prob) FILTER (WHERE (jamie_leg_results.result IS NOT NULL)), 3) AS avg_said,
    NULL::numeric AS avg_cost
   FROM jamie_leg_results
  GROUP BY jamie_leg_results.grade
UNION ALL
 SELECT
        CASE
            WHEN (jamie_parlay_results.kind = 'big'::text) THEN 'big parlays'::text
            ELSE 'parlays'::text
        END AS kind,
    jamie_parlay_results.grade,
    count(*) FILTER (WHERE ((jamie_parlay_results.legs_lost = 0) AND (jamie_parlay_results.legs_final = jamie_parlay_results.n_legs))) AS wins,
    count(*) FILTER (WHERE (jamie_parlay_results.legs_lost > 0)) AS losses,
    round(sum(
        CASE
            WHEN ((jamie_parlay_results.legs_lost = 0) AND (jamie_parlay_results.legs_final = jamie_parlay_results.n_legs)) THEN ((1)::numeric - jamie_parlay_results.cost)
            WHEN (jamie_parlay_results.legs_lost > 0) THEN (- jamie_parlay_results.cost)
            ELSE (0)::numeric
        END), 2) AS profit_per_contract,
    round(avg(jamie_parlay_results.our_prob), 3) AS avg_said,
    round(avg(jamie_parlay_results.cost), 3) AS avg_cost
   FROM jamie_parlay_results
  GROUP BY
        CASE
            WHEN (jamie_parlay_results.kind = 'big'::text) THEN 'big parlays'::text
            ELSE 'parlays'::text
        END, jamie_parlay_results.grade;

create or replace view public.jamie_scorecard as
 WITH cur AS (
         SELECT games.week,
            games.season
           FROM games
          WHERE (games.kickoff_utc <= (now() + '12:00:00'::interval))
          ORDER BY games.kickoff_utc DESC
         LIMIT 1
        ), r AS (
         SELECT x.id,
            x.ticker,
            x.side,
            x.game_id,
            x.player_key,
            x.player_name,
            x.stat,
            x.strike,
            x.label,
            x.our_prob,
            x.price,
            x.edge,
            x.grade,
            x.game_state,
            x.minutes_left,
            x.logged_at,
            x.final_value,
            x.final,
            x.result,
            x.season,
            x.week,
            x.decided_early,
            (((x.logged_at AT TIME ZONE 'America/New_York'::text))::date = ((now() AT TIME ZONE 'America/New_York'::text))::date) AS is_today
           FROM jamie_leg_results x
        ), scoped AS (
         SELECT 'today'::text AS scope,
            r.grade,
            r.result,
            r.price,
            r.our_prob
           FROM r
          WHERE r.is_today
        UNION ALL
         SELECT 'week'::text,
            r.grade,
            r.result,
            r.price,
            r.our_prob
           FROM r,
            cur
          WHERE ((r.week = cur.week) AND (r.season = cur.season))
        UNION ALL
         SELECT 'season'::text,
            r.grade,
            r.result,
            r.price,
            r.our_prob
           FROM r,
            cur
          WHERE (r.season = cur.season)
        )
 SELECT scope,
    g AS grade,
    count(*) FILTER (WHERE (result = 'win'::text)) AS wins,
    count(*) FILTER (WHERE (result = 'loss'::text)) AS losses,
    count(*) FILTER (WHERE (result IS NULL)) AS pending,
    round(((100.0 * (count(*) FILTER (WHERE (result = 'win'::text)))::numeric) / (NULLIF(count(*) FILTER (WHERE (result IS NOT NULL)), 0))::numeric), 1) AS win_pct,
    round(((100)::numeric * avg(our_prob) FILTER (WHERE (result IS NOT NULL))), 1) AS said_pct,
    round(sum(
        CASE
            WHEN (result = 'win'::text) THEN ((1)::numeric - price)
            WHEN (result = 'loss'::text) THEN (- price)
            ELSE (0)::numeric
        END), 2) AS profit_per_contract,
    round((((100)::numeric * sum(
        CASE
            WHEN (result = 'win'::text) THEN ((1)::numeric - price)
            WHEN (result = 'loss'::text) THEN (- price)
            ELSE (0)::numeric
        END)) / NULLIF(sum(price) FILTER (WHERE (result IS NOT NULL)), (0)::numeric)), 1) AS return_pct
   FROM ( SELECT scoped.scope,
            scoped.grade AS g,
            scoped.result,
            scoped.price,
            scoped.our_prob
           FROM scoped
        UNION ALL
         SELECT scoped.scope,
            'ALL'::text,
            scoped.result,
            scoped.price,
            scoped.our_prob
           FROM scoped) z
  GROUP BY scope, g;

create or replace view public.member_bankroll as
 SELECT m.user_id,
    m.email,
    m.display_name,
    m.bankroll_start,
    COALESCE(sum(
        CASE
            WHEN (b.result = ANY (ARRAY['win'::text, 'loss'::text])) THEN (COALESCE(b.payout, (0)::numeric) - b.stake)
            ELSE NULL::numeric
        END), (0)::numeric) AS settled_pnl,
    COALESCE(sum(
        CASE
            WHEN ((b.result IS NULL) AND (COALESCE(b.status, ''::text) <> ALL (ARRAY['not_placed'::text, 'cancelled'::text, 'canceled'::text, 'rejected'::text, 'failed'::text]))) THEN b.stake
            ELSE NULL::numeric
        END), (0)::numeric) AS open_stake,
    ((m.bankroll_start + COALESCE(sum(
        CASE
            WHEN (b.result = ANY (ARRAY['win'::text, 'loss'::text])) THEN (COALESCE(b.payout, (0)::numeric) - b.stake)
            ELSE NULL::numeric
        END), (0)::numeric)) - COALESCE(sum(
        CASE
            WHEN ((b.result IS NULL) AND (COALESCE(b.status, ''::text) <> ALL (ARRAY['not_placed'::text, 'cancelled'::text, 'canceled'::text, 'rejected'::text, 'failed'::text]))) THEN b.stake
            ELSE NULL::numeric
        END), (0)::numeric)) AS available
   FROM (app_members m
     LEFT JOIN my_bets b ON ((b.user_id = m.user_id)))
  WHERE (m.role = 'member'::text)
  GROUP BY m.user_id, m.email, m.display_name, m.bankroll_start;

create or replace view public.model_calibration as
 SELECT source,
    (((((floor((LEAST(predicted, 0.999) * (10)::numeric)) * (10)::numeric))::integer || '–'::text) || (((floor((LEAST(predicted, 0.999) * (10)::numeric)) * (10)::numeric) + (10)::numeric))::integer) || '%'::text) AS bucket,
    (floor((LEAST(predicted, 0.999) * (10)::numeric)))::integer AS bucket_order,
    count(*) AS n,
    round(((100)::numeric * avg(predicted)), 1) AS predicted_pct,
    round(((100)::numeric * avg(hit)), 1) AS actual_pct,
    round(((100)::numeric * (avg(hit) - avg(predicted))), 1) AS gap_pts
   FROM model_calibration_points
  WHERE ((predicted IS NOT NULL) AND (hit IS NOT NULL))
  GROUP BY source, (floor((LEAST(predicted, 0.999) * (10)::numeric)));

create or replace view public.model_calibration_points as
 SELECT 'ATS picks'::text AS source,
    t.season,
    t.week,
        CASE
            WHEN (t.ats_pick = t.home_team) THEN t.home_cover_prob
            ELSE ((1)::numeric - t.home_cover_prob)
        END AS predicted,
        CASE
            WHEN (lower(t.ats_result) = 'win'::text) THEN 1
            WHEN (lower(t.ats_result) = 'loss'::text) THEN 0
            ELSE NULL::integer
        END AS hit,
    NULL::numeric AS market_predicted
   FROM track_record t
  WHERE (lower(COALESCE(t.ats_result, ''::text)) = ANY (ARRAY['win'::text, 'loss'::text]))
UNION ALL
 SELECT 'Winner (straight up)'::text AS source,
    t.season,
    t.week,
    t.model_home_prob AS predicted,
        CASE
            WHEN (t.home_score > t.away_score) THEN 1
            WHEN (t.home_score < t.away_score) THEN 0
            ELSE NULL::integer
        END AS hit,
    t.market_home_prob AS market_predicted
   FROM track_record t
  WHERE ((t.home_score IS NOT NULL) AND (t.home_score <> t.away_score) AND (t.model_home_prob IS NOT NULL))
UNION ALL
 SELECT 'Alt lines'::text AS source,
    x.season,
    x.week,
    x.our_prob AS predicted,
        CASE
            WHEN (x.result = 'WIN'::text) THEN 1
            WHEN (x.result = 'LOSS'::text) THEN 0
            ELSE NULL::integer
        END AS hit,
    x.kalshi_prob AS market_predicted
   FROM ( SELECT DISTINCT ON (r.game_id) r.game_id,
            r.season,
            r.week,
            r.our_prob,
            r.result,
            k.kalshi_prob
           FROM (alt_record r
             LEFT JOIN alt_picks_log k ON ((k.ticker = r.ticker)))
          WHERE (r.result = ANY (ARRAY['WIN'::text, 'LOSS'::text]))
          ORDER BY r.game_id, r.our_prob DESC) x
UNION ALL
 SELECT 'Parlays'::text AS source,
    p.season,
    p.week,
    p.our_prob AS predicted,
        CASE
            WHEN (p.result = 'WIN'::text) THEN 1
            WHEN (p.result = 'LOSS'::text) THEN 0
            ELSE NULL::integer
        END AS hit,
    p.kalshi_prob AS market_predicted
   FROM parlay_record p
  WHERE (p.result = ANY (ARRAY['WIN'::text, 'LOSS'::text]));

create or replace view public.model_scores as
 SELECT source,
    count(*) AS n,
    round(avg(power((predicted - (hit)::numeric), (2)::numeric)), 4) AS brier_ours,
    round(avg(power((market_predicted - (hit)::numeric), (2)::numeric)) FILTER (WHERE (market_predicted IS NOT NULL)), 4) AS brier_market,
    round(((100)::numeric * (avg(hit) - avg(predicted))), 1) AS overall_gap_pts,
        CASE
            WHEN (count(*) < 100) THEN 'Too few results to judge yet'::text
            WHEN (avg(power((predicted - (hit)::numeric), (2)::numeric)) < avg(power((market_predicted - (hit)::numeric), (2)::numeric)) FILTER (WHERE (market_predicted IS NOT NULL))) THEN 'Beating the market'::text
            WHEN (avg(power((market_predicted - (hit)::numeric), (2)::numeric)) FILTER (WHERE (market_predicted IS NOT NULL)) IS NULL) THEN 'No market comparison'::text
            ELSE 'Market is more accurate'::text
        END AS verdict
   FROM model_calibration_points
  WHERE ((predicted IS NOT NULL) AND (hit IS NOT NULL))
  GROUP BY source;

create or replace view public.my_bet_clv as
 WITH b AS (
         SELECT m.id,
            m.user_id,
            m.game_id,
            m.book,
            m.market,
            m.pick,
            m.line,
            m.odds,
            m.stake,
            m.placed_at,
            m.status,
            m.result,
            m.payout,
            m.external_order_id,
            m.ticker,
            m.side,
            m.contracts,
            m.grade,
            m.settled_at,
            m.legs,
                CASE
                    WHEN (m.contracts > (0)::numeric) THEN (m.stake / m.contracts)
                    ELSE NULL::numeric
                END AS price_paid
           FROM my_bets m
          WHERE ((COALESCE(m.result, ''::text) <> 'void'::text) AND (COALESCE(m.status, ''::text) <> ALL (ARRAY['canceled'::text, 'not_placed'::text])))
        ), singles AS (
         SELECT b.id,
            b.user_id,
            b.game_id,
            b.market,
            b.pick,
            b.placed_at,
            b.stake,
            b.result,
            b.price_paid,
                CASE
                    WHEN (b.side = 'no'::text) THEN ((1)::numeric - c.mid)
                    ELSE c.mid
                END AS closing_prob
           FROM (b
             JOIN closing_lines c ON ((c.ticker = b.ticker)))
          WHERE (b.market <> 'parlay'::text)
        ), parlays AS (
         SELECT b.id,
            b.user_id,
            b.game_id,
            b.market,
            b.pick,
            b.placed_at,
            b.stake,
            b.result,
            b.price_paid,
            ( SELECT exp(sum(ln(GREATEST(c.mid, 0.001)))) AS exp
                   FROM (jsonb_array_elements(b.legs) l(value)
                     JOIN closing_lines c ON ((c.ticker = (l.value ->> 'ticker'::text))))) AS closing_prob,
            ( SELECT count(*) AS count
                   FROM (jsonb_array_elements(b.legs) l(value)
                     LEFT JOIN closing_lines c ON ((c.ticker = (l.value ->> 'ticker'::text))))
                  WHERE (c.ticker IS NULL)) AS missing
           FROM b
          WHERE ((b.market = 'parlay'::text) AND (jsonb_typeof(b.legs) = 'array'::text))
        )
 SELECT id,
    user_id,
    game_id,
    market,
    pick,
    placed_at,
    stake,
    result,
    round(price_paid, 3) AS price_paid,
    round(closing_prob, 3) AS closing_prob,
    round(((100)::numeric * (closing_prob - price_paid)), 1) AS clv_pts,
    (closing_prob > price_paid) AS beat_close
   FROM ( SELECT singles.id,
            singles.user_id,
            singles.game_id,
            singles.market,
            singles.pick,
            singles.placed_at,
            singles.stake,
            singles.result,
            singles.price_paid,
            singles.closing_prob
           FROM singles
        UNION ALL
         SELECT parlays.id,
            parlays.user_id,
            parlays.game_id,
            parlays.market,
            parlays.pick,
            parlays.placed_at,
            parlays.stake,
            parlays.result,
            parlays.price_paid,
            parlays.closing_prob
           FROM parlays
          WHERE (parlays.missing = 0)) x
  WHERE ((closing_prob IS NOT NULL) AND (price_paid IS NOT NULL));

create or replace view public.my_bet_history as
 SELECT b.id,
    b.user_id,
    b.game_id,
    b.book,
    b.market,
    b.pick,
    b.line,
    b.odds,
    b.stake,
    b.placed_at,
    b.status,
    b.result,
    b.payout,
    b.external_order_id,
    b.ticker,
    b.side,
    b.contracts,
    b.grade,
    b.settled_at,
    g.season,
    g.week,
    g.home_team,
    g.away_team,
    g.home_score,
    g.away_score,
    g.kickoff_utc,
        CASE
            WHEN (b.result = ANY (ARRAY['win'::text, 'loss'::text, 'push'::text])) THEN round((COALESCE(b.payout, (0)::numeric) - b.stake), 2)
            ELSE NULL::numeric
        END AS profit,
        CASE b.result
            WHEN 'win'::text THEN 'Won'::text
            WHEN 'loss'::text THEN 'Lost'::text
            WHEN 'push'::text THEN 'Push'::text
            WHEN 'void'::text THEN 'Canceled'::text
            ELSE
            CASE
                WHEN (b.status = 'resting'::text) THEN 'Waiting to fill'::text
                ELSE 'Open'::text
            END
        END AS result_label
   FROM (my_bets b
     LEFT JOIN games g ON ((g.game_id = b.game_id)));

create or replace view public.my_bet_summary as
 SELECT COALESCE(season, (EXTRACT(year FROM placed_at))::integer) AS season,
    week,
    market,
    count(*) AS bets,
    count(*) FILTER (WHERE (result = 'win'::text)) AS wins,
    count(*) FILTER (WHERE (result = 'loss'::text)) AS losses,
    count(*) FILTER (WHERE (result = 'push'::text)) AS pushes,
    count(*) FILTER (WHERE (result IS NULL)) AS open_bets,
    round(sum(stake) FILTER (WHERE (result = ANY (ARRAY['win'::text, 'loss'::text, 'push'::text]))), 2) AS staked,
    round(sum(COALESCE(payout, (0)::numeric)) FILTER (WHERE (result = ANY (ARRAY['win'::text, 'loss'::text, 'push'::text]))), 2) AS returned,
    round(sum((COALESCE(payout, (0)::numeric) - stake)) FILTER (WHERE (result = ANY (ARRAY['win'::text, 'loss'::text, 'push'::text]))), 2) AS profit,
    round((((100)::numeric * sum((COALESCE(payout, (0)::numeric) - stake)) FILTER (WHERE (result = ANY (ARRAY['win'::text, 'loss'::text, 'push'::text])))) / NULLIF(sum(stake) FILTER (WHERE (result = ANY (ARRAY['win'::text, 'loss'::text, 'push'::text]))), (0)::numeric)), 1) AS roi_pct
   FROM my_bet_history
  GROUP BY COALESCE(season, (EXTRACT(year FROM placed_at))::integer), week, market;

create or replace view public.my_parlay_live_legs as
 SELECT b.id AS bet_id,
    b.user_id,
    b.game_id,
    b.pick,
    b.stake,
    b.status AS bet_status,
    b.result AS bet_result,
    b.placed_at,
    e.ord AS leg_no,
    (e.x ->> 'ticker'::text) AS ticker,
    (e.x ->> 'side'::text) AS side,
    COALESCE((e.x ->> 'label'::text), m.label) AS label,
    m.player_name,
    m.stat,
    m.strike,
    ceil(m.strike) AS line,
    s.value AS current,
    COALESCE(s.final, false) AS final,
        CASE
            WHEN (s.value IS NULL) THEN NULL::text
            WHEN (((e.x ->> 'side'::text) = 'yes'::text) AND (s.value > m.strike)) THEN 'hit'::text
            WHEN (((e.x ->> 'side'::text) = 'no'::text) AND (s.value > m.strike)) THEN 'lost'::text
            WHEN (s.final AND ((e.x ->> 'side'::text) = 'yes'::text)) THEN 'lost'::text
            WHEN (s.final AND ((e.x ->> 'side'::text) = 'no'::text)) THEN 'hit'::text
            ELSE 'live'::text
        END AS leg_state,
        CASE
            WHEN (l.side = (e.x ->> 'side'::text)) THEN l.our_prob
            ELSE NULL::numeric
        END AS live_prob,
    l.minutes_left,
    split_part(m.player_key, '|'::text, 1) AS team
   FROM ((((my_bets b
     CROSS JOIN LATERAL jsonb_array_elements(b.legs) WITH ORDINALITY e(x, ord))
     LEFT JOIN jamie_ticker_map m ON ((m.ticker = (e.x ->> 'ticker'::text))))
     LEFT JOIN jamie_player_stats s ON (((s.game_id = m.game_id) AND (s.player_key = m.player_key) AND (s.stat = m.stat))))
     LEFT JOIN jamie_legs l ON ((l.ticker = (e.x ->> 'ticker'::text))))
  WHERE ((b.market = 'parlay'::text) AND (b.pick ~~ 'JAMIE%'::text));

create or replace view public.my_placed_bets as
 SELECT id,
    user_id,
    market,
    pick,
    stake,
    placed_at,
    status,
    result,
    ticker,
    side,
    game_id,
    pbm_bet_group(market) AS bet_group,
        CASE
            WHEN (market = 'parlay'::text) THEN NULL::text
            ELSE pbm_bet_team(ticker, side, game_id)
        END AS pick_team,
        CASE
            WHEN (market = 'parlay'::text) THEN ( SELECT string_agg((x.value ->> 'ticker'::text), '|'::text ORDER BY (x.value ->> 'ticker'::text)) AS string_agg
               FROM jsonb_array_elements(my_bets.legs) x(value))
            ELSE ticker
        END AS bet_key,
        CASE
            WHEN (market = 'parlay'::text) THEN ('parlay|'::text || ( SELECT string_agg((x.value ->> 'ticker'::text), '|'::text ORDER BY (x.value ->> 'ticker'::text)) AS string_agg
               FROM jsonb_array_elements(my_bets.legs) x(value)))
            ELSE ((((game_id || '|'::text) || pbm_bet_group(market)) || '|'::text) || COALESCE(pbm_bet_team(ticker, side, game_id), ''::text))
        END AS intent_key
   FROM my_bets
  WHERE ((placed_at > (now() - '14 days'::interval)) AND (COALESCE(result, ''::text) <> 'void'::text) AND (COALESCE(status, ''::text) <> ALL (ARRAY['canceled'::text, 'not_placed'::text])));

create or replace view public.my_pnl_curve as
 SELECT id,
    settled_at,
    pick,
    market,
    stake,
    COALESCE(payout, (0)::numeric) AS payout,
    result,
    round((COALESCE(payout, (0)::numeric) - stake), 2) AS profit,
    round(sum((COALESCE(payout, (0)::numeric) - stake)) OVER (PARTITION BY user_id ORDER BY settled_at, id), 2) AS cumulative_profit,
    round(sum(stake) OVER (PARTITION BY user_id ORDER BY settled_at, id), 2) AS cumulative_staked
   FROM my_bets
  WHERE ((result = ANY (ARRAY['win'::text, 'loss'::text, 'push'::text])) AND (settled_at IS NOT NULL));

create or replace view public.news_agent_record as
 WITH last_scan AS (
         SELECT DISTINCT ON (l.game_id) l.game_id,
            l.home_adj_pts,
            l.away_adj_pts,
            l.scanned_at
           FROM (news_intel_log l
             JOIN games g_1 ON ((g_1.game_id = l.game_id)))
          WHERE (l.scanned_at < g_1.kickoff_utc)
          ORDER BY l.game_id, l.scanned_at DESC
        )
 SELECT g.season,
    g.week,
    g.game_id,
    g.away_team,
    g.home_team,
    g.spread_line,
    g.home_score,
    g.away_score,
    round((s.home_adj_pts - s.away_adj_pts), 2) AS net_home_adj,
    (((g.home_score - g.away_score))::numeric - COALESCE(g.spread_line, (0)::numeric)) AS home_vs_spread,
        CASE
            WHEN (g.home_score IS NULL) THEN NULL::text
            WHEN (abs((s.home_adj_pts - s.away_adj_pts)) < 0.5) THEN 'no_signal'::text
            WHEN (sign((s.home_adj_pts - s.away_adj_pts)) = sign((((g.home_score - g.away_score))::numeric - COALESCE(g.spread_line, (0)::numeric)))) THEN 'right'::text
            WHEN ((((g.home_score - g.away_score))::numeric - COALESCE(g.spread_line, (0)::numeric)) = (0)::numeric) THEN 'push'::text
            ELSE 'wrong'::text
        END AS result
   FROM (last_scan s
     JOIN games g ON ((g.game_id = s.game_id)));

create or replace view public.overall_picks as
 SELECT s.season,
    s.week,
    s.game_id,
    g.kickoff_utc,
    s.away_team,
    s.home_team,
    s.ats_pick,
        CASE
            WHEN (s.ats_pick = s.home_team) THEN (- s.spread_line)
            ELSE s.spread_line
        END AS pick_spread,
    s.rating,
    (s.bet_score)::numeric AS bet_score,
    (s.away_score)::numeric AS away_score,
    (s.home_score)::numeric AS home_score,
    lower(s.ats_result) AS result,
    'final'::text AS status
   FROM (sheet_results s
     LEFT JOIN games g USING (game_id))
UNION ALL
 SELECT b.season,
    b.week,
    b.game_id,
    b.kickoff_utc,
    b.away_team,
    b.home_team,
    b.ats_pick,
    b.ats_pick_spread AS pick_spread,
    b.rating,
    (b.bet_score)::numeric AS bet_score,
    NULL::numeric AS away_score,
    NULL::numeric AS home_score,
    NULL::text AS result,
    'upcoming'::text AS status
   FROM bet_sheet b
  WHERE (NOT (EXISTS ( SELECT 1
           FROM sheet_results s
          WHERE (s.game_id = b.game_id))));

create or replace view public.parlay_record as
 SELECT p.combo_key,
    p.season,
    p.week,
    p.legs,
    p.tickers,
    p.leg_detail,
    p.our_prob,
    p.kalshi_prob,
    p.parlay_score,
    p.logged_at,
        CASE
            WHEN bool_or((r.result IS NULL)) THEN NULL::text
            WHEN bool_and((r.result = 'WIN'::text)) THEN 'WIN'::text
            ELSE 'LOSS'::text
        END AS result
   FROM ((parlay_log p
     LEFT JOIN LATERAL unnest(p.tickers) t(ticker) ON (true))
     LEFT JOIN alt_record r ON ((r.ticker = t.ticker)))
  GROUP BY p.combo_key, p.season, p.week, p.legs, p.tickers, p.leg_detail, p.our_prob, p.kalshi_prob, p.parlay_score, p.logged_at;

create or replace view public.pick_clv as
 SELECT l.ticker,
    l.game_id,
    l.season,
    l.week,
    l.bet_label,
    l.grade,
    l.alt_score,
    l.our_prob,
    COALESCE(l.first_yes_ask, l.yes_ask) AS price_at_pick,
    COALESCE(l.first_logged_at, l.logged_at) AS picked_at,
    c.mid AS closing_prob,
    round(((100)::numeric * (c.mid - COALESCE(l.first_yes_ask, l.yes_ask))), 1) AS clv_pts,
    (c.mid > COALESCE(l.first_yes_ask, l.yes_ask)) AS beat_close,
    r.result
   FROM ((alt_picks_log l
     JOIN closing_lines c USING (ticker))
     LEFT JOIN alt_record r USING (ticker));

create or replace view public.pick_kalshi_map as
 SELECT b.season,
    b.week,
    b.game_id,
    b.bet_rank,
    b.rank,
    b.ats_pick,
    b.ats_pick_spread,
    b.rating,
    b.units,
    (((b.ats_pick || ' '::text) ||
        CASE
            WHEN (b.ats_pick_spread > (0)::numeric) THEN '+'::text
            ELSE ''::text
        END) || b.ats_pick_spread) AS pick_label,
    a.ticker,
    a.event_title,
    a.market_title,
        CASE
            WHEN (b.ats_pick_spread < (0)::numeric) THEN 'yes'::text
            ELSE 'no'::text
        END AS side,
        CASE
            WHEN (b.ats_pick_spread < (0)::numeric) THEN a.yes_ask
            ELSE round(((1)::numeric - a.yes_bid), 2)
        END AS price,
        CASE
            WHEN (a.ticker IS NULL) THEN NULL::text
            WHEN (b.ats_pick_spread < (0)::numeric) THEN (('Buy YES on "'::text || a.market_title) || '"'::text)
            ELSE (('Buy NO on "'::text || a.market_title) || '"'::text)
        END AS how_to,
    ('https://kalshi.com/markets/kxnflspread/pro-football-spread/'::text || lower(a.event_ticker)) AS kalshi_url,
    (a.ticker IS NOT NULL) AS on_kalshi,
    (b.ats_pick_spread = floor(b.ats_pick_spread)) AS push_becomes_win
   FROM (bet_sheet b
     LEFT JOIN kalshi_alt_lines a ON (((a.game_id = b.game_id) AND (a.status = ANY (ARRAY['active'::text, 'open'::text])) AND (((b.ats_pick_spread < (0)::numeric) AND (a.team = b.ats_pick) AND (a.threshold =
        CASE
            WHEN ((- b.ats_pick_spread) = floor((- b.ats_pick_spread))) THEN ((- b.ats_pick_spread) - 0.5)
            ELSE (- b.ats_pick_spread)
        END)) OR ((b.ats_pick_spread > (0)::numeric) AND (a.team =
        CASE
            WHEN (b.ats_pick = b.home_team) THEN b.away_team
            ELSE b.home_team
        END) AND (a.threshold =
        CASE
            WHEN (b.ats_pick_spread = floor(b.ats_pick_spread)) THEN (b.ats_pick_spread + 0.5)
            ELSE b.ats_pick_spread
        END))))));

create or replace view public.research_scorecard as
 WITH m AS (
         SELECT weekly_scorecard.season,
            weekly_scorecard.week,
            weekly_scorecard.ats_wins,
            weekly_scorecard.ats_losses,
            weekly_scorecard.su_wins,
            weekly_scorecard.su_losses,
            weekly_scorecard.bet_wins,
            weekly_scorecard.bet_losses,
            weekly_scorecard.units_net,
            weekly_scorecard.a_wins,
            weekly_scorecard.a_losses,
            weekly_scorecard.consensus_wins,
            weekly_scorecard.consensus_losses,
            weekly_scorecard.kalshi_su_wins,
            weekly_scorecard.kalshi_su_losses,
            weekly_scorecard.vegas_su_wins,
            weekly_scorecard.vegas_su_losses
           FROM weekly_scorecard
        ), n AS (
         SELECT news_agent_record.season,
            news_agent_record.week,
            count(*) FILTER (WHERE (news_agent_record.result = 'right'::text)) AS news_right,
            count(*) FILTER (WHERE (news_agent_record.result = 'wrong'::text)) AS news_wrong
           FROM news_agent_record
          GROUP BY news_agent_record.season, news_agent_record.week
        ), a AS (
         SELECT alt_record.season,
            alt_record.week,
            count(*) FILTER (WHERE (alt_record.result = 'win'::text)) AS alt_wins,
            count(*) FILTER (WHERE (alt_record.result = 'loss'::text)) AS alt_losses
           FROM alt_record
          GROUP BY alt_record.season, alt_record.week
        ), p AS (
         SELECT parlay_record.season,
            parlay_record.week,
            count(*) FILTER (WHERE (parlay_record.result = 'win'::text)) AS parlay_wins,
            count(*) FILTER (WHERE (parlay_record.result = 'loss'::text)) AS parlay_losses
           FROM parlay_record
          GROUP BY parlay_record.season, parlay_record.week
        )
 SELECT m.season,
    m.week,
    m.ats_wins,
    m.ats_losses,
    m.su_wins,
    m.su_losses,
    m.bet_wins,
    m.bet_losses,
    m.units_net,
    m.a_wins,
    m.a_losses,
    m.consensus_wins,
    m.consensus_losses,
    m.kalshi_su_wins,
    m.kalshi_su_losses,
    m.vegas_su_wins,
    m.vegas_su_losses,
    COALESCE(n.news_right, (0)::bigint) AS news_right,
    COALESCE(n.news_wrong, (0)::bigint) AS news_wrong,
    COALESCE(a.alt_wins, (0)::bigint) AS alt_wins,
    COALESCE(a.alt_losses, (0)::bigint) AS alt_losses,
    COALESCE(p.parlay_wins, (0)::bigint) AS parlay_wins,
    COALESCE(p.parlay_losses, (0)::bigint) AS parlay_losses
   FROM (((m
     LEFT JOIN n USING (season, week))
     LEFT JOIN a USING (season, week))
     LEFT JOIN p USING (season, week));

create or replace view public.shadow_bet_sheet as
 SELECT rank() OVER (PARTITION BY season, week ORDER BY b.predicted_winner_prob DESC, bet_score DESC) AS rank,
    rank() OVER (PARTITION BY season, week ORDER BY
        CASE rating
            WHEN 'A+'::text THEN 6
            WHEN 'A'::text THEN 5
            WHEN 'B+'::text THEN 4
            WHEN 'B'::text THEN 3
            WHEN 'C'::text THEN 2
            ELSE 1
        END DESC, b.risk_index, bet_score DESC) AS bet_rank,
    season,
    week,
    slate,
    game_date_et,
    kickoff_utc,
    game_id,
    away_team,
    home_team,
    predicted_winner,
    round(predicted_winner_prob, 4) AS predicted_winner_prob,
        CASE
            WHEN (predicted_winner = home_team) THEN (- spread_line)
            ELSE spread_line
        END AS winner_spread,
        CASE
            WHEN (predicted_winner = home_team) THEN home_moneyline
            ELSE away_moneyline
        END AS winner_moneyline,
    ats_pick,
        CASE
            WHEN (ats_pick = home_team) THEN (- spread_line)
            ELSE spread_line
        END AS ats_pick_spread,
    round(ats_pick_prob, 4) AS ats_pick_prob,
    rating,
    bet_score,
    risk_rating,
    round(risk_index, 3) AS risk_index,
    units,
    consensus_pick,
    expert_count,
    total_line,
    kalshi_winner,
    kalshi_winner_prob,
    kalshi_home_prob,
    kalshi_edge_pts,
    pbm_agrees_with_kalshi,
    kalshi_value_side,
    kalshi_value_pts,
    kalshi_updated_at,
    vegas_winner,
    vegas_winner_prob,
    vegas_home_prob,
    vegas_favorite,
    vegas_fav_points,
    home_moneyline,
    away_moneyline,
    vegas_edge_pts,
    pbm_agrees_with_vegas
   FROM shadow_game_board b
  WHERE (home_score IS NULL);

create or replace view public.shadow_game_board as
 WITH base AS (
         SELECT g.game_id,
            g.season,
            g.week,
            g.game_type,
            g.kickoff_utc,
            g.slate,
            g.game_date_et,
            g.home_team,
            g.away_team,
            g.home_score,
            g.away_score,
            g.stadium,
            g.stadium_id,
            g.roof,
            g.surface,
            g.spread_line,
            g.total_line,
            g.home_moneyline,
            g.away_moneyline,
            g.home_rest,
            g.away_rest,
            g.home_qb,
            g.away_qb,
            g.div_game,
            p.model_home_prob,
            p.blend_home_prob,
            p.market_home_prob,
            p.spread_home_prob,
            p.model_margin,
            p.home_cover_prob,
            p.categories,
            p.top_features,
            p.home_starters_out,
            p.away_starters_out,
            p.home_inj_total,
            p.away_inj_total,
            p.questionable_starters,
            p.weather_severity,
            p.early_season,
            p.model_market_gap,
            p.updated_at,
            w.temp_f,
            w.wind_mph,
            w.gust_mph,
            w.wind_dir,
            w.humidity,
            w.precip_prob,
            w.pressure_mb,
            w.short_forecast,
            w.indoor,
            w.source AS weather_source,
            w.fetched_at AS weather_at,
            n.home_adj_pts,
            n.away_adj_pts,
            n.home_confidence,
            n.away_confidence,
            n.volatility,
            n.home_items,
            n.away_items,
            n.game_brief,
            n.scanned_at,
            GREATEST(('-4'::integer)::numeric, LEAST((4)::numeric, (COALESCE(n.home_adj_pts, (0)::numeric) - COALESCE(n.away_adj_pts, (0)::numeric)))) AS news_pts
           FROM (((games g
             JOIN shadow_predictions p USING (game_id))
             LEFT JOIN weather w USING (game_id))
             LEFT JOIN news_intel n USING (game_id))
        ), calc AS (
         SELECT b.game_id,
            b.season,
            b.week,
            b.game_type,
            b.kickoff_utc,
            b.slate,
            b.game_date_et,
            b.home_team,
            b.away_team,
            b.home_score,
            b.away_score,
            b.stadium,
            b.stadium_id,
            b.roof,
            b.surface,
            b.spread_line,
            b.total_line,
            b.home_moneyline,
            b.away_moneyline,
            b.home_rest,
            b.away_rest,
            b.home_qb,
            b.away_qb,
            b.div_game,
            b.model_home_prob,
            b.blend_home_prob,
            b.market_home_prob,
            b.spread_home_prob,
            b.model_margin,
            b.home_cover_prob,
            b.categories,
            b.top_features,
            b.home_starters_out,
            b.away_starters_out,
            b.home_inj_total,
            b.away_inj_total,
            b.questionable_starters,
            b.weather_severity,
            b.early_season,
            b.model_market_gap,
            b.updated_at,
            b.temp_f,
            b.wind_mph,
            b.gust_mph,
            b.wind_dir,
            b.humidity,
            b.precip_prob,
            b.pressure_mb,
            b.short_forecast,
            b.indoor,
            b.weather_source,
            b.weather_at,
            b.home_adj_pts,
            b.away_adj_pts,
            b.home_confidence,
            b.away_confidence,
            b.volatility,
            b.home_items,
            b.away_items,
            b.game_brief,
            b.scanned_at,
            b.news_pts,
            (b.model_margin + b.news_pts) AS adj_margin,
            pbm_phi((((b.model_margin + b.news_pts) - b.spread_line) / 13.45)) AS adj_home_cover,
            ((1)::numeric / ((1)::numeric + exp((- (ln((b.blend_home_prob / ((1)::numeric - b.blend_home_prob))) + (0.12 * b.news_pts)))))) AS adj_home_win
           FROM base b
        ), picks AS (
         SELECT c.game_id,
            c.season,
            c.week,
            c.game_type,
            c.kickoff_utc,
            c.slate,
            c.game_date_et,
            c.home_team,
            c.away_team,
            c.home_score,
            c.away_score,
            c.stadium,
            c.stadium_id,
            c.roof,
            c.surface,
            c.spread_line,
            c.total_line,
            c.home_moneyline,
            c.away_moneyline,
            c.home_rest,
            c.away_rest,
            c.home_qb,
            c.away_qb,
            c.div_game,
            c.model_home_prob,
            c.blend_home_prob,
            c.market_home_prob,
            c.spread_home_prob,
            c.model_margin,
            c.home_cover_prob,
            c.categories,
            c.top_features,
            c.home_starters_out,
            c.away_starters_out,
            c.home_inj_total,
            c.away_inj_total,
            c.questionable_starters,
            c.weather_severity,
            c.early_season,
            c.model_market_gap,
            c.updated_at,
            c.temp_f,
            c.wind_mph,
            c.gust_mph,
            c.wind_dir,
            c.humidity,
            c.precip_prob,
            c.pressure_mb,
            c.short_forecast,
            c.indoor,
            c.weather_source,
            c.weather_at,
            c.home_adj_pts,
            c.away_adj_pts,
            c.home_confidence,
            c.away_confidence,
            c.volatility,
            c.home_items,
            c.away_items,
            c.game_brief,
            c.scanned_at,
            c.news_pts,
            c.adj_margin,
            c.adj_home_cover,
            c.adj_home_win,
                CASE
                    WHEN (c.adj_home_cover >= 0.5) THEN c.home_team
                    ELSE c.away_team
                END AS ats_pick,
            GREATEST(c.adj_home_cover, ((1)::numeric - c.adj_home_cover)) AS ats_pick_prob,
            ((c.adj_home_win * (pbm_dec((c.home_moneyline)::numeric) - (1)::numeric)) - ((1)::numeric - c.adj_home_win)) AS ev_home_adj,
            ((((1)::numeric - c.adj_home_win) * (pbm_dec((c.away_moneyline)::numeric) - (1)::numeric)) - c.adj_home_win) AS ev_away_adj,
            LEAST((1)::numeric, GREATEST((0)::numeric, ((((((0.20 * (COALESCE(c.early_season, 0))::numeric) + (0.04 * (LEAST(COALESCE(c.questionable_starters, 0), 6))::numeric)) + (0.25 * COALESCE(c.weather_severity, (0)::numeric))) + (0.30 * COALESCE(c.volatility, 0.5))) + (0.20 * LEAST((1)::numeric, GREATEST((0)::numeric, ((COALESCE(c.model_market_gap, (0)::numeric) - (7)::numeric) / 7.0))))) +
                CASE
                    WHEN (c.scanned_at IS NULL) THEN 0.10
                    ELSE (0)::numeric
                END))) AS risk_index
           FROM calc c
        ), scored AS (
         SELECT p.game_id,
            p.season,
            p.week,
            p.game_type,
            p.kickoff_utc,
            p.slate,
            p.game_date_et,
            p.home_team,
            p.away_team,
            p.home_score,
            p.away_score,
            p.stadium,
            p.stadium_id,
            p.roof,
            p.surface,
            p.spread_line,
            p.total_line,
            p.home_moneyline,
            p.away_moneyline,
            p.home_rest,
            p.away_rest,
            p.home_qb,
            p.away_qb,
            p.div_game,
            p.model_home_prob,
            p.blend_home_prob,
            p.market_home_prob,
            p.spread_home_prob,
            p.model_margin,
            p.home_cover_prob,
            p.categories,
            p.top_features,
            p.home_starters_out,
            p.away_starters_out,
            p.home_inj_total,
            p.away_inj_total,
            p.questionable_starters,
            p.weather_severity,
            p.early_season,
            p.model_market_gap,
            p.updated_at,
            p.temp_f,
            p.wind_mph,
            p.gust_mph,
            p.wind_dir,
            p.humidity,
            p.precip_prob,
            p.pressure_mb,
            p.short_forecast,
            p.indoor,
            p.weather_source,
            p.weather_at,
            p.home_adj_pts,
            p.away_adj_pts,
            p.home_confidence,
            p.away_confidence,
            p.volatility,
            p.home_items,
            p.away_items,
            p.game_brief,
            p.scanned_at,
            p.news_pts,
            p.adj_margin,
            p.adj_home_cover,
            p.adj_home_win,
            p.ats_pick,
            p.ats_pick_prob,
            p.ev_home_adj,
            p.ev_away_adj,
            p.risk_index,
                CASE
                    WHEN (p.ev_home_adj >= p.ev_away_adj) THEN p.home_team
                    ELSE p.away_team
                END AS ml_pick,
            GREATEST(p.ev_home_adj, p.ev_away_adj) AS ml_pick_ev,
            ((((((60)::numeric * LEAST((1)::numeric, GREATEST((0)::numeric, ((p.ats_pick_prob - 0.5238) / 0.10)))) + ((20)::numeric * LEAST((1)::numeric, GREATEST((0)::numeric, (GREATEST(p.ev_home_adj, p.ev_away_adj) / 0.10))))) + (
                CASE
                    WHEN (sign((p.model_home_prob - p.market_home_prob)) = sign((p.adj_margin - p.spread_line))) THEN 10
                    ELSE 0
                END)::numeric) +
                CASE
                    WHEN ((p.news_pts <> (0)::numeric) AND (sign(p.news_pts) = sign((p.adj_home_cover - 0.5)))) THEN ((10)::numeric * COALESCE(GREATEST(p.home_confidence, p.away_confidence), 0.5))
                    ELSE (0)::numeric
                END) * ((1)::numeric - (0.35 * p.risk_index))) AS raw_score
           FROM picks p
        )
 SELECT s.game_id,
    s.season,
    s.week,
    s.game_type,
    s.kickoff_utc,
    s.slate,
    s.game_date_et,
    s.home_team,
    s.away_team,
    s.home_score,
    s.away_score,
    s.stadium,
    s.stadium_id,
    s.roof,
    s.surface,
    s.spread_line,
    s.total_line,
    s.home_moneyline,
    s.away_moneyline,
    s.home_rest,
    s.away_rest,
    s.home_qb,
    s.away_qb,
    s.div_game,
    s.model_home_prob,
    s.blend_home_prob,
    s.market_home_prob,
    s.spread_home_prob,
    s.model_margin,
    s.home_cover_prob,
    s.categories,
    s.top_features,
    s.home_starters_out,
    s.away_starters_out,
    s.home_inj_total,
    s.away_inj_total,
    s.questionable_starters,
    s.weather_severity,
    s.early_season,
    s.model_market_gap,
    s.updated_at,
    s.temp_f,
    s.wind_mph,
    s.gust_mph,
    s.wind_dir,
    s.humidity,
    s.precip_prob,
    s.pressure_mb,
    s.short_forecast,
    s.indoor,
    s.weather_source,
    s.weather_at,
    s.home_adj_pts,
    s.away_adj_pts,
    s.home_confidence,
    s.away_confidence,
    s.volatility,
    s.home_items,
    s.away_items,
    s.game_brief,
    s.scanned_at,
    s.news_pts,
    s.adj_margin,
    s.adj_home_cover,
    s.adj_home_win,
    s.ats_pick,
    s.ats_pick_prob,
    s.ev_home_adj,
    s.ev_away_adj,
    s.risk_index,
    s.ml_pick,
    s.ml_pick_ev,
    s.raw_score,
    ec.n_spread AS expert_count,
    ec.consensus_pick,
    ec.consensus_pct,
    ec.consensus_score,
        CASE
            WHEN (ec.consensus_score >= 80) THEN 'A+'::text
            WHEN (ec.consensus_score >= 70) THEN 'A'::text
            WHEN (ec.consensus_score >= 60) THEN 'B+'::text
            WHEN (ec.consensus_score >= 50) THEN 'B'::text
            WHEN (ec.consensus_score >= 40) THEN 'C'::text
            ELSE 'PASS'::text
        END AS consensus_rating,
    (ec.consensus_pick = s.ats_pick) AS pbm_agrees_with_experts,
    ec.n_over,
    ec.n_under,
    ec.expert_picks,
    (round(LEAST((100)::numeric, GREATEST((0)::numeric, s.raw_score))))::integer AS bet_score,
        CASE
            WHEN (s.raw_score >= (80)::numeric) THEN 'A+'::text
            WHEN (s.raw_score >= (70)::numeric) THEN 'A'::text
            WHEN (s.raw_score >= (60)::numeric) THEN 'B+'::text
            WHEN (s.raw_score >= (50)::numeric) THEN 'B'::text
            WHEN (s.raw_score >= (40)::numeric) THEN 'C'::text
            ELSE 'PASS'::text
        END AS rating,
        CASE
            WHEN (s.risk_index < 0.2) THEN 'Low'::text
            WHEN (s.risk_index < 0.4) THEN 'Moderate'::text
            WHEN (s.risk_index < 0.6) THEN 'Elevated'::text
            WHEN (s.risk_index < 0.8) THEN 'High'::text
            ELSE 'Extreme'::text
        END AS risk_rating,
        CASE
            WHEN (s.raw_score >= (80)::numeric) THEN (2)::numeric
            WHEN (s.raw_score >= (70)::numeric) THEN 1.5
            WHEN (s.raw_score >= (60)::numeric) THEN (1)::numeric
            WHEN (s.raw_score >= (50)::numeric) THEN 0.5
            ELSE (0)::numeric
        END AS units,
        CASE
            WHEN (s.adj_home_win >= 0.5) THEN s.home_team
            ELSE s.away_team
        END AS predicted_winner,
    GREATEST(s.adj_home_win, ((1)::numeric - s.adj_home_win)) AS predicted_winner_prob,
    round(km.home_prob, 4) AS kalshi_home_prob,
        CASE
            WHEN (km.home_prob IS NULL) THEN NULL::text
            WHEN (km.home_prob >= 0.5) THEN s.home_team
            ELSE s.away_team
        END AS kalshi_winner,
    round(GREATEST(km.home_prob, ((1)::numeric - km.home_prob)), 4) AS kalshi_winner_prob,
    km.home_yes_ask AS kalshi_home_ask,
    km.away_yes_ask AS kalshi_away_ask,
    km.fetched_at AS kalshi_updated_at,
    round(((100)::numeric * (GREATEST(s.adj_home_win, ((1)::numeric - s.adj_home_win)) -
        CASE
            WHEN (s.adj_home_win >= 0.5) THEN km.home_prob
            ELSE ((1)::numeric - km.home_prob)
        END)), 1) AS kalshi_edge_pts,
    ((km.home_prob IS NOT NULL) AND ((km.home_prob >= 0.5) = (s.adj_home_win >= 0.5))) AS pbm_agrees_with_kalshi,
        CASE
            WHEN (km.home_yes_ask IS NULL) THEN NULL::text
            WHEN ((s.adj_home_win - km.home_yes_ask) >= (((1)::numeric - s.adj_home_win) - km.away_yes_ask)) THEN s.home_team
            ELSE s.away_team
        END AS kalshi_value_side,
    round(((100)::numeric * GREATEST((s.adj_home_win - km.home_yes_ask), (((1)::numeric - s.adj_home_win) - km.away_yes_ask))), 1) AS kalshi_value_pts,
    round(COALESCE(s.market_home_prob, s.spread_home_prob), 4) AS vegas_home_prob,
        CASE
            WHEN (COALESCE(s.market_home_prob, s.spread_home_prob) IS NULL) THEN NULL::text
            WHEN (COALESCE(s.market_home_prob, s.spread_home_prob) >= 0.5) THEN s.home_team
            ELSE s.away_team
        END AS vegas_winner,
    round(GREATEST(COALESCE(s.market_home_prob, s.spread_home_prob), ((1)::numeric - COALESCE(s.market_home_prob, s.spread_home_prob))), 4) AS vegas_winner_prob,
        CASE
            WHEN (s.spread_line > (0)::numeric) THEN s.home_team
            WHEN (s.spread_line < (0)::numeric) THEN s.away_team
            ELSE NULL::text
        END AS vegas_favorite,
    abs(s.spread_line) AS vegas_fav_points,
    round(((100)::numeric * (GREATEST(s.adj_home_win, ((1)::numeric - s.adj_home_win)) -
        CASE
            WHEN (s.adj_home_win >= 0.5) THEN COALESCE(s.market_home_prob, s.spread_home_prob)
            ELSE ((1)::numeric - COALESCE(s.market_home_prob, s.spread_home_prob))
        END)), 1) AS vegas_edge_pts,
    ((COALESCE(s.market_home_prob, s.spread_home_prob) IS NOT NULL) AND ((COALESCE(s.market_home_prob, s.spread_home_prob) >= 0.5) = (s.adj_home_win >= 0.5))) AS pbm_agrees_with_vegas
   FROM ((scored s
     LEFT JOIN expert_consensus ec USING (game_id))
     LEFT JOIN kalshi_markets km USING (game_id));

create or replace view public.shadow_sheet_results as
 WITH p AS (
         SELECT s.game_date_et,
            s.slate,
            s.season,
            s.week,
            s.is_final,
            e.value AS e
           FROM (shadow_slate_sheets s
             CROSS JOIN LATERAL jsonb_array_elements(s.payload) e(value))
        ), g AS (
         SELECT p.game_date_et,
            p.slate,
            p.season,
            p.week,
            p.is_final,
            p.e,
            gm.home_team,
            gm.away_team,
            gm.home_score,
            gm.away_score,
            (gm.home_score - gm.away_score) AS home_margin,
            ((p.e ->> 'spread_line'::text))::numeric AS spread_line,
            COALESCE((p.e ->> 'predicted_winner'::text),
                CASE
                    WHEN (((p.e ->> 'adj_home_win'::text))::numeric >= 0.5) THEN gm.home_team
                    ELSE gm.away_team
                END) AS predicted_winner,
            COALESCE(((p.e ->> 'predicted_winner_prob'::text))::numeric, GREATEST(((p.e ->> 'adj_home_win'::text))::numeric, ((1)::numeric - ((p.e ->> 'adj_home_win'::text))::numeric))) AS predicted_winner_prob
           FROM (p
             JOIN games gm ON ((gm.game_id = (p.e ->> 'game_id'::text))))
          WHERE (gm.home_score IS NOT NULL)
        )
 SELECT game_date_et,
    slate,
    season,
    week,
    (e ->> 'game_id'::text) AS game_id,
    home_team,
    away_team,
    home_score,
    away_score,
    spread_line,
    predicted_winner,
    predicted_winner_prob,
    rank() OVER (PARTITION BY season, week ORDER BY predicted_winner_prob DESC) AS week_rank,
    (e ->> 'ats_pick'::text) AS ats_pick,
    (e ->> 'rating'::text) AS rating,
    ((e ->> 'bet_score'::text))::integer AS bet_score,
    (e ->> 'risk_rating'::text) AS risk_rating,
    COALESCE(((e ->> 'units'::text))::numeric, (0)::numeric) AS units,
    (e ->> 'consensus_pick'::text) AS consensus_pick,
    ((e ->> 'pbm_agrees_with_experts'::text))::boolean AS agrees,
        CASE
            WHEN ((home_margin)::numeric = spread_line) THEN 'PUSH'::text
            WHEN (((e ->> 'ats_pick'::text) = home_team) = ((home_margin)::numeric > spread_line)) THEN 'WIN'::text
            ELSE 'LOSS'::text
        END AS ats_result,
        CASE
            WHEN (((e ->> 'consensus_pick'::text) IS NULL) OR ((e ->> 'consensus_pick'::text) = 'SPLIT'::text)) THEN NULL::text
            WHEN ((home_margin)::numeric = spread_line) THEN 'PUSH'::text
            WHEN (((e ->> 'consensus_pick'::text) = home_team) = ((home_margin)::numeric > spread_line)) THEN 'WIN'::text
            ELSE 'LOSS'::text
        END AS consensus_result,
        CASE
            WHEN (home_margin = 0) THEN 'PUSH'::text
            WHEN ((predicted_winner = home_team) = (home_margin > 0)) THEN 'WIN'::text
            ELSE 'LOSS'::text
        END AS su_result,
    (e ->> 'kalshi_winner'::text) AS kalshi_winner,
    ((e ->> 'kalshi_winner_prob'::text))::numeric AS kalshi_winner_prob,
        CASE
            WHEN ((e ->> 'kalshi_winner'::text) IS NULL) THEN NULL::text
            WHEN (home_margin = 0) THEN 'PUSH'::text
            WHEN (((e ->> 'kalshi_winner'::text) = home_team) = (home_margin > 0)) THEN 'WIN'::text
            ELSE 'LOSS'::text
        END AS kalshi_su_result,
    (e ->> 'vegas_winner'::text) AS vegas_winner,
        CASE
            WHEN ((e ->> 'vegas_winner'::text) IS NULL) THEN NULL::text
            WHEN (home_margin = 0) THEN 'PUSH'::text
            WHEN (((e ->> 'vegas_winner'::text) = home_team) = (home_margin > 0)) THEN 'WIN'::text
            ELSE 'LOSS'::text
        END AS vegas_su_result
   FROM g;

create or replace view public.shadow_totals_board as
 WITH locked AS (
         SELECT DISTINCT ON (l.game_id) l.id,
            l.game_id,
            l.model_version,
            l.total_line,
            l.pred_total,
            l.over_prob,
            l.pick,
            l.pick_prob,
            l.grade,
            l.updated_at
           FROM (shadow_totals_log l
             JOIN games g USING (game_id))
          WHERE (l.updated_at < g.kickoff_utc)
          ORDER BY l.game_id, l.updated_at DESC
        ), b AS (
         SELECT g.season,
            g.week,
            g.game_id,
            g.kickoff_utc,
            g.away_team,
            g.home_team,
            g.game_date_et,
            COALESCE(k.total_line, t.total_line) AS total_line,
            COALESCE(k.pred_total, t.pred_total) AS pred_total,
            COALESCE(k.over_prob, t.over_prob) AS over_prob,
            COALESCE(k.pick, t.pick) AS pick,
            COALESCE(k.pick_prob, t.pick_prob) AS pick_prob,
            COALESCE(k.grade, t.grade) AS grade,
            g.away_score,
            g.home_score,
            (g.away_score + g.home_score) AS actual_total,
                CASE
                    WHEN ((g.home_score IS NULL) OR (g.away_score IS NULL)) THEN NULL::text
                    WHEN (((g.away_score + g.home_score))::numeric = COALESCE(k.total_line, t.total_line)) THEN 'push'::text
                    WHEN ((((g.away_score + g.home_score))::numeric > COALESCE(k.total_line, t.total_line)) = (COALESCE(k.pick, t.pick) = 'OVER'::text)) THEN 'win'::text
                    ELSE 'loss'::text
                END AS result,
            (k.game_id IS NOT NULL) AS locked,
            ((('KXNFLTOTAL-'::text || upper(to_char((g.game_date_et)::timestamp with time zone, 'YYMonDD'::text))) || pbm_kalshi_team(g.away_team)) || pbm_kalshi_team(g.home_team)) AS ev
           FROM ((games g
             LEFT JOIN locked k USING (game_id))
             LEFT JOIN shadow_totals t ON ((t.game_id = g.game_id)))
          WHERE ((k.game_id IS NOT NULL) OR (t.game_id IS NOT NULL))
        )
 SELECT b.season,
    b.week,
    b.game_id,
    b.kickoff_utc,
    b.away_team,
    b.home_team,
    b.total_line,
    b.pred_total,
    b.over_prob,
    b.pick,
    b.pick_prob,
    b.grade,
    b.away_score,
    b.home_score,
    b.actual_total,
    b.result,
    b.locked,
    kl.ticker AS kalshi_ticker,
    kl.strike AS kalshi_line,
        CASE
            WHEN (b.pick = 'OVER'::text) THEN 'yes'::text
            ELSE 'no'::text
        END AS kalshi_side,
        CASE
            WHEN (b.pick = 'OVER'::text) THEN kl.yes_ask
            ELSE kl.no_ask
        END AS kalshi_price,
        CASE
            WHEN (kl.ticker IS NULL) THEN NULL::text
            ELSE (((('Buy '::text ||
            CASE
                WHEN (b.pick = 'OVER'::text) THEN 'YES'::text
                ELSE 'NO'::text
            END) || ' on "Over '::text) || kl.strike) || ' points"'::text)
        END AS kalshi_how_to,
    ('https://kalshi.com/markets/kxnfltotal/pro-football-total-points/'::text || lower(b.ev)) AS kalshi_url,
        CASE
            WHEN (kl.ticker IS NULL) THEN NULL::numeric
            ELSE round(((1)::numeric / ((1)::numeric + exp((('-1.702'::numeric *
            CASE
                WHEN (b.pick = 'OVER'::text) THEN (b.pred_total - kl.strike)
                ELSE (kl.strike - b.pred_total)
            END) / 13.2)))), 4)
        END AS our_prob_at_kalshi,
    kl.updated_at AS kalshi_updated_at
   FROM (b
     LEFT JOIN LATERAL ( SELECT x.ticker,
            x.event_ticker,
            x.strike,
            x.yes_ask,
            x.no_ask,
            x.yes_bid,
            x.no_bid,
            x.status,
            x.updated_at
           FROM kalshi_total_lines x
          WHERE ((x.event_ticker = b.ev) AND (x.status = ANY (ARRAY['active'::text, 'open'::text])))
          ORDER BY (abs((x.strike - b.total_line))), x.strike
         LIMIT 1) kl ON (true));

create or replace view public.shadow_totals_record as
 SELECT season,
    grp AS grade,
    count(*) FILTER (WHERE (result = 'win'::text)) AS wins,
    count(*) FILTER (WHERE (result = 'loss'::text)) AS losses,
    count(*) FILTER (WHERE (result = 'push'::text)) AS pushes,
    round(((100.0 * (count(*) FILTER (WHERE (result = 'win'::text)))::numeric) / (NULLIF(count(*) FILTER (WHERE (result = ANY (ARRAY['win'::text, 'loss'::text]))), 0))::numeric), 1) AS win_pct,
    round((((count(*) FILTER (WHERE (result = 'win'::text)))::numeric * (100.0 / (110)::numeric)) - (count(*) FILTER (WHERE (result = 'loss'::text)))::numeric), 2) AS units_at_110
   FROM ( SELECT shadow_totals_board.season,
            shadow_totals_board.result,
            shadow_totals_board.grade AS grp
           FROM shadow_totals_board
          WHERE (shadow_totals_board.result IS NOT NULL)
        UNION ALL
         SELECT shadow_totals_board.season,
            shadow_totals_board.result,
            'A+B'::text
           FROM shadow_totals_board
          WHERE ((shadow_totals_board.result IS NOT NULL) AND (shadow_totals_board.grade = ANY (ARRAY['A'::text, 'B'::text])))
        UNION ALL
         SELECT shadow_totals_board.season,
            shadow_totals_board.result,
            'ALL'::text
           FROM shadow_totals_board
          WHERE (shadow_totals_board.result IS NOT NULL)) x
  GROUP BY season, grp;

create or replace view public.sheet_results as
 WITH p AS (
         SELECT s.game_date_et,
            s.slate,
            s.season,
            s.week,
            s.is_final,
            e.value AS e
           FROM (slate_sheets s
             CROSS JOIN LATERAL jsonb_array_elements(s.payload) e(value))
        ), g AS (
         SELECT p.game_date_et,
            p.slate,
            p.season,
            p.week,
            p.is_final,
            p.e,
            gm.home_team,
            gm.away_team,
            gm.home_score,
            gm.away_score,
            (gm.home_score - gm.away_score) AS home_margin,
            ((p.e ->> 'spread_line'::text))::numeric AS spread_line,
            COALESCE((p.e ->> 'predicted_winner'::text),
                CASE
                    WHEN (((p.e ->> 'adj_home_win'::text))::numeric >= 0.5) THEN gm.home_team
                    ELSE gm.away_team
                END) AS predicted_winner,
            COALESCE(((p.e ->> 'predicted_winner_prob'::text))::numeric, GREATEST(((p.e ->> 'adj_home_win'::text))::numeric, ((1)::numeric - ((p.e ->> 'adj_home_win'::text))::numeric))) AS predicted_winner_prob
           FROM (p
             JOIN games gm ON ((gm.game_id = (p.e ->> 'game_id'::text))))
          WHERE (gm.home_score IS NOT NULL)
        )
 SELECT game_date_et,
    slate,
    season,
    week,
    (e ->> 'game_id'::text) AS game_id,
    home_team,
    away_team,
    home_score,
    away_score,
    spread_line,
    predicted_winner,
    predicted_winner_prob,
    rank() OVER (PARTITION BY season, week ORDER BY predicted_winner_prob DESC) AS week_rank,
    (e ->> 'ats_pick'::text) AS ats_pick,
    (e ->> 'rating'::text) AS rating,
    ((e ->> 'bet_score'::text))::integer AS bet_score,
    (e ->> 'risk_rating'::text) AS risk_rating,
    COALESCE(((e ->> 'units'::text))::numeric, (0)::numeric) AS units,
    (e ->> 'consensus_pick'::text) AS consensus_pick,
    ((e ->> 'pbm_agrees_with_experts'::text))::boolean AS agrees,
        CASE
            WHEN ((home_margin)::numeric = spread_line) THEN 'PUSH'::text
            WHEN (((e ->> 'ats_pick'::text) = home_team) = ((home_margin)::numeric > spread_line)) THEN 'WIN'::text
            ELSE 'LOSS'::text
        END AS ats_result,
        CASE
            WHEN (((e ->> 'consensus_pick'::text) IS NULL) OR ((e ->> 'consensus_pick'::text) = 'SPLIT'::text)) THEN NULL::text
            WHEN ((home_margin)::numeric = spread_line) THEN 'PUSH'::text
            WHEN (((e ->> 'consensus_pick'::text) = home_team) = ((home_margin)::numeric > spread_line)) THEN 'WIN'::text
            ELSE 'LOSS'::text
        END AS consensus_result,
        CASE
            WHEN (home_margin = 0) THEN 'PUSH'::text
            WHEN ((predicted_winner = home_team) = (home_margin > 0)) THEN 'WIN'::text
            ELSE 'LOSS'::text
        END AS su_result,
    (e ->> 'kalshi_winner'::text) AS kalshi_winner,
    ((e ->> 'kalshi_winner_prob'::text))::numeric AS kalshi_winner_prob,
        CASE
            WHEN ((e ->> 'kalshi_winner'::text) IS NULL) THEN NULL::text
            WHEN (home_margin = 0) THEN 'PUSH'::text
            WHEN (((e ->> 'kalshi_winner'::text) = home_team) = (home_margin > 0)) THEN 'WIN'::text
            ELSE 'LOSS'::text
        END AS kalshi_su_result,
    (e ->> 'vegas_winner'::text) AS vegas_winner,
        CASE
            WHEN ((e ->> 'vegas_winner'::text) IS NULL) THEN NULL::text
            WHEN (home_margin = 0) THEN 'PUSH'::text
            WHEN (((e ->> 'vegas_winner'::text) = home_team) = (home_margin > 0)) THEN 'WIN'::text
            ELSE 'LOSS'::text
        END AS vegas_su_result
   FROM g;

create or replace view public.team_rankings as
 WITH latest AS (
         SELECT DISTINCT ON (team_ratings.season, team_ratings.team) team_ratings.season,
            team_ratings.team,
            team_ratings.as_of_game,
            team_ratings.off_epa,
            team_ratings.def_epa,
            team_ratings.off_pass_epa,
            team_ratings.def_pass_epa,
            team_ratings.off_rush_epa,
            team_ratings.def_rush_epa
           FROM team_ratings
          ORDER BY team_ratings.season, team_ratings.team, team_ratings.as_of_game DESC
        )
 SELECT season,
    team,
    as_of_game,
    round(off_epa, 3) AS off_epa,
    round(def_epa, 3) AS def_epa,
    rank() OVER (PARTITION BY season ORDER BY latest.off_epa DESC) AS off_rank,
    rank() OVER (PARTITION BY season ORDER BY latest.def_epa) AS def_rank,
    rank() OVER (PARTITION BY season ORDER BY off_pass_epa DESC) AS off_pass_rank,
    rank() OVER (PARTITION BY season ORDER BY off_rush_epa DESC) AS off_rush_rank,
    rank() OVER (PARTITION BY season ORDER BY def_pass_epa) AS def_pass_rank,
    rank() OVER (PARTITION BY season ORDER BY def_rush_epa) AS def_rush_rank
   FROM latest;

create or replace view public.team_records as
 WITH r AS (
         SELECT games.season,
            games.home_team AS team,
                CASE
                    WHEN (games.home_score > games.away_score) THEN 'W'::text
                    WHEN (games.home_score < games.away_score) THEN 'L'::text
                    ELSE 'T'::text
                END AS res
           FROM games
          WHERE ((games.home_score IS NOT NULL) AND (games.away_score IS NOT NULL) AND (COALESCE(games.game_type, 'REG'::text) = 'REG'::text))
        UNION ALL
         SELECT games.season,
            games.away_team,
                CASE
                    WHEN (games.away_score > games.home_score) THEN 'W'::text
                    WHEN (games.away_score < games.home_score) THEN 'L'::text
                    ELSE 'T'::text
                END AS "case"
           FROM games
          WHERE ((games.home_score IS NOT NULL) AND (games.away_score IS NOT NULL) AND (COALESCE(games.game_type, 'REG'::text) = 'REG'::text))
        )
 SELECT season,
    team,
    (count(*) FILTER (WHERE (res = 'W'::text)))::integer AS wins,
    (count(*) FILTER (WHERE (res = 'L'::text)))::integer AS losses,
    (count(*) FILTER (WHERE (res = 'T'::text)))::integer AS ties,
    (((count(*) FILTER (WHERE (res = 'W'::text)) || '-'::text) || count(*) FILTER (WHERE (res = 'L'::text))) ||
        CASE
            WHEN (count(*) FILTER (WHERE (res = 'T'::text)) > 0) THEN ('-'::text || count(*) FILTER (WHERE (res = 'T'::text)))
            ELSE ''::text
        END) AS record
   FROM r
  GROUP BY season, team;

create or replace view public.track_record as
 SELECT g.game_id,
    g.season,
    g.week,
    g.game_date_et,
    g.slate,
    g.home_team,
    g.away_team,
    g.home_score,
    g.away_score,
    g.spread_line,
    l.model_margin,
    l.home_cover_prob,
    l.model_home_prob,
    l.market_home_prob,
        CASE
            WHEN (l.home_cover_prob >= 0.5) THEN g.home_team
            ELSE g.away_team
        END AS ats_pick,
        CASE
            WHEN (((g.home_score - g.away_score))::numeric = g.spread_line) THEN 'PUSH'::text
            WHEN ((l.home_cover_prob >= 0.5) = (((g.home_score - g.away_score))::numeric > g.spread_line)) THEN 'WIN'::text
            ELSE 'LOSS'::text
        END AS ats_result,
        CASE
            WHEN ((l.model_home_prob >= 0.5) = (g.home_score > g.away_score)) THEN 'WIN'::text
            ELSE 'LOSS'::text
        END AS su_result
   FROM (games g
     JOIN LATERAL ( SELECT pl.id,
            pl.game_id,
            pl.model_version,
            pl.model_home_prob,
            pl.blend_home_prob,
            pl.market_home_prob,
            pl.model_margin,
            pl.home_cover_prob,
            pl.updated_at
           FROM predictions_log pl
          WHERE ((pl.game_id = g.game_id) AND (pl.updated_at < g.kickoff_utc))
          ORDER BY pl.updated_at DESC
         LIMIT 1) l ON (true))
  WHERE (g.home_score IS NOT NULL);

create or replace view public.week_status as
 SELECT season,
    week,
    count(*) AS games,
    count(*) FILTER (WHERE (home_score IS NOT NULL)) AS games_final,
    min(kickoff_utc) AS first_kickoff,
    max(kickoff_utc) AS last_kickoff,
    (count(*) = count(*) FILTER (WHERE (home_score IS NOT NULL))) AS week_complete
   FROM games
  GROUP BY season, week;

create or replace view public.weekly_scorecard as
 WITH wk AS (
         SELECT games.season,
            games.week,
            count(*) AS games_scheduled,
            count(*) FILTER (WHERE (games.home_score IS NOT NULL)) AS games_final
           FROM games
          WHERE ((games.game_type = 'REG'::text) OR (games.game_type IS NOT NULL))
          GROUP BY games.season, games.week
        ), r AS (
         SELECT sheet_results.game_date_et,
            sheet_results.slate,
            sheet_results.season,
            sheet_results.week,
            sheet_results.game_id,
            sheet_results.home_team,
            sheet_results.away_team,
            sheet_results.home_score,
            sheet_results.away_score,
            sheet_results.spread_line,
            sheet_results.predicted_winner,
            sheet_results.predicted_winner_prob,
            sheet_results.week_rank,
            sheet_results.ats_pick,
            sheet_results.rating,
            sheet_results.bet_score,
            sheet_results.risk_rating,
            sheet_results.units,
            sheet_results.consensus_pick,
            sheet_results.agrees,
            sheet_results.ats_result,
            sheet_results.consensus_result,
            sheet_results.su_result,
            sheet_results.kalshi_winner,
            sheet_results.kalshi_winner_prob,
            sheet_results.kalshi_su_result,
            sheet_results.vegas_winner,
            sheet_results.vegas_su_result
           FROM sheet_results
        )
 SELECT r.season,
    r.week,
    wk.games_scheduled,
    wk.games_final,
    (wk.games_final = wk.games_scheduled) AS week_complete,
    count(*) AS games_graded,
    count(*) FILTER (WHERE (r.su_result = 'WIN'::text)) AS su_wins,
    count(*) FILTER (WHERE (r.su_result = 'LOSS'::text)) AS su_losses,
    round(((count(*) FILTER (WHERE (r.su_result = 'WIN'::text)))::numeric / (NULLIF(count(*) FILTER (WHERE (r.su_result = ANY (ARRAY['WIN'::text, 'LOSS'::text]))), 0))::numeric), 4) AS su_win_pct,
    count(*) FILTER (WHERE ((r.week_rank <= 5) AND (r.su_result = 'WIN'::text))) AS top5_su_wins,
    count(*) FILTER (WHERE ((r.week_rank <= 5) AND (r.su_result = 'LOSS'::text))) AS top5_su_losses,
    count(*) FILTER (WHERE ((r.week_rank <= 10) AND (r.su_result = 'WIN'::text))) AS top10_su_wins,
    count(*) FILTER (WHERE ((r.week_rank <= 10) AND (r.su_result = 'LOSS'::text))) AS top10_su_losses,
    count(*) FILTER (WHERE (r.ats_result = 'WIN'::text)) AS ats_wins,
    count(*) FILTER (WHERE (r.ats_result = 'LOSS'::text)) AS ats_losses,
    count(*) FILTER (WHERE (r.ats_result = 'PUSH'::text)) AS ats_pushes,
    round(((count(*) FILTER (WHERE (r.ats_result = 'WIN'::text)))::numeric / (NULLIF(count(*) FILTER (WHERE (r.ats_result = ANY (ARRAY['WIN'::text, 'LOSS'::text]))), 0))::numeric), 4) AS ats_win_pct,
    count(*) FILTER (WHERE ((r.units > (0)::numeric) AND (r.ats_result = 'WIN'::text))) AS bet_wins,
    count(*) FILTER (WHERE ((r.units > (0)::numeric) AND (r.ats_result = 'LOSS'::text))) AS bet_losses,
    round(sum(
        CASE
            WHEN ((r.units > (0)::numeric) AND (r.ats_result = 'WIN'::text)) THEN ((r.units * (100)::numeric) / 110.0)
            WHEN ((r.units > (0)::numeric) AND (r.ats_result = 'LOSS'::text)) THEN (- r.units)
            ELSE (0)::numeric
        END), 2) AS units_net,
    count(*) FILTER (WHERE ((r.rating = ANY (ARRAY['A+'::text, 'A'::text])) AND (r.ats_result = 'WIN'::text))) AS a_wins,
    count(*) FILTER (WHERE ((r.rating = ANY (ARRAY['A+'::text, 'A'::text])) AND (r.ats_result = 'LOSS'::text))) AS a_losses,
    count(*) FILTER (WHERE (r.consensus_result = 'WIN'::text)) AS consensus_wins,
    count(*) FILTER (WHERE (r.consensus_result = 'LOSS'::text)) AS consensus_losses,
    count(*) FILTER (WHERE (r.kalshi_su_result = 'WIN'::text)) AS kalshi_su_wins,
    count(*) FILTER (WHERE (r.kalshi_su_result = 'LOSS'::text)) AS kalshi_su_losses,
    count(*) FILTER (WHERE (r.vegas_su_result = 'WIN'::text)) AS vegas_su_wins,
    count(*) FILTER (WHERE (r.vegas_su_result = 'LOSS'::text)) AS vegas_su_losses,
    jsonb_agg(jsonb_build_object('rank', r.week_rank, 'game_id', r.game_id, 'matchup', ((r.away_team || ' @ '::text) || r.home_team), 'score', ((r.away_score || '-'::text) || r.home_score), 'predicted_winner', r.predicted_winner, 'prob', r.predicted_winner_prob, 'su', r.su_result, 'ats_pick', r.ats_pick, 'spread_line', r.spread_line, 'ats', r.ats_result, 'rating', r.rating, 'bet_score', r.bet_score, 'units', r.units, 'kalshi_winner', r.kalshi_winner, 'kalshi_su', r.kalshi_su_result, 'vegas_winner', r.vegas_winner, 'vegas_su', r.vegas_su_result) ORDER BY r.week_rank) AS games
   FROM (r
     JOIN wk USING (season, week))
  GROUP BY r.season, r.week, wk.games_scheduled, wk.games_final;

create or replace view public.weighted_consensus as
 WITH p AS (
         SELECT ep.game_id,
            ep.market,
            ep.pick_side,
            e.tier,
                CASE
                    WHEN (ep.market = 'spread'::text) THEN w.ats_weight
                    ELSE w.su_weight
                END AS wt
           FROM ((expert_picks ep
             JOIN experts e ON (((e.id = ep.expert_id) AND e.active)))
             JOIN expert_weights w ON ((w.expert_id = e.id)))
          WHERE (ep.market = ANY (ARRAY['spread'::text, 'moneyline'::text]))
        ), a AS (
         SELECT p.game_id,
            p.market,
            count(*) AS n,
            count(*) FILTER (WHERE (p.tier = 'panel'::text)) AS n_panel,
            count(*) FILTER (WHERE (p.tier <> 'panel'::text)) AS n_core,
            sum(p.wt) FILTER (WHERE (p.pick_side = 'home'::text)) AS w_home,
            sum(p.wt) FILTER (WHERE (p.pick_side = 'away'::text)) AS w_away
           FROM p
          GROUP BY p.game_id, p.market
        )
 SELECT g.game_id,
    g.season,
    g.week,
    g.home_team,
    g.away_team,
    s.n AS ats_experts,
    s.n_panel AS ats_panel,
    s.n_core AS ats_core,
        CASE
            WHEN (s.n IS NULL) THEN NULL::text
            WHEN (COALESCE(s.w_home, (0)::numeric) > COALESCE(s.w_away, (0)::numeric)) THEN g.home_team
            WHEN (COALESCE(s.w_away, (0)::numeric) > COALESCE(s.w_home, (0)::numeric)) THEN g.away_team
            ELSE 'SPLIT'::text
        END AS weighted_ats_pick,
    round((GREATEST(COALESCE(s.w_home, (0)::numeric), COALESCE(s.w_away, (0)::numeric)) / NULLIF((COALESCE(s.w_home, (0)::numeric) + COALESCE(s.w_away, (0)::numeric)), (0)::numeric)), 3) AS weighted_ats_pct,
    m.n AS su_experts,
        CASE
            WHEN (m.n IS NULL) THEN NULL::text
            WHEN (COALESCE(m.w_home, (0)::numeric) > COALESCE(m.w_away, (0)::numeric)) THEN g.home_team
            WHEN (COALESCE(m.w_away, (0)::numeric) > COALESCE(m.w_home, (0)::numeric)) THEN g.away_team
            ELSE 'SPLIT'::text
        END AS weighted_su_pick,
    round((GREATEST(COALESCE(m.w_home, (0)::numeric), COALESCE(m.w_away, (0)::numeric)) / NULLIF((COALESCE(m.w_home, (0)::numeric) + COALESCE(m.w_away, (0)::numeric)), (0)::numeric)), 3) AS weighted_su_pct
   FROM ((games g
     LEFT JOIN a s ON (((s.game_id = g.game_id) AND (s.market = 'spread'::text))))
     LEFT JOIN a m ON (((m.game_id = g.game_id) AND (m.market = 'moneyline'::text))));

create or replace view public.zplus_board as
 WITH s AS (
         SELECT g.game_id,
            g.season,
            g.week,
            g.kickoff_utc,
            g.home_team,
            g.away_team,
            COALESCE(gb.adj_home_win, gb.blend_home_prob) AS mh,
            COALESCE(((gb.scanned_at >= (g.kickoff_utc - '01:30:00'::interval)) AND (gb.adj_home_win IS NOT NULL)), false) AS news_ready,
            k.home_yes_ask AS ha,
            k.away_yes_ask AS aa,
            k.home_ticker,
            k.away_ticker,
            k.fetched_at
           FROM ((games g
             JOIN game_board gb USING (game_id))
             JOIN kalshi_markets k USING (game_id))
          WHERE ((g.home_score IS NULL) AND (COALESCE(gb.adj_home_win, gb.blend_home_prob) IS NOT NULL))
        )
 SELECT game_id,
    season,
    week,
    kickoff_utc,
    home_team,
    away_team,
    team,
    opp,
    ticker,
    'yes'::text AS side,
    round(model_prob, 4) AS model_prob,
    ask,
    round((model_prob - ask), 4) AS gap,
    fetched_at,
    (kickoff_utc > now()) AS open,
    (((
        CASE
            WHEN ((model_prob - ask) >= 0.10) THEN 'Z+'::text
            ELSE 'Z'::text
        END || ' VALUE DOG: '::text) || team) || ' to win'::text) AS pick_label,
        CASE
            WHEN ((model_prob - ask) >= 0.10) THEN 'Z+'::text
            ELSE 'Z'::text
        END AS tier,
    news_ready
   FROM ( SELECT s.game_id,
            s.season,
            s.week,
            s.kickoff_utc,
            s.home_team,
            s.away_team,
            s.mh,
            s.news_ready,
            s.ha,
            s.aa,
            s.home_ticker,
            s.away_ticker,
            s.fetched_at,
            s.home_team AS team,
            s.away_team AS opp,
            s.home_ticker AS ticker,
            s.mh AS model_prob,
            s.ha AS ask
           FROM s
        UNION ALL
         SELECT s.game_id,
            s.season,
            s.week,
            s.kickoff_utc,
            s.home_team,
            s.away_team,
            s.mh,
            s.news_ready,
            s.ha,
            s.aa,
            s.home_ticker,
            s.away_ticker,
            s.fetched_at,
            s.away_team,
            s.home_team,
            s.away_ticker,
            ((1)::numeric - s.mh),
            s.aa
           FROM s) x
  WHERE ((ask > 0.05) AND (ask < 0.50) AND ((model_prob - ask) >= 0.05));
