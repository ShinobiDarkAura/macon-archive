-- Jason and Matt were both replied to on 28 July, by email, so neither was ever
-- ticked in the app and last_touched stayed null. The digest read that as
-- "nobody has answered" and drafted Jason a first reply, which would have been
-- the third time we introduced ourselves.
update public.inquiries
   set last_touched = date '2026-07-28', status = 'followed'
 where email = 'jason@hey.com' and last_touched is null;

-- Not a person, so nothing should greet it by name
update public.inquiries
   set name = 'Bronze cutlery enquiry'
 where email = 'keawes24@gmail.com';
