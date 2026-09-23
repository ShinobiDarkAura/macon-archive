-- Two more things Shopify tells the archive.
--   checkouts:    someone reached checkout and gave their email. Paid or not, it
--                 shows who nearly bought, and which piece. A known collector
--                 hesitating is worth a personal note; Shopify's own email only
--                 ever sends the generic one.
--   last_shipped: the day a collector's latest order left the studio. The story
--                 ask now counts from here, so it arrives after the piece does.

create table if not exists public.checkouts (
  token         text primary key,            -- Shopify's checkout token
  email         text,
  name          text,
  acc           text,                         -- the collector, when we know them
  pieces        text,
  total         numeric,
  recovery_url  text,                         -- the link back into that checkout
  started_at    timestamptz,
  updated_at    timestamptz default now(),
  completed_at  timestamptz                   -- set when it became an order
);
create index if not exists checkouts_email_idx on public.checkouts (email);
create index if not exists checkouts_open_idx on public.checkouts (started_at) where completed_at is null;

alter table public.checkouts enable row level security;
drop policy if exists "keepers only" on public.checkouts;
create policy "keepers only" on public.checkouts
  for all to authenticated
  using      ( auth.jwt() ->> 'email' in ('alex@studiomacon.co','hannah@studiomacon.co') )
  with check ( auth.jwt() ->> 'email' in ('alex@studiomacon.co','hannah@studiomacon.co') );

alter table public.collectors add column if not exists last_shipped text;
alter table public.processed_orders add column if not exists shipped_at timestamptz;
