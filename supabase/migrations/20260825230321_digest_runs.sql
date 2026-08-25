-- Coordination between the two digest delivery paths.
--
-- The primary path is a Claude scheduled task sending directly via Gmail as
-- hello@studiomacon.co, Monday mornings. It only fires while the Claude Code
-- app is open at trigger time; if it's closed, the task runs on next launch
-- instead of on schedule. This table lets a same-day Resend fallback (via
-- pg_cron, several hours later) tell whether the primary already ran, so a
-- normal week sends exactly one email rather than two.
create table if not exists public.digest_runs (
  week_start date primary key,      -- the Monday of the ISO week
  sent_via   text not null check (sent_via in ('gmail','resend-fallback')),
  sent_at    timestamptz default now()
);
alter table public.digest_runs enable row level security;
-- No policies granted: only the edge function's service-role key can touch
-- this table, so there is nothing for a client key to read or write.
