-- Why a letter we started ourselves should ever come back.
--
-- A composed letter used to be saved as an open enquiry, and nothing marked it
-- sent, so the moment it went out it was back in the queue with no reason
-- attached. Now its intent is read once, at send: what it asked of them, and
-- whether and when it is worth checking in. No follow_up_on means it never
-- returns on its own.

alter table public.inquiries add column if not exists intent text;
alter table public.inquiries add column if not exists follow_up_on date;
