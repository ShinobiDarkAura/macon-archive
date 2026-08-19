-- Custom enquiries as records rather than tasks.
--
-- They used to be a hardcoded array in index.html, and "done" was a row in
-- bureau_todos that hid them for good. Following someone up therefore erased
-- them. Now the record carries a status and nothing can remove it: the drawer
-- decides what needs attention from status plus time, and never stores it.

create table if not exists public.inquiries (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  email        text,
  subject      text,                                   -- what they asked for
  source       text,                                   -- where it came from
  note         text,
  status       text not null default 'open'
                 check (status in ('open','followed','closed')),
  outcome      text,                                   -- why it closed, when it did
  repeat_buyer boolean default false,
  first_seen   date not null default current_date,
  last_touched date,
  created_at   timestamptz default now(),
  updated_at   timestamptz default now()
);

create index if not exists inquiries_status_idx on public.inquiries(status, first_seen desc);

drop trigger if exists inquiries_touch on public.inquiries;
create trigger inquiries_touch before update on public.inquiries
  for each row execute function public.touch_updated_at();

alter table public.inquiries enable row level security;
drop policy if exists "keepers only" on public.inquiries;
create policy "keepers only" on public.inquiries
  for all to authenticated
  using      ( auth.jwt() ->> 'email' in ('alex@studiomacon.co','hannah@studiomacon.co') )
  with check ( auth.jwt() ->> 'email' in ('alex@studiomacon.co','hannah@studiomacon.co') );

do $$
begin
  alter publication supabase_realtime add table public.inquiries;
exception when duplicate_object then null;
end $$;

-- the two that were living in the source
insert into public.inquiries (name, email, subject, source, note, repeat_buyer, first_seen)
select 'Matt McClure', 'homegnome@gmail.com', 'armoured bear', 'custom-orders post',
       'Wrote in off the custom-orders post. Replied same day with the six-step process, $925, and an offer of a pay link. Nothing since.',
       false, date '2026-07-28'
where not exists (select 1 from public.inquiries where name = 'Matt McClure');

insert into public.inquiries (name, email, subject, source, note, repeat_buyer, first_seen)
select 'Jason Fried', null, 'snail', 'direct',
       'Already a collector, asked for a snail unprompted. The reply opened with the price change and a deposit link. Nothing since.',
       true, date '2026-07-28'
where not exists (select 1 from public.inquiries where name = 'Jason Fried');
