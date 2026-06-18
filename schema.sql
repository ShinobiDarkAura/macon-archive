-- Maçon Collector Archive — Supabase schema
-- Run this once in Supabase → SQL Editor → New query → Run.
--
-- BEFORE RUNNING: replace the two emails below with your real addresses.
-- Only these emails will ever be able to sign in and read/write the archive.

create table if not exists public.collectors (
  id            uuid primary key default gen_random_uuid(),
  acc           text unique,
  name          text,
  email         text,
  first_contact text,
  pieces        text,
  ltv           numeric,
  location      text,
  phone         text,
  gift_self     text,
  first_buy     text,
  last_buy      text,
  why           text,
  lives         text,
  details       text,
  signal        text,
  first_look    boolean default false,
  last_contact  text,
  story         text,
  notes         text,
  photos        text,
  updated_at    timestamptz default now()
);

-- Keep updated_at fresh on every write
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;

drop trigger if exists collectors_touch on public.collectors;
create trigger collectors_touch before update on public.collectors
  for each row execute function public.touch_updated_at();

-- Lock the table down: only the two keepers may read or write.
alter table public.collectors enable row level security;

drop policy if exists "keepers only" on public.collectors;
create policy "keepers only" on public.collectors
  for all
  to authenticated
  using      ( auth.jwt() ->> 'email' in ('alex@studiomacon.co','hannah@studiomacon.co') )
  with check ( auth.jwt() ->> 'email' in ('alex@studiomacon.co','hannah@studiomacon.co') );

-- Let the app receive realtime change events
alter publication supabase_realtime add table public.collectors;

-- Bureau to-dos: shared completion state for the daily brief
-- (letters + follow-ups stay on everyone's list until checked off by either keeper)
create table if not exists public.bureau_todos (
  id       text primary key,
  done_at  text,
  done_by  text default (auth.jwt() ->> 'email')
);
alter table public.bureau_todos enable row level security;
drop policy if exists "keepers only todos" on public.bureau_todos;
create policy "keepers only todos" on public.bureau_todos
  for all
  to authenticated
  using      ( auth.jwt() ->> 'email' in ('alex@studiomacon.co','hannah@studiomacon.co') )
  with check ( auth.jwt() ->> 'email' in ('alex@studiomacon.co','hannah@studiomacon.co') );
alter publication supabase_realtime add table public.bureau_todos;

-- Instagram handle for collector cultivation (added later)
alter table public.collectors add column if not exists instagram text;
