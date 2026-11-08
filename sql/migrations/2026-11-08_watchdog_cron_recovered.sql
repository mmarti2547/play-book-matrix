-- Watchdog: a failed cron run no longer counts once the same job has succeeded after it.
do $$ declare d text := pg_get_functiondef('public.pbm_watchdog_health()'::regprocedure); o text;
begin
  o := d;
  d := replace(d, $x$where d.status = 'failed' and d.start_time > now() - interval '2 hours' group by j.jobname;$x$,
    $x$where d.status = 'failed' and d.start_time > now() - interval '2 hours'
      and not exists (select 1 from cron.job_run_details s where s.jobid = d.jobid and s.status = 'succeeded' and s.start_time > d.start_time)
    group by j.jobname;$x$);
  if d = o then raise exception 'pattern not found'; end if;
  execute d;
end $$;
