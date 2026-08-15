-- Lock down new_invoice().
--
-- Postgres grants EXECUTE on functions to PUBLIC by default, so the earlier
-- `grant execute ... to authenticated` restricted nothing: anyone holding the
-- publishable key, which ships in the page, could mint invoice numbers. The
-- function is security definer, so it bypassed RLS on the way through.

revoke all on function public.new_invoice(jsonb) from public;
revoke all on function public.new_invoice(jsonb) from anon;
grant execute on function public.new_invoice(jsonb) to authenticated;
grant execute on function public.new_invoice(jsonb) to service_role;

-- Belt as well as braces: being signed in is not the same as being a keeper.
-- The Wix webhook arrives as service_role and is let through.
create or replace function public.new_invoice(p jsonb)
returns public.invoices
language plpgsql
security definer
set search_path = public
as $$
declare
  n integer; pre text; rec public.invoices;
  claim_role  text := coalesce(auth.jwt() ->> 'role', '');
  claim_email text := coalesce(auth.jwt() ->> 'email', '');
begin
  if claim_role <> 'service_role'
     and claim_email not in ('alex@studiomacon.co','hannah@studiomacon.co') then
    raise exception 'not permitted';
  end if;

  update public.invoice_counters
     set last_seq = last_seq + 1
   where kind = p->>'kind'
  returning last_seq into n;

  if n is null then
    raise exception 'unknown invoice kind: %', p->>'kind';
  end if;

  pre := case p->>'kind' when 'retail' then 'R' when 'wholesale' then 'W' else 'C' end;

  insert into public.invoices
    (kind, seq, number, issued_on, bill_to, bill_email, bill_addr,
     items, discount_pct, tax_pct, notes, order_ref)
  values
    (p->>'kind', n, pre || '-' || lpad(n::text, 3, '0'),
     coalesce((p->>'issued_on')::date, current_date),
     p->>'bill_to', p->>'bill_email', p->>'bill_addr',
     coalesce(p->'items', '[]'::jsonb),
     coalesce((p->>'discount_pct')::numeric, 0),
     coalesce((p->>'tax_pct')::numeric, 0),
     p->>'notes', p->>'order_ref')
  returning * into rec;

  return rec;
end $$;

revoke all on function public.new_invoice(jsonb) from public;
revoke all on function public.new_invoice(jsonb) from anon;
grant execute on function public.new_invoice(jsonb) to authenticated;
grant execute on function public.new_invoice(jsonb) to service_role;

-- Remove the two rows the security probe created, and rewind the counter.
delete from public.invoices
 where kind = 'wholesale'
   and items = '[]'::jsonb
   and created_at > now() - interval '2 hours'
   and (bill_to is null or bill_to = 'ANON PROBE');

update public.invoice_counters
   set last_seq = coalesce((select max(seq) from public.invoices where kind = 'wholesale'), 0)
 where kind = 'wholesale';
