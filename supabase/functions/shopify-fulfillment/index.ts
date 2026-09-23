// Maçon Archive — Shopify fulfillment webhook
//
// Fires when an order is marked shipped (fulfillments/create). Records the day
// on the order and on its collector (last_shipped), so the story ask counts
// from when the piece left the studio rather than when it was bought.
//
// Set up in Shopify admin: Settings → Notifications → Webhooks → Create webhook
//   Event: Fulfillment creation   Format: JSON
//   URL:   https://berdrzxjoejirbhdgjer.supabase.co/functions/v1/shopify-fulfillment
// Signed with the same store key as shopify-order (SHOPIFY_WEBHOOK_SECRET).
//
// DEPLOY WITH --no-verify-jwt:  supabase functions deploy shopify-fulfillment --no-verify-jwt

import { isSample, signatureValid } from "../shopify-order/shopify.ts";

type Rec = Record<string, any>;
const ok = (body: Rec, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const SECRET = Deno.env.get("SHOPIFY_WEBHOOK_SECRET") || "";
  const H = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" };

  if (req.method !== "POST") return ok({ status: "alive" });
  if (!SECRET) return ok({ error: "not configured: SHOPIFY_WEBHOOK_SECRET is not set" }, 503);
  const raw = await req.text();
  if (!(await signatureValid(raw, req.headers.get("x-shopify-hmac-sha256"), SECRET))) return ok({ error: "bad signature" }, 401);

  let f: Rec;
  try { f = JSON.parse(raw); } catch { return ok({ error: "not json" }, 400); }
  if (f.status && f.status !== "success") return ok({ status: `fulfillment ${f.status}, not shipped`, id: f.id });
  if (isSample("", f.id, f.order_id)) return ok({ status: "sample fulfillment ignored", id: f.id });
  const orderId = f.order_id != null ? `shopify:${f.order_id}` : "";
  if (!orderId) return ok({ error: "no order id" }, 422);
  const when = String(f.created_at || new Date().toISOString());
  const day = when.slice(0, 10);

  // The order as the archive recorded it, which carries the buyer's email.
  const got = await fetch(`${SUPABASE_URL}/rest/v1/processed_orders?id=eq.${encodeURIComponent(orderId)}&select=id,email`, { headers: H });
  const order: Rec | undefined = got.ok ? (await got.json())[0] : undefined;
  // Shopify's test notification, or an order from before the archive was listening.
  if (!order) return ok({ status: "order not in the archive", orderId });

  await fetch(`${SUPABASE_URL}/rest/v1/processed_orders?id=eq.${encodeURIComponent(orderId)}`, {
    method: "PATCH", headers: { ...H, Prefer: "return=minimal" }, body: JSON.stringify({ shipped_at: when }) });

  const email = String(order.email || "").toLowerCase();
  if (!email) return ok({ status: "shipped, no email to find the collector by", orderId });
  const or = encodeURIComponent(`(email.eq.${email},alt_emails.cs.{${email}})`);
  const found = await fetch(`${SUPABASE_URL}/rest/v1/collectors?or=${or}&select=acc,merged_into`, { headers: H });
  const who: Rec | undefined = found.ok ? (await found.json())[0] : undefined;
  if (!who) return ok({ status: "shipped, collector not found", orderId });
  const acc = who.merged_into || who.acc;
  await fetch(`${SUPABASE_URL}/rest/v1/collectors?acc=eq.${encodeURIComponent(acc)}`, {
    method: "PATCH", headers: { ...H, Prefer: "return=minimal" }, body: JSON.stringify({ last_shipped: day }) });
  return ok({ status: "shipped", orderId, acc, day });
});
