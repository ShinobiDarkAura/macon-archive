// Maçon Archive — Shopify order webhook
//
// The new studiomacon.co is a headless Shopify store (w3nidi-ny.myshopify.com):
// people pay in Shopify's checkout, so the order lands in Shopify, and this is
// how it reaches the archive. Shopify posts each paid order here; it is read
// into an Order and applied exactly as a Wix order is (../_shared/orders.ts):
// joined to the collector it belongs to, or a new one, plus a retail invoice.
//
// Set up in Shopify admin, no app or API token needed:
//   Settings → Notifications → Webhooks → Create webhook
//     Event: Order payment   Format: JSON   API version: 2026-07 (created 18 Sep 2026)
//     URL:   https://berdrzxjoejirbhdgjer.supabase.co/functions/v1/shopify-order
//   That page shows "Your webhooks will be signed with <key>". Store it:
//     supabase secrets set SHOPIFY_WEBHOOK_SECRET=<key>
//
// DEPLOY WITH --no-verify-jwt:  supabase functions deploy shopify-order --no-verify-jwt
// Shopify sends no login token; it signs the body instead, and that signature is
// checked here. Without the key set, every request is refused.

import { applyOrder } from "../_shared/orders.ts";
import { isSample, readOrder, signatureValid } from "./shopify.ts";

type Rec = Record<string, any>;
const ok = (body: Rec, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const SECRET = Deno.env.get("SHOPIFY_WEBHOOK_SECRET") || "";

  if (req.method !== "POST") return ok({ status: "alive" });
  if (!SECRET) return ok({ error: "not configured: SHOPIFY_WEBHOOK_SECRET is not set" }, 503);
  const raw = await req.text();
  if (!(await signatureValid(raw, req.headers.get("x-shopify-hmac-sha256"), SECRET))) return ok({ error: "bad signature" }, 401);

  let o: Rec;
  try { o = JSON.parse(raw); } catch { return ok({ error: "not json" }, 400); }
  // Orders placed with Shopify's test gateway are rehearsals, not collectors.
  if (o.test === true) return ok({ status: "test order ignored", id: o.id });
  if (o.cancelled_at) return ok({ status: "cancelled order ignored", id: o.id });

  const order = readOrder(o);
  if (!order.email) return ok({ error: "no buyer email in order", id: o.id }, 422);
  if (isSample(order.email, o.id, o.checkout_token)) return ok({ status: "sample order ignored", email: order.email });
  const [status, body] = await applyOrder(order, SUPABASE_URL, SERVICE_KEY);

  // The checkout this order came out of is no longer one that was left: Shopify
  // does not reliably say so itself, but every order carries its checkout's
  // token, and that is the only dependable way a checkout is marked as bought.
  if (o.checkout_token) {
    await fetch(`${SUPABASE_URL}/rest/v1/checkouts?token=eq.${encodeURIComponent(String(o.checkout_token))}`, {
      method: "PATCH",
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ completed_at: o.processed_at || o.created_at || new Date().toISOString() }),
    }).catch(() => {});                       // an order must never fail over its checkout
  }
  return ok(body, status);
});
