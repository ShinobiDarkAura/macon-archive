// Maçon Archive — what happens when someone buys, wherever they bought.
//
// Each shop's webhook (wix-order, shopify-order) only reads its own payload into
// an Order. Everything after that is here, so the two can never disagree about
// who a buyer is: the order is applied once, joined to the collector it belongs
// to (by any address on their record, or proven by identity.ts), and written as
// a retail invoice.

import { matchPerson, surname, type Person } from "./identity.ts";
import { enquiryVerdict, isTradeOrder, type Enquiry } from "./settle.ts";

type Rec = Record<string, any>;

export type InvoiceLine = { desc: string; qty: number; unit: number };
export type Order = {
  orderId: string;         // unique across shops: "shopify:…" for Shopify
  email: string; name: string; phone: string;
  street: string; postcode: string; city: string; country: string;
  total: number; items: string[]; lines: InvoiceLine[];
  date: string;            // YYYY-MM-DD
  ref?: string;            // how a person names it: "#10123", "#1001"
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

export type ApplyOptions = {
  /** Work out what would happen and write nothing. */
  dryRun?: boolean;
  /** For imports: an order no later than the buyer's last recorded purchase
   *  was already counted, by an earlier import of their whole history. */
  onlyIfNewer?: boolean;
  /** For imports: an order a webhook already applied gets the invoice, and the
   *  pieces if the record has none, that the webhook could not read. The money
   *  is never counted twice. */
  repair?: boolean;
};

const dayOf = (v: unknown) => {
  const s = String(v ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const t = Date.parse(s);
  return isNaN(t) ? "" : new Date(t).toISOString().slice(0, 10);
};

/** Apply one order to the archive. Returns [status, body] for the caller to send back. */
export async function applyOrder(o: Order, SUPABASE_URL: string, SERVICE_KEY: string, opts: ApplyOptions = {}): Promise<[number, Rec]> {
  const { orderId, email, name, phone, street, postcode, city, country, total, items, date } = o;
  const H = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" };
  const write = !opts.dryRun;

  // Idempotency: skip orders we've already applied (webhook retries, duplicate automations)
  let processed = false;
  if (orderId) {
    const dup = await fetch(`${SUPABASE_URL}/rest/v1/processed_orders?id=eq.${encodeURIComponent(orderId)}&select=id`, { headers: H });
    processed = dup.ok && (await dup.json()).length > 0;
    if (processed && !opts.repair) return [200, { status: "duplicate ignored", orderId }];
  }

  // Find the collector: by this address, or by one of the other addresses on
  // their record. A record folded into another stands for that other one.
  // Emails are stored lowercase (a trigger sees to it), so this is an exact
  // match; a pattern match would let "_" in an address stand for any letter.
  const orClause = encodeURIComponent(`(email.eq.${email},alt_emails.cs.{${email}})`);
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

  // Already applied by a webhook: only fill in what it could not read.
  if (processed) {
    if (!existing) return [200, { status: "already in the archive", orderId }];
    const inv = await fetch(`${SUPABASE_URL}/rest/v1/invoices?order_ref=eq.${encodeURIComponent(orderId)}&select=id`, { headers: H });
    const needInvoice = o.lines.length > 0 && inv.ok && (await inv.json()).length === 0;
    const needPieces = items.length > 0 && !String(existing.pieces || "").trim();
    const after = await settleAfter(o, existing, SUPABASE_URL, H, write);
    if (!needInvoice && !needPieces) return [200, { status: "already in the archive", acc: existing.acc, orderId, ...after }];
    if (write) {
      if (needPieces) await fetch(`${SUPABASE_URL}/rest/v1/collectors?acc=eq.${encodeURIComponent(existing.acc)}`, {
        method: "PATCH", headers: H, body: JSON.stringify({ pieces: tallyPieces("", items) }) });
      if (needInvoice) await writeInvoice(o, SUPABASE_URL, H);
    }
    return [200, { status: write ? "repaired" : "would repair", acc: existing.acc, orderId,
      filled: [needInvoice ? "invoice" : "", needPieces ? "pieces" : ""].filter(Boolean), ...after }];
  }
  // An earlier import of their whole history already counted this one.
  if (opts.onlyIfNewer && existing && dayOf(existing.last_buy) && dayOf(existing.last_buy) >= date)
    return [200, { status: "already counted", acc: existing.acc, orderId, last_buy: dayOf(existing.last_buy) }];
  if (!write) return [200, {
    status: existing ? (matched ? "would match" : "would add") : (possible ? "would create, possibly " + possible.acc : "would create"),
    acc: existing?.acc ?? null, name: existing?.name ?? name, email, total, orderId, ...(matched ? { why: matched } : {}),
    ...(await settleAfter(o, existing, SUPABASE_URL, H, false)) }];

  // Claim the order before any money moves. processed_orders is keyed by the
  // order, so a second delivery of it, however close behind the first, is
  // turned away here by the database rather than counted twice.
  if (orderId) {
    const claim = await fetch(`${SUPABASE_URL}/rest/v1/processed_orders`, {
      method: "POST", headers: { ...H, Prefer: "return=minimal" },
      body: JSON.stringify({ id: orderId, email, total, applied_at: new Date().toISOString() }),
    });
    if (claim.status === 409) return [200, { status: "duplicate ignored", orderId }];
    if (!claim.ok) return [502, { error: "could not claim the order: " + (await claim.text()) }];
  }
  // If what follows fails, give the claim back so the shop's retry can apply it.
  const unclaim = async () => { if (orderId) await fetch(
    `${SUPABASE_URL}/rest/v1/processed_orders?id=eq.${encodeURIComponent(orderId)}`, { method: "DELETE", headers: H }); };

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
    if (!upd.ok) { const e = await upd.text(); await unclaim(); return [502, { error: "update failed: " + e }]; }
  } else {
    // next M-xxx account number
    const nextAcc = async () => {
      const accs = await fetch(`${SUPABASE_URL}/rest/v1/collectors?select=acc`, { headers: H });
      let max = 0;
      if (accs.ok) for (const r of await accs.json()) { const m = /M-(\d+)/.exec(r.acc || ""); if (m) max = Math.max(max, +m[1]); }
      return "M-" + String(max + 1).padStart(3, "0");
    };
    rec = {
      acc: await nextAcc(),
      email, name, phone,
      pieces: tallyPieces("", items),
      ltv: Math.round(total * 100) / 100,
      location: [city, country].filter(Boolean).join(", "),
      gift_self: "Self", signal: "Med", story: "Asked",
      first_look: total > 1000,
      first_buy: date, last_buy: date,
      address: street || null, postcode: postcode || null,
      trade: isTradeOrder(items),
      // Nothing proves it, but it may well be someone we know: say who, and let
      // a person decide rather than merging on a guess.
      notes: possible
        ? `Possibly the same person as ${possible.acc} (${possible.name}): same surname and town, first names fit. Merge them if so.`
        : null,
    };
    // Account numbers are unique in the table. If another new buyer took this
    // one a moment ago, the insert is refused; take the next and try again.
    let ins = await fetch(`${SUPABASE_URL}/rest/v1/collectors`, { method: "POST", headers: H, body: JSON.stringify(rec) });
    for (let tries = 0; ins.status === 409 && tries < 4; tries++) {
      rec.acc = await nextAcc();
      ins = await fetch(`${SUPABASE_URL}/rest/v1/collectors`, { method: "POST", headers: H, body: JSON.stringify(rec) });
    }
    if (!ins.ok) { const e = await ins.text(); await unclaim(); return [502, { error: "insert failed: " + e }]; }
  }


  if (o.lines.length) await writeInvoice(o, SUPABASE_URL, H);
  const after = await settleAfter(o, existing ?? rec, SUPABASE_URL, H, true);

  return [200, {
    status: existing ? (matched ? "matched" : "updated") : (possible ? "created, possibly " + possible.acc : "created"),
    acc: rec.acc ?? existing?.acc, email, total, items: items.length, orderId, ...(matched ? { why: matched } : {}), ...after,
  }];
}

// Retail invoice, written silently. Tax and shipping ride as line items rather
// than percentages so the printed total can never disagree with what the shop
// actually charged. The unique index on order_ref makes retries harmless.
async function writeInvoice(o: Order, SUPABASE_URL: string, H: Record<string, string>) {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/new_invoice`, {
      method: "POST", headers: H,
      body: JSON.stringify({ p: {
        kind: "retail", issued_on: o.date, bill_to: o.name || o.email, bill_email: o.email,
        bill_addr: [o.street, o.city, o.postcode, o.country].filter(Boolean).join(", "),
        items: o.lines, discount_pct: 0, tax_pct: 0,
        order_ref: o.orderId || null,
      } }),
    });
    // Logged, never thrown: an invoice must never cost us the collector update.
    if (!r.ok) console.error("invoice not written", o.orderId, r.status, await r.text());
  } catch (e) { console.error("invoice not written", o.orderId, String(e)); }
}

/** What this order settles: a trade buyer is marked as one, and an open
 *  enquiry from the same person is closed when the order answers it, or noted
 *  when they bought something else. Safe to run again for the same order. */
async function settleAfter(o: Order, person: Rec | undefined, SUPABASE_URL: string, H: Record<string, string>, write: boolean) {
  const out: Rec = {};
  const label = o.ref || (o.orderId && !o.orderId.includes(":") ? "#" + o.orderId : "a shop order");
  const what = [...new Set(o.items)].join(", ") || "an order";
  if (isTradeOrder(o.items)) out.trade = true;          // reported whether new or not
  if (person?.acc && isTradeOrder(o.items) && !person.trade) {
    if (write) await fetch(`${SUPABASE_URL}/rest/v1/collectors?acc=eq.${encodeURIComponent(person.acc)}`, {
      method: "PATCH", headers: H, body: JSON.stringify({ trade: true }) });
  }
  const emails = [...new Set([o.email, person?.email, ...(person?.alt_emails || [])]
    .map((e) => String(e || "").trim().toLowerCase()).filter(Boolean))];
  if (!emails.length) return out;
  const list = encodeURIComponent(`(${emails.map((e) => `"${e.replace(/"/g, "")}"`).join(",")})`);
  const r = await fetch(`${SUPABASE_URL}/rest/v1/inquiries?email=in.${list}&status=neq.closed` +
    `&select=id,name,status,source,subject,note,first_seen`, { headers: H });
  const enquiries: (Enquiry & { name?: string })[] = r.ok ? await r.json() : [];
  const settled: Rec[] = [];
  for (const q of enquiries) {
    const v = enquiryVerdict(q, o.items, o.date);
    if (v === "converted") {
      settled.push({ enquiry: q.name || q.subject, closed: true });
      if (write) await fetch(`${SUPABASE_URL}/rest/v1/inquiries?id=eq.${encodeURIComponent(q.id)}`, {
        method: "PATCH", headers: H, body: JSON.stringify({ status: "closed", last_touched: o.date,
          outcome: `Became an order: ${what} (${label}, $${Math.round(o.total).toLocaleString("en-US")}, ${o.date}).` }) });
    } else if (v === "bought-else") {
      const line = `[${o.date}] Bought ${what} (${label}).`;
      if (String(q.note || "").includes(`(${label})`)) continue;               // already noted
      settled.push({ enquiry: q.name || q.subject, noted: true });
      if (write) await fetch(`${SUPABASE_URL}/rest/v1/inquiries?id=eq.${encodeURIComponent(q.id)}`, {
        method: "PATCH", headers: H, body: JSON.stringify({ note: (q.note ? q.note + "\n\n" : "") + line }) });
    }
  }
  if (settled.length) out.enquiries = settled;
  return out;
}
