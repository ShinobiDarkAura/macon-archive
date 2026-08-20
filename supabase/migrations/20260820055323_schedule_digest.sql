-- Weekly follow-up digest, Mondays at 9am Pacific.
--
-- pg_cron runs in UTC, so 16:00 UTC is 9am PDT and 8am PST. Living with the
-- winter hour beats the digest arriving at 2am, which is what the README's
-- 0 9 * * 1 would have done.

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule('macon-followup-digest')
 where exists (select 1 from cron.job where jobname = 'macon-followup-digest');

select cron.schedule(
  'macon-followup-digest',
  '0 16 * * 1',
  $$
  select net.http_post(
    url     := 'https://berdrzxjoejirbhdgjer.supabase.co/functions/v1/followup-digest',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer sb_publishable_0RTjUZYfWWSBrd5WF0Mj6A_p4wlaQR_'
    )
  );
  $$
);
