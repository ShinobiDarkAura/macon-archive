import { assertEquals } from "jsr:@std/assert@1";
import { readOrder, signatureValid } from "./shopify.ts";

// Trimmed from the shape Shopify posts for "Order payment" (API 2025-07).
export const SAMPLE = {
  id: 5820011234567, name: "#1001", order_number: 1001, test: false,
  email: "Joshua.King@Example.com", created_at: "2026-09-19T14:05:00-07:00",
  total_price: "572.40", total_tax: "43.40", total_discounts: "10.00",
  total_shipping_price_set: { shop_money: { amount: "12.00", currency_code: "USD" } },
  customer: { first_name: "Joshua", last_name: "King", email: "joshua.king@example.com", phone: null },
  shipping_address: { name: "Joshua King", address1: "12 Laurel Street", city: "Smithfield", zip: "15478", country: "United States", phone: "(814) 660-7478" },
  billing_address: { name: "Joshua King", address1: "12 Laurel Street", city: "Smithfield", zip: "15478", country: "United States" },
  line_items: [
    { title: "Sietch Ring", variant_title: "Size 9", quantity: 1, price: "325.00" },
    { title: "Pip", variant_title: "Default Title", quantity: 2, price: "101.00" },
  ],
};

Deno.test("reads a Shopify order into what the archive keeps", () => {
  const o = readOrder(SAMPLE);
  assertEquals(o.orderId, "shopify:5820011234567");
  assertEquals(o.email, "joshua.king@example.com");
  assertEquals(o.name, "Joshua King");
  assertEquals(o.phone, "8146607478");
  assertEquals([o.street, o.postcode, o.city], ["12 Laurel Street", "15478", "Smithfield"]);
  assertEquals(o.total, 572.4);
  assertEquals(o.items, ["Sietch Ring", "Pip", "Pip"]);
  assertEquals(o.date, "2026-09-19");
  // the invoice adds up to what Shopify charged
  const sum = o.lines.reduce((s, l) => s + l.qty * l.unit, 0);
  assertEquals(Math.round(sum * 100) / 100, 572.4);
  assertEquals(o.lines[0].desc, "Sietch Ring (Size 9)");
  assertEquals(o.lines[1].desc, "Pip");
});

Deno.test("only Shopify's own signature is accepted", async () => {
  const raw = JSON.stringify(SAMPLE), secret = "shpss_test";
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const good = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw)))));
  assertEquals(await signatureValid(raw, good, secret), true);
  assertEquals(await signatureValid(raw + " ", good, secret), false);      // body altered
  assertEquals(await signatureValid(raw, good, "someone-else"), false);    // wrong key
  assertEquals(await signatureValid(raw, null, secret), false);            // unsigned
  assertEquals(await signatureValid(raw, good, ""), false);                // no key configured
});
