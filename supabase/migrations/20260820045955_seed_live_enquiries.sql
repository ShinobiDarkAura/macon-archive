-- The open custom enquiries, taken from hello@studiomacon.co rather than
-- retyped from memory. Statuses reflect what actually happened in the thread.

insert into public.inquiries (name, email, subject, source, note, status, first_seen, last_touched)
select * from (values

  -- Replied 14 Aug asking whether they meant the set from the site or a new
  -- commission. Nothing back since.
  ('Chess enquiry', 'mrkdg2006@gmail.com', 'chess set', 'website',
   'Asked about a chess set. Hannah replied 14 Aug asking whether they mean the set pictured on the site or a new custom one, and noted we do not make the board. No reply yet. Name still unknown.',
   'followed', date '2026-08-14', date '2026-08-14'),

  ('Dan', 'dan792029@gmail.com', 'custom chess set', 'website',
   'Replied 17 Aug explaining a new custom set runs to a few months: drawings first, then wax, then casting. No reply yet.',
   'followed', date '2026-08-17', date '2026-08-17'),

  ('Alan Boardman', 'anboardman@gmail.com', 'custom bronze totem', 'website',
   'Asked how big the totems are. Answered 17 Aug, pocket-sized, roughly 4-5cm. He is away for two weeks and said he will make contact on his return, so expect to hear around 31 Aug.',
   'followed', date '2026-08-17', date '2026-08-17'),

  -- Both replies bounced. As far as this person knows, we never answered.
  ('Thailand bronzes enquiry', 'keawes24@gmail.com', 'bronze pieces, possibly cutlery', 'website',
   'Saw bronze pieces in Thailand and asked about something similar. REPLIES BOUNCED TWICE on 17 Aug, 550 address not found, so they have received nothing from us. Needs a working address before anything else.',
   'open', date '2026-08-17', null),

  -- Promised a check-back in March and it never happened.
  ('Josh King', 'king.js@aol.com', 'memorial totem for a late pet', 'instagram',
   'Wants a totem for his partner in memory of Patsy, the pet they lost early in the year. Turned down in March because the books were full, with an explicit promise to come back when there was room. Five months later that has not happened. He also bought an Eleph.',
   'open', date '2026-03-19', date '2026-03-30')

) as v(name, email, subject, source, note, status, first_seen, last_touched)
where not exists (select 1 from public.inquiries i where i.email = v.email);

-- Jason's address, from the 2025 heron commission thread
update public.inquiries set email = 'jason@hey.com'
 where name = 'Jason Fried' and (email is null or email = '');
