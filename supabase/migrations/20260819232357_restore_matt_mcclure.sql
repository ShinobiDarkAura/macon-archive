-- Bring Matt McClure back into the follow-up drawer.
--
-- Ticking an inquiry wrote a bureau_todos row, and inqOpen() treated the
-- presence of that row as "never show this again". Following someone up
-- therefore erased them. Removing the row restores him; the structural fix is
-- a status on the record itself, so nothing can be lost this way again.

delete from public.bureau_todos where id like 'inq|%';
