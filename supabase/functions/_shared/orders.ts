// Maçon Archive — what happens when someone buys, wherever they bought.
//
// Each shop's webhook (wix-order, shopify-order) only reads its own payload into
// an Order. Everything after that is here, so the two can never disagree about
// who a buyer is: the order is applied once, joined to the collector it belongs
// to (by any address on their record, or proven by identity.ts), and written as
// a retail invoice.

import { matchPerson, surname, type Person } from "./identity.ts";

type Rec = Record<string, any>;

export type InvoiceLine = { desc: string; qty: number; unit: number };
export type Order = {
  orderId: string;         // unique across shops: "shopify:…" for Shopify
  email: string; name: string; phone: string;
  street: string; postcode: string; city: string; country: string;
  total: number; items: string[]; lines: InvoiceLine[];
  date: string;            // YYYY-MM-DD
};

export function tallyPieces(existing: string, newItems: string[]): string {
  const tally = new Map<string, number>();
  (existing || "").split(",").map((s) => s.trim()).filter(Boolean).forEach((tok) => {
    const m = /^(.*?)\s*[×x](\d+)$/.exec(tok);
    if (m) tally.set(m[1].trim(), (tally.get(m[1].trim()) || 0) + parseInt(m[2], 10));
    else tally.set(tok, (tally.get(tok) || 0) + 1);
  });
  newItems.forEach((it) => { const k = it.trim(); if (k) tally.set(k, (tally.get(k) || 0) + 1); });
  return [...tally.entries()].map(([k, v]) => (v > 1 ? `${k} ×${v}` : k)).join(", ");
}

/** Apply one order to the archive. Returns [status, body] for the webhook to send back. */
export async function applyOrder(o: Order, SUPABASE_URL: string, SERVICE_KEY: string): Promise<[number, Rec]> {
  const { orderId, email, name, phone, street, postcode, city, country, total, items, date } = o;
  const H = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" };

  // Idempotency: skip orders we've already applied (webhook retries, duplicate automations)
  if (orderId) {
    const dup = await fetch(`${SUPABASE_URL}/rest/v1/processed_orders?id=eq.${encodeURIComponent(orderId)}&select=id`, { headers: H });
    if (dup.ok && (await dup.json()).length) return [200, { status: "duplicate ignored", orderId }];
  }

  // Find the collector: by this address, or by one of the other addresses on
  // their record. A record folded into another stands for that other one.
  const orClause = encodeURIComponent(`(email.ilike.${email},alt_emails.cs.{${email}})`);
  const find = await fetch(`${SUPABASE_URL}/rest/v1/collectors?or=${orClause}&select=*`, { headers: H });
  if (!find.ok) return [502, { error: "lookup failed: " + (await find.text()) }];
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

  const money = (v: any) => { const n = parseFloat(String(v ?? "").replace(/[^0-9.\-]/g, "")); return isNaN(n) ? 0 : n; };
  let rec: Rec;
  if (existing) {
    const ltv = Math.round((money(existing.ltv) + total) * 100) / 100;
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
    if (!upd.ok) return [502, { error: "update failed: " + (await upd.text()) }];
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
        ? `Possibly the same person as ${possible.acc} (${possible.name}): same surname and town, first names fit. Merge them if so.`
        : null,
    };
    const ins = await fetch(`${SUPABASE_URL}/rest/v1/collectors`, { method: "POST", headers: H, body: JSON.stringify(rec) });
    if (!ins.ok) return [502, { error: "insert failed: " + (await ins.text()) }];
  }

  if (orderId) {
    await fetch(`${SUPABASE_URL}/rest/v1/processed_orders`, {
      method: "POST", headers: { ...H, Prefer: "resolution=ignore-duplicates" },
      body: JSON.stringify({ id: orderId, email, total, applied_at: new Date().toISOString() }),
    });
  }

  // Retail invoice, written silently. Tax and shipping ride as line items rather
  // than percentages so the printed total can never disagree with what the shop
  // actually charged. The unique index on order_ref makes retries harmless.
  if (o.lines.length) {
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/rpc/new_invoice`, {
        method: "POST", headers: H,
        body: JSON.stringify({ p: {
          kind: "retail", issued_on: date, bill_to: name || email, bill_email: email,
          bill_addr: [city, country].filter(Boolean).join(", "),
          items: o.lines, discount_pct: 0, tax_pct: 0,
          order_ref: orderId || null,
        } }),
      });
    } catch (_e) { /* an invoice must never cost us the collector update */ }
  }

  return [200, {
    status: existing ? (matched ? "matched" : "updated") : (possible ? "created, possibly " + possible.acc : "created"),
    acc: rec.acc ?? existing?.acc, email, total, items: items.length, orderId, ...(matched ? { why: matched } : {}),
  }];
}
