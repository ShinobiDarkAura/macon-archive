// Maçon Archive — import orders from a shop's export, safely.
//
// The archive's "Import CSV" button reads a Wix, Big Cartel or Shopify orders
// export in the browser and posts the orders here. Each one goes through the
// same path as a live order webhook (../_shared/orders.ts), so an import can
// never do what the old importer did: overwrite totals, forget a merge, or
// count an order twice.
//   - an order a webhook already applied is skipped, and repaired if the
//     webhook could not read its pieces or write its invoice;
//   - an order no later than the buyer's last recorded purchase is skipped,
//     because an earlier import of their whole history already counted it;
//   - anything else is added on top of what is there.
// POST { orders: Order[], dryRun: true } first to see what would happen, then
// again with dryRun: false to do it. Signed-in keepers only.
//
// DEPLOY WITH --no-verify-jwt: the keeper check below replaces the gateway's.

import { applyOrder, type Order } from "../_shared/orders.ts";
import { keeperEmail } from "../_shared/keepers.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const MAX_ORDERS = 2000;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (!(await keeperEmail(req))) return json({ error: "keepers only" }, 401);

  let b: { orders?: Order[]; dryRun?: boolean };
  try { b = await req.json(); } catch { return json({ error: "not json" }, 400); }
  const orders = Array.isArray(b.orders) ? b.orders : [];
  if (!orders.length) return json({ error: "no orders" }, 400);
  if (orders.length > MAX_ORDERS) return json({ error: `at most ${MAX_ORDERS} orders at a time` }, 413);
  const dryRun = b.dryRun !== false;           // a preview unless asked otherwise

  const URL_ = Deno.env.get("SUPABASE_URL")!, KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const results = [];
  // One at a time and oldest first: account numbers are allocated in order,
  // and a buyer's second order must see what their first one did.
  for (const o of [...orders].sort((a, b) => String(a.date).localeCompare(String(b.date)))) {
    if (!o || !o.email || !o.date) { results.push({ status: "unreadable", orderId: o?.orderId ?? "" }); continue; }
    try {
      const [, r] = await applyOrder(o, URL_, KEY, { dryRun, onlyIfNewer: true, repair: true });
      results.push({ ...r, name: r.name ?? o.name, date: o.date, total: o.total });
    } catch (e) { results.push({ status: "failed", orderId: o.orderId, error: String(e) }); }
  }
  return json({ dryRun, results });
});
