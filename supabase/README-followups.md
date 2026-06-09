# Weekly follow-up digest (emailed reminder)

This is the optional backend half of the follow-up feature. The app already shows
who's due in the drawer; this emails you and Hannah a weekly summary so you don't
have to open the app to remember. It re-runs the **exact same** due logic as
`index.html` (lead time + 14-day settle, 21-day snooze, no upper cap, plus the
VIP "Reconnect" rule) and sends the digest via [Resend](https://resend.com).

Sending the actual follow-ups stays manual (copy / mailto in the app). Only this
internal reminder is automated.

## One-time setup (~20 min)

You need the [Supabase CLI](https://supabase.com/docs/guides/cli) installed and
to be logged in (`supabase login`), plus a free Resend account.

### 1. Resend
1. Create an account at **resend.com**.
2. (Recommended) Verify your domain so mail can come `from` `archive@studiomacon.co`.
   Until then you can use the test sender `onboarding@resend.dev`.
3. Copy an **API key** from the Resend dashboard.

### 2. Link the project and set secrets
```bash
# from this macon-archive/ folder
supabase link --project-ref <your-project-ref>      # ref is in your Supabase URL

supabase secrets set RESEND_API_KEY="re_xxxxxxxx"
supabase secrets set DIGEST_TO="alex@studiomacon.co,hannah@studiomacon.co"
supabase secrets set DIGEST_FROM="Maçon Archive <archive@studiomacon.co>"   # or onboarding@resend.dev
```
`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically — don't set them.

### 3. Deploy the function
```bash
supabase functions deploy followup-digest
```
Test it immediately:
```bash
supabase functions invoke followup-digest
```
You should get `{ "sent": [...], "due": N }` and an email in your inbox.

### 4. Schedule it weekly (Mondays 9am) with pg_cron
In Supabase → **SQL Editor**, run once:
```sql
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'macon-followup-digest',
  '0 9 * * 1',                         -- Monday 09:00 UTC; adjust as you like
  $$
  select net.http_post(
    url     := 'https://<your-project-ref>.supabase.co/functions/v1/followup-digest',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer <YOUR_SUPABASE_ANON_KEY>'
    )
  );
  $$
);
```
To change the time, `select cron.unschedule('macon-followup-digest');` and re-run with a new cron expression.

## Keeping logic in sync
`index.html` and `functions/followup-digest/index.ts` each hold their own copy of
`LEAD_DEFAULT`, `PIECE_LEAD`, `isDue`, and `isReconnectDue`. If you change the timing
rules or fill in real per-piece lead times in one, mirror it in the other so the
emailed digest matches what the app shows.
