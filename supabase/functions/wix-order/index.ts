// Maçon Archive — Wix order webhook
// Receives "order placed" webhooks from a Wix Automation and upserts the collector:
// a known address, or a person proven to be someone we know (see ../_shared) ->
// piece added, LTV incremented (once per order), last_buy refreshed; otherwise a
// new collector. See ../../README-wix-webhook.md for setup.
//
// Secrets (supabase secrets set ...):
//   WIX_WEBHOOK_SECRET   shared secret; the webhook URL must include ?secret=<value>
//
// DEPLOY WITH --no-verify-jwt:   supabase functions deploy wix-order --no-verify-jwt
// Wix sends no login token, only the secret above, which this function checks
// itself. Deployed without the flag, the gateway turns every order away before
// this code runs, silently: that happened on 15 Aug 2026 and no order reached
// the archive for a month.

import { applyOrder } from "../_shared/orders.ts";

type Rec = Record<string, any>;

const ok = (body: Rec, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

// Walk a nested object trying several known Wix payload paths
function pick(obj: any, paths: string[]): any {
  for (const path of paths) {
    let v = obj;
    for (const k of path.split(".")) { v = v?.[k]; if (v == null) break; }
    if (v != null && v !== "") return v;
  }
  return null;
}

function moneyToNumber(v: any): number {
  if (v == null) return 0;
  if (typeof v === "number") return v;
  if (typeof v === "object") return moneyToNumber(v.amount ?? v.value ?? v.total ?? null);
  const n = parseFloat(String(v).replace(/[^0-9.\-]/g, ""));
  return isNaN(n) ? 0 : n;
}

Deno.serve(async (req) => {
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const SECRET = Deno.env.get("WIX_WEBHOOK_SECRET") || "";

  const url = new URL(req.url);
  if (!SECRET || url.searchParams.get("secret") !== SECRET) return ok({ error: "bad secret" }, 401);
  if (req.method !== "POST") return ok({ status: "alive" });

  let payload: Rec;
  try { payload = await req.json(); } catch { return ok({ error: "not json" }, 400); }
  // Wix automations sometimes nest the order under data/order/orderDetails
  const order = payload.order ?? payload.data?.order ?? payload.data ?? payload;

  const email = String(pick(order, [
    "buyerInfo.email", "buyerInfo.contactDetails.email", "billingInfo.email",
    "contactDetails.email", "email", "customerEmail", "contact.email",
  ]) ?? "").trim().toLowerCase();
  if (!email) return ok({ error: "no buyer email in payload", keys: Object.keys(order) }, 422);

  const orderId = String(pick(order, ["number", "orderNumber", "id", "orderId", "_id"]) ?? "").trim();
  const name = String(pick(order, [
    "buyerInfo.firstName", "billingInfo.contactDetails.firstName",
  ]) ?? "") && `${pick(order, ["buyerInfo.firstName", "billingInfo.contactDetails.firstName"]) ?? ""} ${pick(order, ["buyerInfo.lastName", "billingInfo.contactDetails.lastName"]) ?? ""}`.trim()
    || String(pick(order, ["billingInfo.fullName", "buyerName", "customerName", "recipientInfo.contactDetails.fullName"]) ?? "").trim();
  const total = moneyToNumber(pick(order, [
    "priceSummary.total", "totals.total", "paymentTotal", "total", "totalPrice", "amount",
  ]));
  const rawItems = pick(order, ["lineItems", "items", "catalogItems", "line_items", "products"]) || [];
  // Wix has named a line item's product several ways across its APIs and
  // automation payloads; the first that holds text wins.
  const itemName = (li: Rec) => {
    const v = pick(li, ["productName.original", "productName.translated", "itemName", "productName",
      "name.original", "name", "title", "description", "catalogItemName"]);
    return typeof v === "string" ? v.trim() : "";
  };
  const items: string[] = (Array.isArray(rawItems) ? rawItems : []).flatMap((li: Rec) => {
    const nm = itemName(li);
    const qty = parseInt(String(li?.quantity ?? 1), 10) || 1;
    return nm ? Array(qty).fill(nm) : [];
  });
  // Invoice lines keep quantity and unit price, unlike `items` above which
  // flattens to repeated names for the collector's pieces column.
  const invLines = (Array.isArray(rawItems) ? rawItems : []).map((li: Rec) => ({
    desc: itemName(li),
    qty: parseInt(String(li?.quantity ?? 1), 10) || 1,
    unit: moneyToNumber(pick(li, ["price.amount", "price.value", "price", "priceData.price", "unitPrice",
      "priceData.discountedPrice", "priceBeforeDiscounts.amount", "fullPrice.amount"])),
  })).filter((l) => l.desc);
  // Chelsea Sonksen's and Joshua King's orders arrived with no pieces and no
  // invoice: nothing above matched. Say so in the function log, with the shape
  // Wix actually sent, so it is seen and fixed rather than lost quietly.
  if (!items.length) console.warn("wix-order: no line items read", JSON.stringify({
    orderKeys: Object.keys(order || {}),
    firstItemKeys: Array.isArray(rawItems) && rawItems[0] ? Object.keys(rawItems[0]) : null,
  }));
  const shipping = moneyToNumber(pick(order, ["priceSummary.shipping", "totals.shipping", "shippingInfo.cost.price"]));
  const taxAmt = moneyToNumber(pick(order, ["priceSummary.tax", "totals.tax"]));
  if (shipping > 0) invLines.push({ desc: "Shipping", qty: 1, unit: shipping });
  if (taxAmt > 0) invLines.push({ desc: "Sales tax", qty: 1, unit: taxAmt });

  const dateRaw = pick(order, ["createdDate", "dateCreated", "purchasedDate", "createdAt", "_createdDate"]);
  const date = (dateRaw ? new Date(dateRaw) : new Date()).toISOString().slice(0, 10);
  const city = String(pick(order, [
    "shippingInfo.logistics.shippingDestination.address.city",
    "shippingInfo.shipmentDetails.address.city", "billingInfo.address.city", "shippingAddress.city",
  ]) ?? "").trim();
  const country = String(pick(order, [
    "shippingInfo.logistics.shippingDestination.address.country",
    "shippingInfo.shipmentDetails.address.country", "billingInfo.address.country", "shippingAddress.country",
  ]) ?? "").trim();
  const phone = String(pick(order, [
    "buyerInfo.phone", "billingInfo.contactDetails.phone", "billingInfo.phone",
  ]) ?? "").replace(/[^0-9+]/g, "");
  // Kept because, with the surname, they are what proves two addresses are one person.
  const street = String(pick(order, [
    "shippingInfo.logistics.shippingDestination.address.addressLine1",
    "shippingInfo.logistics.shippingDestination.address.addressLine",
    "shippingInfo.shipmentDetails.address.addressLine1", "shippingInfo.shipmentDetails.address.addressLine",
    "billingInfo.address.addressLine1", "billingInfo.address.addressLine", "shippingAddress.addressLine1",
  ]) ?? "").trim();
  const postcode = String(pick(order, [
    "shippingInfo.logistics.shippingDestination.address.postalCode",
    "shippingInfo.shipmentDetails.address.postalCode", "shippingInfo.shipmentDetails.address.zipCode",
    "billingInfo.address.postalCode", "billingInfo.address.zipCode", "shippingAddress.postalCode",
  ]) ?? "").trim();

  const [status, body] = await applyOrder({
    orderId, ref: orderId ? "#" + orderId : "", email, name, phone, street, postcode, city, country,
    total, items, lines: invLines, date,
  }, SUPABASE_URL, SERVICE_KEY);
  return ok(body, status);
});
