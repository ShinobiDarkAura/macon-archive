// Reading a Shopify order webhook: its signature and its payload. Kept apart
// from index.ts so it can be tested without starting a server.

import { type InvoiceLine } from "../_shared/orders.ts";

type Rec = Record<string, any>;
const num = (v: any) => { const n = parseFloat(String(v ?? "")); return isNaN(n) ? 0 : n; };

/** Shopify's signature: base64 HMAC-SHA256 of the raw body, keyed by the webhook secret. */
export async function signatureValid(raw: string, header: string | null, secret: string): Promise<boolean> {
  if (!header || !secret) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw)));
  const expected = btoa(String.fromCharCode(...sig));
  if (expected.length !== header.length) return false;
  let diff = 0;                                          // constant time
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ header.charCodeAt(i);
  return diff === 0;
}

/** A Shopify order, as the archive needs it. */
export function readOrder(o: Rec) {
  const ship = o.shipping_address || {}, bill = o.billing_address || {}, cust = o.customer || {};
  const email = String(o.email || o.contact_email || cust.email || "").trim().toLowerCase();
  const name = [cust.first_name, cust.last_name].filter(Boolean).join(" ").trim()
    || String(bill.name || ship.name || "").trim();
  const lineItems: Rec[] = Array.isArray(o.line_items) ? o.line_items : [];
  const items = lineItems.flatMap((li) => {
    const t = String(li.title || li.name || "").trim(), q = Math.max(1, parseInt(li.quantity, 10) || 1);
    return t ? Array(q).fill(t) : [];
  });
  const lines: InvoiceLine[] = lineItems.map((li) => {
    const variant = li.variant_title && li.variant_title !== "Default Title" ? ` (${li.variant_title})` : "";
    return { desc: String(li.title || li.name || "").trim() + variant, qty: Math.max(1, parseInt(li.quantity, 10) || 1), unit: num(li.price) };
  }).filter((l) => l.desc);
  // Shipping, tax and any discount ride as lines, so the invoice adds up to what was charged.
  const shipping = num(o.total_shipping_price_set?.shop_money?.amount ?? o.shipping_lines?.reduce?.((s: number, l: Rec) => s + num(l.price), 0));
  const tax = num(o.total_tax), discount = num(o.total_discounts);
  if (shipping > 0) lines.push({ desc: "Shipping", qty: 1, unit: shipping });
  if (tax > 0) lines.push({ desc: "Sales tax", qty: 1, unit: tax });
  if (discount > 0) lines.push({ desc: "Discount", qty: 1, unit: -discount });
  return {
    orderId: o.id != null ? `shopify:${o.id}` : "",
    email, name,
    phone: String(ship.phone || bill.phone || cust.phone || o.phone || "").replace(/[^0-9+]/g, ""),
    street: String(ship.address1 || bill.address1 || "").trim(),
    postcode: String(ship.zip || bill.zip || "").trim(),
    city: String(ship.city || bill.city || "").trim(),
    country: String(ship.country || bill.country || "").trim(),
    total: num(o.total_price ?? o.current_total_price),
    items, lines,
    date: String(o.created_at || o.processed_at || new Date().toISOString()).slice(0, 10),
  };
}

