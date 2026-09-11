-- What has gone out each day, shared between the two of us.
--
-- The day's progress (the dots above the pile, the docket, "Done today" in the
-- post box) was kept in each browser, so Alex and Hannah each saw only their own
-- sends. One row per letter per day, keyed the way the queue keys a letter.

create table if not exists public.letters_done (
  key     text not null,
  day     date not null,
  name    text,
  kind    text,
  done_by text,
  done_at timestamptz not null default now(),
  primary key (key, day)
);

create index if not exists letters_done_day_idx on public.letters_done(day);

alter table public.letters_done enable row level security;
drop policy if exists "keepers only" on public.letters_done;
create policy "keepers only" on public.letters_done
  for all to authenticated
  using      ( auth.jwt() ->> 'email' in ('alex@studiomacon.co','hannah@studiomacon.co') )
  with check ( auth.jwt() ->> 'email' in ('alex@studiomacon.co','hannah@studiomacon.co') );

do $$
begin
  alter publication supabase_realtime add table public.letters_done;
exception when duplicate_object then null;
end $$;
