-- Maçon Archive — one collector, however many addresses they buy from.
--
-- The order webhook knew a person only by email, so an order from a second
-- address made a second collector (Josh King and Joshua King, M-009 and M-097).
-- A collector can now carry the other addresses they use, and a record folded
-- into another keeps a pointer to it rather than being deleted, so a merge can
-- always be undone. The street address and postcode of each order are kept too:
-- with the surname they are what tells two addresses belong to one person.

alter table public.collectors add column if not exists alt_emails  text[] not null default '{}';
alter table public.collectors add column if not exists merged_into text;
alter table public.collectors add column if not exists address     text;
alter table public.collectors add column if not exists postcode    text;

create index if not exists collectors_alt_emails_idx on public.collectors using gin (alt_emails);
