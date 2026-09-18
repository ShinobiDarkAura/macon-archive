-- Maçon Archive — an email address is stored one way, lowercase and trimmed,
-- so every lookup can be an exact match. Before this, a lookup had to be a
-- case-insensitive pattern, in which "_" in an address matched any character.
create or replace function public.lowercase_emails() returns trigger
language plpgsql as $$
begin
  if new.email is not null then new.email := nullif(lower(trim(new.email)), ''); end if;
  if tg_table_name = 'collectors' and new.alt_emails is not null then
    new.alt_emails := array(select distinct lower(trim(x)) from unnest(new.alt_emails) x where trim(x) <> '');
  end if;
  return new;
end $$;

drop trigger if exists collectors_lowercase_emails on public.collectors;
create trigger collectors_lowercase_emails before insert or update on public.collectors
  for each row execute function public.lowercase_emails();
drop trigger if exists inquiries_lowercase_emails on public.inquiries;
create trigger inquiries_lowercase_emails before insert or update on public.inquiries
  for each row execute function public.lowercase_emails();
