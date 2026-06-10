// Maçon Archive — Wix order webhook
// Receives "order placed" webhooks from a Wix Automation and upserts the collector:
// new email -> new collector; existing email -> piece added, LTV incremented (once
// per order), last_buy refreshed. See ../../README-wix-webhook.md for setup.
//
// Secrets (supabase secrets set ...):
//   WIX_WEBHOOK_SECRET   shared secret; the webhook URL must include ?secret=<value>

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

  const H = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" };

  // Idempotency: skip orders we've already applied (webhook retries, duplicate automations)
  if (orderId) {
    const dup = await fetch(`${SUPABASE_URL}/rest/v1/processed_orders?id=eq.${encodeURIComponent(orderId)}&select=id`, { headers: H });
    if (dup.ok && (await dup.json()).length) return ok({ status: "duplicate ignored", orderId });
  }

  // Find the collector by email (case-insensitive)
  const find = await fetch(`${SUPABASE_URL}/rest/v1/collectors?email=ilike.${encodeURIComponent(email)}&select=*`, { headers: H });
  if (!find.ok) return ok({ error: "lookup failed: " + (await find.text()) }, 502);
  const existing: Rec | undefined = (await find.json())[0];

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

  return ok({ status: existing ? "updated" : "created", acc: rec.acc ?? existing?.acc, email, total, items: items.length, orderId });
});
