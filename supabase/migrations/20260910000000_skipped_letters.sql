-- Letters put aside, shared between the two of us.
--
-- "Skip for now" used to write to localStorage, which meant Alex's skipped
-- letters were invisible to Hannah and each browser kept its own idea of what
-- was still waiting. The key is the same one the queue builds ("q:<uuid>" for
-- an enquiry, "d:<email|acc|name>" for a collector) so nothing else has to
-- change to look one up.

create table if not exists public.skipped_letters (
  key        text primary key,
  name       text,                                     -- who it was to, for the list
  subject    text,                                     -- what it was about
  skipped_by text,
  skipped_at timestamptz not null default now()
);

create index if not exists skipped_letters_at_idx on public.skipped_letters(skipped_at desc);

alter table public.skipped_letters enable row level security;
drop policy if exists "keepers only" on public.skipped_letters;
create policy "keepers only" on public.skipped_letters
  for all to authenticated
  using      ( auth.jwt() ->> 'email' in ('alex@studiomacon.co','hannah@studiomacon.co') )
  with check ( auth.jwt() ->> 'email' in ('alex@studiomacon.co','hannah@studiomacon.co') );

do $$
begin
  alter publication supabase_realtime add table public.skipped_letters;
exception when duplicate_object then null;
end $$;
