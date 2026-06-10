# Wix orders → Maçon Archive (automatic)

New Wix orders flow straight into the archive: existing collectors get the piece
added, LTV incremented (once per order, even if Wix retries), and `last_buy`
refreshed — which also starts their follow-up clock. New emails become new
collectors with the next `M-xxx` number. Refunds/cancellations do NOT flow
through; do an occasional full CSV re-import as a true-up.

## One-time setup (~15 min)

### 1. Create the dedupe table
Supabase → SQL Editor → run once:

```sql
create table if not exists public.processed_orders (
  id          text primary key,
  email       text,
  total       numeric,
  applied_at  timestamptz default now()
);
alter table public.processed_orders enable row level security;
-- no policies: only the service role (the function) can touch it
```

### 2. Deploy the function
From this `macon-archive/` folder (after `supabase login` + `supabase link`):

```bash
supabase secrets set WIX_WEBHOOK_SECRET="$(openssl rand -hex 16)"
# note the value it generated:
supabase secrets list

supabase functions deploy wix-order --no-verify-jwt
```

`--no-verify-jwt` matters — Wix can't send a Supabase auth header; the shared
secret in the URL is the auth instead.

Your webhook URL is:

```
https://<project-ref>.supabase.co/functions/v1/wix-order?secret=<WIX_WEBHOOK_SECRET>
```

Test it from the terminal:

```bash
curl -X POST "https://<project-ref>.supabase.co/functions/v1/wix-order?secret=<secret>" \
  -H "Content-Type: application/json" \
  -d '{"number":"TEST-1","buyerInfo":{"email":"test@example.com","firstName":"Test","lastName":"Buyer"},
       "priceSummary":{"total":{"amount":"250"}},
       "lineItems":[{"productName":{"original":"Pip"},"quantity":1}],
       "createdDate":"2026-06-10T12:00:00Z"}'
```

You should get `{"status":"created", ...}` and see "Test Buyer" appear in the
app (delete the row + the TEST-1 row in `processed_orders` afterwards).

### 3. Wire it up in Wix
Wix Dashboard → **Automations** → **+ New Automation**:

- **Trigger:** eCommerce & Stores → **Order placed**
- **Action:** **Send via webhook** (under "Connect to external apps";
  requires a Business/eCommerce plan)
- **URL:** the webhook URL above, including `?secret=...`
- **Payload:** include the full order object / all available order fields
  (the function reads buyer email, line items, totals, dates, and the shipping
  address from any of Wix's usual payload shapes)
- Activate.

Place a cheap test order (or use Wix's "test automation" button) and confirm
the collector appears/updates in the archive.

## Notes
- **Idempotent:** each Wix order number is applied once, recorded in
  `processed_orders`. Webhook retries and duplicate automations are ignored.
- **Field mapping:** total → LTV (+=), line items → pieces tally (`Pip ×2`),
  created date → `last_buy` (and `first_buy` if empty), shipping city/country →
  location (only if blank), phone/name only fill blanks. `first_look` auto-sets
  when LTV passes $1,000 (matches the CSV importer).
- **What it never touches:** notes, story status, photos, `last_contact` —
  your cultivation data is yours.
- If Wix changes payload shape and the function can't find an email, it returns
  422 with the payload's top-level keys — check the function logs
  (Supabase → Edge Functions → wix-order → Logs) and send me the shape.
