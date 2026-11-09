-- Adds scope 'v2' (since 2026-11-09, honest-chance system) and 'before_v2' to jamie_scorecard and jamie_parlay_scorecard.
do $$ declare d text; o text;
begin
  d := pg_get_viewdef('public.jamie_scorecard'::regclass, true); o := d;
  d := replace(d, E'        )\n SELECT scope,', E'        UNION ALL\n         SELECT ''v2''::text, r.grade, r.result, r.price, r.our_prob FROM r WHERE ((r.logged_at AT TIME ZONE ''America/New_York''::text))::date >= ''2026-11-09''::date\n        UNION ALL\n         SELECT ''before_v2''::text, r.grade, r.result, r.price, r.our_prob FROM r WHERE ((r.logged_at AT TIME ZONE ''America/New_York''::text))::date < ''2026-11-09''::date\n        )\n SELECT scope,');
  if d = o then raise exception 'leg view pattern not found'; end if;
  execute 'create or replace view public.jamie_scorecard as ' || d;
  d := pg_get_viewdef('public.jamie_parlay_scorecard'::regclass, true); o := d;
  d := replace(d, E'        )\n SELECT scope,', E'        UNION ALL\n         SELECT ''v2''::text, r.* FROM r WHERE ((r.logged_at AT TIME ZONE ''America/New_York''::text))::date >= ''2026-11-09''::date\n        UNION ALL\n         SELECT ''before_v2''::text, r.* FROM r WHERE ((r.logged_at AT TIME ZONE ''America/New_York''::text))::date < ''2026-11-09''::date\n        )\n SELECT scope,');
  if d = o then raise exception 'parlay view pattern not found'; end if;
  execute 'create or replace view public.jamie_parlay_scorecard as ' || d;
end $$;
