-- Resend fallback, several hours after the Gmail-direct task's Monday morning
-- slot. 21:00 UTC is 2pm Pacific in summer (PDT) and 1pm in winter (PST) —
-- either way, comfortably late enough that if the primary was going to run
-- that morning, it already has. It is a genuine backup: send_if_missing
-- checks digest_runs first and does nothing if the week is already covered.
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule('macon-followup-digest')
 where exists (select 1 from cron.job where jobname = 'macon-followup-digest');

select cron.schedule(
  'macon-digest-resend-fallback',
  '0 21 * * 1',
  $$
  select net.http_post(
    url     := 'https://berdrzxjoejirbhdgjer.supabase.co/functions/v1/followup-digest?action=send_if_missing',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer sb_publishable_0RTjUZYfWWSBrd5WF0Mj6A_p4wlaQR_',
      'apikey', 'sb_publishable_0RTjUZYfWWSBrd5WF0Mj6A_p4wlaQR_'
    )
  );
  $$
);
