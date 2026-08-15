-- Maçon Archive — invoices
-- Run once in the Supabase SQL editor.
--
-- Three independent numbering sequences, one per kind: R-001 retail,
-- W-001 wholesale, C-001 custom. Numbers are allocated by new_invoice(), which
-- takes a row lock on the counter so two invoices can never share a number even
-- if a keeper is filling one in while a Wix order lands.

create table if not exists public.invoices (
  id            uuid primary key default gen_random_uuid(),
  kind          text not null check (kind in ('retail','wholesale','custom')),
  seq           integer not null,
  number        text not null unique,               -- 'W-001'
  issued_on     date not null default current_date,
  bill_to       text,                               -- person or shop
  bill_email    text,
  bill_addr     text,
  items         jsonb not null default '[]'::jsonb, -- [{desc, qty, unit}]
  discount_pct  numeric not null default 0,
  tax_pct       numeric not null default 0,
  notes         text,
  order_ref     text,                               -- Wix order id, retail only
  created_at    timestamptz default now(),
  updated_at    timestamptz default now(),
  unique (kind, seq)
);

-- One retail order can only ever produce one invoice, however many times the
-- Wix automation retries.
create unique index if not exists invoices_order_ref_uniq
  on public.invoices(order_ref) where order_ref is not null;

create index if not exists invoices_issued_idx on public.invoices(issued_on desc);

drop trigger if exists invoices_touch on public.invoices;
create trigger invoices_touch before update on public.invoices
  for each row execute function public.touch_updated_at();

-- ---------- numbering ----------

create table if not exists public.invoice_counters (
  kind     text primary key,
  last_seq integer not null default 0
);
insert into public.invoice_counters(kind, last_seq)
  values ('retail',0), ('wholesale',0), ('custom',0)
  on conflict (kind) do nothing;

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
  -- row lock serialises concurrent allocations
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

-- ---------- access ----------

alter table public.invoices enable row level security;
alter table public.invoice_counters enable row level security;

drop policy if exists "keepers only" on public.invoices;
create policy "keepers only" on public.invoices
  for all to authenticated
  using      ( auth.jwt() ->> 'email' in ('alex@studiomacon.co','hannah@studiomacon.co') )
  with check ( auth.jwt() ->> 'email' in ('alex@studiomacon.co','hannah@studiomacon.co') );

-- counters are only ever touched through new_invoice(), which is security definer
drop policy if exists "no direct access" on public.invoice_counters;
create policy "no direct access" on public.invoice_counters for all to authenticated using (false);

grant execute on function public.new_invoice(jsonb) to authenticated;

alter publication supabase_realtime add table public.invoices;
