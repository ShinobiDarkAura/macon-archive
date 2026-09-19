// Maçon Archive — newsletter sign-up
//
// The website's footer posts { email } here, and the address becomes a Shopify customer subscribed to
// email marketing. That is what Shopify Email's welcome automation listens for. (Shopify's own newsletter
// form cannot be used from the custom site: it demands a captcha.)
//
// Secrets (supabase secrets set ...):
//   SHOPIFY_SHOP          w3nidi-ny.myshopify.com
//   SHOPIFY_ADMIN_TOKEN   Admin API token from a custom app with the write_customers scope
//   ENQUIRY_ORIGINS       the same allowed-sites list the enquiry function uses
//
// Replies { ok: true } once subscribed, { ok: false, reason } otherwise. Until the token is set it replies
// 503, and the website quietly falls back to the old Klaviyo sign-up so no one is lost.

let CORS: Record<string, string> = {};
const reply = (body: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...CORS } });

async function admin(query: string, variables: Record<string, unknown>) {
  const shop = Deno.env.get("SHOPIFY_SHOP"), token = Deno.env.get("SHOPIFY_ADMIN_TOKEN");
  const r = await fetch(`https://${shop}/admin/api/2025-07/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token! },
    body: JSON.stringify({ query, variables }),
  });
  return r.json();
}

const CONSENT = { marketingState: "SUBSCRIBED", marketingOptInLevel: "SINGLE_OPT_IN" };

Deno.serve(async (req) => {
  const allowed = (Deno.env.get("ENQUIRY_ORIGINS") || "").split(",").map((s) => s.trim()).filter(Boolean);
  const origin = req.headers.get("origin") || "";
  CORS = allowed.includes(origin)
    ? { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "content-type" }
    : {};
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return reply({ ok: false, reason: "post only" }, 405);
  if (origin && !allowed.includes(origin)) return reply({ ok: false, reason: "unknown site" }, 403);
  if (!Deno.env.get("SHOPIFY_ADMIN_TOKEN") || !Deno.env.get("SHOPIFY_SHOP")) return reply({ ok: false, reason: "not configured" }, 503);

  let email = "";
  try { email = String((await req.json()).email || "").trim().toLowerCase(); } catch { /* fall through */ }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return reply({ ok: false, reason: "that address does not look right" }, 400);

  // a new customer, subscribed from the start
  const made = await admin(
    `mutation($input: CustomerInput!) { customerCreate(input: $input) { customer { id } userErrors { field message } } }`,
    { input: { email, emailMarketingConsent: CONSENT, tags: ["newsletter", "website-footer"] } },
  );
  const errs = made?.data?.customerCreate?.userErrors || [];
  if (made?.data?.customerCreate?.customer) return reply({ ok: true });

  // already a customer (they bought, or wrote in): switch their email marketing on
  if (errs.some((e: { message: string }) => /taken/i.test(e.message))) {
    const found = await admin(`query($q: String!) { customers(first: 1, query: $q) { nodes { id } } }`, { q: `email:${email}` });
    const id = found?.data?.customers?.nodes?.[0]?.id;
    if (id) {
      const upd = await admin(
        `mutation($input: CustomerEmailMarketingConsentUpdateInput!) {
           customerEmailMarketingConsentUpdate(input: $input) { userErrors { message } } }`,
        { input: { customerId: id, emailMarketingConsent: { ...CONSENT, consentUpdatedAt: new Date().toISOString() } } },
      );
      if (!(upd?.data?.customerEmailMarketingConsentUpdate?.userErrors || []).length) return reply({ ok: true });
    }
  }
  console.error("subscribe failed:", JSON.stringify(made));
  return reply({ ok: false, reason: "could not subscribe" }, 502);
});
