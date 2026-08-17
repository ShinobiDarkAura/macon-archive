-- Where the foot note prints: left, centre or right.
alter table public.invoices
  add column if not exists note_pos text not null default 'left'
  check (note_pos in ('left','center','right'));

create or replace function public.new_invoice(p jsonb)
returns public.invoices
language plpgsql
security definer
set search_path = public
as $$
declare
  n   integer;
  pre text;
  rec public.invoices;
begin
  update public.invoice_counters
     set last_seq = last_seq + 1
   where kind = p->>'kind'
  returning last_seq into n;

  if n is null then
    raise exception 'unknown invoice kind: %', p->>'kind';
  end if;

  pre := case p->>'kind'
           when 'retail' then 'R'
           when 'wholesale' then 'W'
           else 'C'
         end;

  insert into public.invoices
    (kind, seq, number, issued_on, bill_to, bill_email, bill_addr,
     items, discount_pct, tax_pct, notes, note_pos, order_ref)
  values
    (p->>'kind', n, pre || '-' || lpad(n::text, 3, '0'),
     coalesce((p->>'issued_on')::date, current_date),
     p->>'bill_to', p->>'bill_email', p->>'bill_addr',
     coalesce(p->'items', '[]'::jsonb),
     coalesce((p->>'discount_pct')::numeric, 0),
     coalesce((p->>'tax_pct')::numeric, 0),
     p->>'notes', coalesce(p->>'note_pos','left'), p->>'order_ref')
  returning * into rec;

  return rec;
end $$;

grant execute on function public.new_invoice(jsonb) to authenticated;
