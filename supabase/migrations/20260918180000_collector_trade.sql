-- Maçon Archive — trade buyers.
-- Someone who buys at trade terms (wholesale, a stockist) is not a collector to
-- send story asks and catch-ups to. Set by the order path when an order reads
-- as trade; a keeper can clear it in the record.
alter table public.collectors add column if not exists trade boolean not null default false;
