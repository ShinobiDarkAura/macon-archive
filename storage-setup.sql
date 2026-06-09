-- Maçon Archive — Story Photos setup
-- Run once in Supabase → SQL Editor → New query → Run.
-- (Edit the two emails if yours differ.)

-- 1. Column to store each collector's photo list (JSON array of file paths)
alter table public.collectors add column if not exists photos text;

-- 2. Public storage bucket for the photos (public = stable URLs you can reuse socially)
insert into storage.buckets (id, name, public)
values ('collector-photos', 'collector-photos', true)
on conflict (id) do update set public = true;

-- 3. Access rules: anyone can VIEW the photos; only the two keepers can upload/replace/delete.
drop policy if exists "photos read"   on storage.objects;
drop policy if exists "photos write"  on storage.objects;
drop policy if exists "photos update" on storage.objects;
drop policy if exists "photos delete" on storage.objects;

create policy "photos read" on storage.objects
  for select
  using ( bucket_id = 'collector-photos' );

create policy "photos write" on storage.objects
  for insert to authenticated
  with check ( bucket_id = 'collector-photos'
               and auth.jwt() ->> 'email' in ('alex@studiomacon.co','hannah@studiomacon.co') );

create policy "photos update" on storage.objects
  for update to authenticated
  using ( bucket_id = 'collector-photos'
          and auth.jwt() ->> 'email' in ('alex@studiomacon.co','hannah@studiomacon.co') );

create policy "photos delete" on storage.objects
  for delete to authenticated
  using ( bucket_id = 'collector-photos'
          and auth.jwt() ->> 'email' in ('alex@studiomacon.co','hannah@studiomacon.co') );
