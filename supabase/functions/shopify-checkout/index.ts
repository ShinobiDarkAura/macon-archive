// Maçon Archive — Shopify checkout webhook
//
// Fires when someone reaches checkout (checkouts/create) and again as they fill
// it in (checkouts/update). One row per checkout, kept current, in `checkouts`.
// Once it becomes an order Shopify stamps completed_at, and so do we. What is
// left open is the list of people who nearly bought.
//
// Set up in Shopify admin: Settings → Notifications → Webhooks → Create webhook
//   Event: Checkout creation, and again for Checkout update   Format: JSON
//   URL:   https://berdrzxjoejirbhdgjer.supabase.co/functions/v1/shopify-checkout
// Signed with the same store key as shopify-order (SHOPIFY_WEBHOOK_SECRET).
//
// DEPLOY WITH --no-verify-jwt:  supabase functions deploy shopify-checkout --no-verify-jwt

import { isSample, signatureValid } from "../shopify-order/shopify.ts";

type Rec = Record<string, any>;
const ok = (body: Rec, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const num = (v: any) => { const n = parseFloat(String(v ?? "")); return isNaN(n) ? 0 : n; };

Deno.serve(async (req) => {
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const SECRET = Deno.env.get("SHOPIFY_WEBHOOK_SECRET") || "";
  const H = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" };

  if (req.method !== "POST") return ok({ status: "alive" });
  if (!SECRET) return ok({ error: "not configured: SHOPIFY_WEBHOOK_SECRET is not set" }, 503);
  const raw = await req.text();
  if (!(await signatureValid(raw, req.headers.get("x-shopify-hmac-sha256"), SECRET))) return ok({ error: "bad signature" }, 401);

  let c: Rec;
  try { c = JSON.parse(raw); } catch { return ok({ error: "not json" }, 400); }
  const token = String(c.token || c.id || "");
  const cust = c.customer || {}, bill = c.billing_address || {}, ship = c.shipping_address || {};
  const email = String(c.email || cust.email || "").trim().toLowerCase();
  // A checkout with no email yet tells us nothing about who; wait for the update that has one.
  if (!token || !email) return ok({ status: "no email yet", token });
  if (isSample(email, token, c.id)) return ok({ status: "sample checkout ignored", email });

  const lines: Rec[] = Array.isArray(c.line_items) ? c.line_items : [];
  const pieces = lines.map((li) => {
    const q = Math.max(1, parseInt(li.quantity, 10) || 1), t = String(li.title || li.name || "").trim();
    return q > 1 ? `${t} ×${q}` : t;
  }).filter(Boolean).join(", ");
  const name = [cust.first_name, cust.last_name].filter(Boolean).join(" ").trim() || String(bill.name || ship.name || "").trim();

  // The collector, if this address is already on someone's record.
  const or = encodeURIComponent(`(email.eq.${email},alt_emails.cs.{${email}})`);
  const found = await fetch(`${SUPABASE_URL}/rest/v1/collectors?or=${or}&select=acc,merged_into`, { headers: H });
  const who: Rec | undefined = found.ok ? (await found.json())[0] : undefined;

  const row = {
    token, email, name: name || null, acc: who ? (who.merged_into || who.acc) : null,
    pieces: pieces || null, total: num(c.total_price ?? c.subtotal_price),
    recovery_url: c.abandoned_checkout_url || null,
    started_at: c.created_at || new Date().toISOString(),
    updated_at: new Date().toISOString(),
    completed_at: c.completed_at || null,
  };
  const up = await fetch(`${SUPABASE_URL}/rest/v1/checkouts?on_conflict=token`, {
    method: "POST", headers: { ...H, Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(row),
  });
  if (!up.ok) return ok({ error: "could not save: " + (await up.text()) }, 502);
  return ok({ status: row.completed_at ? "completed" : "open", token, acc: row.acc });
});
