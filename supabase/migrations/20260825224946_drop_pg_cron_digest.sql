-- The digest is no longer sent from here. Delivery moved to a Claude scheduled
-- task that sends directly via Gmail as hello@studiomacon.co, rather than
-- through Resend's test sender, which only ever delivered to the account
-- owner. This function now only renders the week's HTML on request.
select cron.unschedule('macon-followup-digest')
 where exists (select 1 from cron.job where jobname = 'macon-followup-digest');
