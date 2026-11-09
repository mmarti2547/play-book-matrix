-- Spread cover chance now counts only a share (model_params.ats_shrink, default 0.25) of the gap between our margin and the spread.
-- Previous definition saved in public.view_backups (name='game_board', saved 2026-11-09).
create table if not exists public.view_backups (name text, saved_at timestamptz default now(), definition text);
alter table public.view_backups enable row level security;
insert into public.view_backups(name, definition) values ('game_board', pg_get_viewdef('public.game_board'::regclass, true));
insert into model_params(key, value, default_value, min_value, max_value, max_step, min_games, label, description)
values ('ats_shrink', 0.25, 0.25, 0, 1, 0.1, 100, 'Trust in our margin vs. the Vegas spread (spread picks)',
 'Share of the gap between our predicted margin and the spread that counts toward the cover chance.')
on conflict (key) do nothing;
do $$ declare d text := pg_get_viewdef('public.game_board'::regclass, true); o text;
begin
  o := d;
  d := replace(d, 'pbm_phi((b.model_margin + b.news_pts - b.spread_line) / 13.45) AS adj_home_cover',
    'pbm_phi(COALESCE((SELECT mp.value::numeric FROM model_params mp WHERE mp.key = ''ats_shrink''), 0.25) * (b.model_margin + b.news_pts - b.spread_line) / 13.45) AS adj_home_cover');
  if d = o then raise exception 'pattern not found'; end if;
  execute 'create or replace view public.game_board as ' || d;
end $$;
