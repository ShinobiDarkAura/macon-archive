-- The archive watches the checkouts table the way it watches enquiries, so a
-- checkout that opens while the desk is on screen appears without a reload.
-- Without this the app's subscription is live but silent.
do $$ begin
  alter publication supabase_realtime add table public.checkouts;
exception when duplicate_object then null;
end $$;
