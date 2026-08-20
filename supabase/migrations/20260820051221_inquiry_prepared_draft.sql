-- A prepared draft on the record itself.
--
-- The generic tones cannot know that Josh's pet was called Patsy or that he
-- bought an Eleph anyway. Where a specific letter is worth writing in advance,
-- it lives here and the draft modal offers it first.

alter table public.inquiries add column if not exists draft text;

update public.inquiries set draft =
'Hi Josh,

I said in March that we would come back to you once our books cleared, and I have taken far too long to do it. I am sorry.

If you still want something for Patsy, I would like to make it. Tell me a little about her, what she looked like, how she sat, anything you remember about the shape of her, and I will draw something before either of us talks about money.

And thank you for the Eleph. I saw it go out.

Hannah'
where email = 'king.js@aol.com';
