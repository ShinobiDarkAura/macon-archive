-- Maçon Archive — Studio Line (keeper-to-keeper chat)
-- Run once in Supabase → SQL Editor → New query → Run.

create table if not exists public.messages (
  id         uuid primary key default gen_random_uuid(),
  sender     text not null default (auth.jwt() ->> 'email'),
  body       text not null,
  created_at timestamptz not null default now(),
  read_at    timestamptz
);

create index if not exists messages_created_idx on public.messages (created_at);

-- Same keepers-only lock as the rest of the archive.
alter table public.messages enable row level security;
drop policy if exists "keepers only messages" on public.messages;
create policy "keepers only messages" on public.messages
  for all
  to authenticated
  using      ( auth.jwt() ->> 'email' in ('alex@studiomacon.co','hannah@studiomacon.co') )
  with check ( auth.jwt() ->> 'email' in ('alex@studiomacon.co','hannah@studiomacon.co') );

-- Realtime so each keeper sees the other's messages + read receipts live.
alter publication supabase_realtime add table public.messages;
-- Read receipts (read_at UPDATE) need full row data on the wire:
alter table public.messages replica identity full;
