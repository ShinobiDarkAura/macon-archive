-- Digests are stopped. The Gmail-direct Claude task is paused, and this removes
-- the Resend fallback so nothing sends on Mondays. The Edge Function still
-- renders the digest on request (?preview=1).
select cron.unschedule('macon-digest-resend-fallback')
 where exists (select 1 from cron.job where jobname = 'macon-digest-resend-fallback');
