-- A private bucket for the licensed typefaces.
--
-- The invoice PDF is generated in an edge function so the font software is
-- never publicly downloadable. Fontgrube's licence permits web font formats
-- for on-screen display but forbids offering the font itself for download;
-- TAY and LOMA carry no licence terms at all, so nothing may be assumed.
-- Only the service role reads this bucket.

insert into storage.buckets (id, name, public)
values ('fonts', 'fonts', false)
on conflict (id) do update set public = false;
