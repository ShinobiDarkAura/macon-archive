-- Let the two keepers read the private font bucket from the browser.
--
-- This is what allows the sheet to be drawn client-side again, instantly,
-- without the typefaces ever sitting in the public repo: only a signed-in
-- keeper can fetch them, and an anonymous visitor to the Pages site cannot.

drop policy if exists "keepers read fonts" on storage.objects;
create policy "keepers read fonts" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'fonts'
    and auth.jwt() ->> 'email' in ('alex@studiomacon.co','hannah@studiomacon.co')
  );
