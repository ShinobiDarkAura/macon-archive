// Maçon Archive — Wix order webhook
// Receives "order placed" webhooks from a Wix Automation and upserts the collector:
// a known address, or a person proven to be someone we know (see identity.ts) ->
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

import { matchPerson, surname, type Person } from "./identity.ts";

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

function tallyPieces(existing: string, newItems: string[]): string {
  const tally = new Map<string, number>();
  (existing || "").split(",").map((s) => s.trim()).filter(Boolean).forEach((tok) => {
    const m = /^(.*?)\s*[×x](\d+)$/.exec(tok);
    if (m) tally.set(m[1].trim(), (tally.get(m[1].trim()) || 0) + parseInt(m[2], 10));
    else tally.set(tok, (tally.get(tok) || 0) + 1);
  });
  newItems.forEach((it) => { const k = it.trim(); if (k) tally.set(k, (tally.get(k) || 0) + 1); });
  return [...tally.entries()].map(([k, v]) => (v > 1 ? `${k} ×${v}` : k)).join(", ");
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
  const rawItems = pick(order, ["lineItems", "items", "catalogItems"]) || [];
  const items: string[] = (Array.isArray(rawItems) ? rawItems : []).flatMap((li: Rec) => {
    const nm = String(li?.productName?.original ?? li?.productName ?? li?.name ?? li?.title ?? "").trim();
    const qty = parseInt(String(li?.quantity ?? 1), 10) || 1;
    return nm ? Array(qty).fill(nm) : [];
  });
  // Invoice lines keep quantity and unit price, unlike `items` above which
  // flattens to repeated names for the collector's pieces column.
  const invLines = (Array.isArray(rawItems) ? rawItems : []).map((li: Rec) => ({
    desc: String(li?.productName?.original ?? li?.productName ?? li?.name ?? li?.title ?? "").trim(),
    qty: parseInt(String(li?.quantity ?? 1), 10) || 1,
    unit: moneyToNumber(pick(li, ["price.amount", "price", "priceData.price", "unitPrice", "priceData.discountedPrice"])),
  })).filter((l) => l.desc);
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

  const H = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" };

  // Idempotency: skip orders we've already applied (webhook retries, duplicate automations)
  if (orderId) {
    const dup = await fetch(`${SUPABASE_URL}/rest/v1/processed_orders?id=eq.${encodeURIComponent(orderId)}&select=id`, { headers: H });
    if (dup.ok && (await dup.json()).length) return ok({ status: "duplicate ignored", orderId });
  }

  // Find the collector: by this address, or by one of the other addresses on
  // their record. A record folded into another stands for that other one.
  const orClause = encodeURIComponent(`(email.ilike.${email},alt_emails.cs.{${email}})`);
  const find = await fetch(`${SUPABASE_URL}/rest/v1/collectors?or=${orClause}&select=*`, { headers: H });
  if (!find.ok) return ok({ error: "lookup failed: " + (await find.text()) }, 502);
  let existing: Rec | undefined = (await find.json())[0];
  if (existing?.merged_into) {
    const into = await fetch(`${SUPABASE_URL}/rest/v1/collectors?acc=eq.${encodeURIComponent(existing.merged_into)}&select=*`, { headers: H });
    if (into.ok) existing = (await into.json())[0] || existing;
  }
  // An unfamiliar address may still be someone we know. Look among people with
  // the same surname for proof (phone, or postcode with street or first name).
  let matched = "", possible: Rec | undefined;
  if (!existing && surname(name)) {
    const cand = await fetch(
      `${SUPABASE_URL}/rest/v1/collectors?name=ilike.${encodeURIComponent("*" + surname(name))}` +
      `&select=acc,name,email,alt_emails,phone,postcode,address,location,merged_into`, { headers: H });
    const people: Person[] = cand.ok ? await cand.json() : [];
    const m = matchPerson({ name, phone, postcode, address: street, city }, people);
    if (m?.kind === "verified") {
      const full = await fetch(`${SUPABASE_URL}/rest/v1/collectors?acc=eq.${encodeURIComponent(m.person.acc)}&select=*`, { headers: H });
      if (full.ok) { existing = (await full.json())[0]; matched = m.why; }
    } else if (m?.kind === "possible") possible = m.person as Rec;
  }

  let rec: Rec;
  if (existing) {
    const ltv = Math.round((moneyToNumber(existing.ltv) + total) * 100) / 100;
    rec = {
      ltv,
      pieces: tallyPieces(existing.pieces || "", items),
      last_buy: date,
      first_buy: existing.first_buy || date,
      location: existing.location || [city, country].filter(Boolean).join(", "),
      phone: existing.phone || phone,
      name: existing.name || name,
      first_look: existing.first_look || ltv > 1000,
      address: existing.address || street || null,
      postcode: existing.postcode || postcode || null,
      // bought from an address that is not yet on their record: keep it
      alt_emails: email !== String(existing.email || "").toLowerCase()
        ? [...new Set([...(existing.alt_emails || []), email])] : (existing.alt_emails || []),
    };
    const upd = await fetch(`${SUPABASE_URL}/rest/v1/collectors?acc=eq.${encodeURIComponent(existing.acc)}`, {
      method: "PATCH", headers: H, body: JSON.stringify(rec),
    });
    if (!upd.ok) return ok({ error: "update failed: " + (await upd.text()) }, 502);
  } else {
    // next M-xxx account number
    const accs = await fetch(`${SUPABASE_URL}/rest/v1/collectors?select=acc`, { headers: H });
    let max = 0;
    if (accs.ok) for (const r of await accs.json()) { const m = /M-(\d+)/.exec(r.acc || ""); if (m) max = Math.max(max, +m[1]); }
    rec = {
      acc: "M-" + String(max + 1).padStart(3, "0"),
      email, name, phone,
      pieces: tallyPieces("", items),
      ltv: Math.round(total * 100) / 100,
      location: [city, country].filter(Boolean).join(", "),
      gift_self: "Self", signal: "Med", story: "Asked",
      first_look: total > 1000,
      first_buy: date, last_buy: date,
      address: street || null, postcode: postcode || null,
      // Nothing proves it, but it may well be someone we know: say who, and let
      // a person decide rather than merging on a guess.
      notes: possible
        ? `Possibly the same person as ${possible.acc} (${possible.name}): ${"same surname and town, first names fit"}. Merge them if so.`
        : null,
    };
    const ins = await fetch(`${SUPABASE_URL}/rest/v1/collectors`, { method: "POST", headers: H, body: JSON.stringify(rec) });
    if (!ins.ok) return ok({ error: "insert failed: " + (await ins.text()) }, 502);
  }

  if (orderId) {
    await fetch(`${SUPABASE_URL}/rest/v1/processed_orders`, {
      method: "POST", headers: { ...H, Prefer: "resolution=ignore-duplicates" },
      body: JSON.stringify({ id: orderId, email, total, applied_at: new Date().toISOString() }),
    });
  }

  // Retail invoice, written silently. Tax and shipping ride as line items rather
  // than percentages so the printed total can never disagree with what Wix
  // actually charged. The unique index on order_ref makes retries harmless.
  if (invLines.length) {
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/rpc/new_invoice`, {
        method: "POST", headers: H,
        body: JSON.stringify({ p: {
          kind: "retail", issued_on: date, bill_to: name || email, bill_email: email,
          bill_addr: [city, country].filter(Boolean).join(", "),
          items: invLines, discount_pct: 0, tax_pct: 0,
          order_ref: orderId || null,
        } }),
      });
    } catch (_e) { /* an invoice must never cost us the collector update */ }
  }

  return ok({
    status: existing ? (matched ? "matched" : "updated") : (possible ? "created, possibly " + possible.acc : "created"),
    acc: rec.acc ?? existing?.acc, email, total, items: items.length, orderId, ...(matched ? { why: matched } : {}),
  });
});
