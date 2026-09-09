-- Refresh tokens for the studio mailboxes the Letters view reads.
--
-- One row per mailbox, written only by the gmail-reader function using the
-- service role. RLS is enabled with no policies at all, so no browser session
-- can read these rows however it authenticates: the service role bypasses RLS,
-- everyone else sees nothing.
create table if not exists public.gmail_accounts (
  mailbox       text primary key,
  refresh_token text not null,
  connected_by  text,
  connected_at  timestamptz not null default now()
);

alter table public.gmail_accounts enable row level security;

comment on table public.gmail_accounts is
  'Google OAuth refresh tokens per studio mailbox. Service role only, never exposed to the browser.';
