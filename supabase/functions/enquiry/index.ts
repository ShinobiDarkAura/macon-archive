// Maçon Archive — enquiry webhook
//
// Point the studiomacon.co contact form at this and every enquiry lands in
// public.inquiries as a warm lead, the same way wix-order lands a purchase.
// Nothing is retyped and nothing is missed because someone was busy that day.
//
// Secrets (supabase secrets set ...):
//   ENQUIRY_WEBHOOK_SECRET   shared secret; the URL must carry ?secret=<value>
//
// Wix: Automations → When a form is submitted → Send via webhook, POST to
//   https://<project>.supabase.co/functions/v1/enquiry?secret=<value>
//
// Accepts whatever shape the form sends: it walks the payload for anything that
// looks like a name, an address and a message rather than demanding a schema.

type Rec = Record<string, any>;

const ok = (body: Rec, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

// Depth-first search for the first value whose key matches, so a form field
// buried under submissions[0].fields.email is still found.
function findBy(obj: any, patterns: RegExp[], depth = 0): string {
  if (obj == null || depth > 6) return "";
  if (Array.isArray(obj)) {
    for (const v of obj) { const hit = findBy(v, patterns, depth + 1); if (hit) return hit; }
    return "";
  }
  if (typeof obj !== "object") return "";
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "string" && v.trim() && patterns.some((p) => p.test(k))) return v.trim();
  }
  for (const v of Object.values(obj)) {
    const hit = findBy(v, patterns, depth + 1); if (hit) return hit;
  }
  return "";
}

const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.]+/;

Deno.serve(async (req) => {
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const SECRET = Deno.env.get("ENQUIRY_WEBHOOK_SECRET") || "";

  const url = new URL(req.url);
  if (SECRET && url.searchParams.get("secret") !== SECRET) return ok({ error: "bad secret" }, 401);
  if (req.method !== "POST") return ok({ error: "POST an enquiry" }, 405);

  let payload: Rec;
  try { payload = await req.json(); } catch { return ok({ error: "not json" }, 400); }

  const name = findBy(payload, [/^name$/i, /full.?name/i, /first.?name/i, /contact.?name/i, /^from$/i]);
  let email = findBy(payload, [/e-?mail/i, /^from$/i]);
  if (!EMAIL_RE.test(email)) {
    const m = JSON.stringify(payload).match(EMAIL_RE);   // last resort: anywhere in the body
    email = m ? m[0] : "";
  }
  const message = findBy(payload, [/message/i, /body/i, /comment/i, /enquiry/i, /inquiry/i, /details/i, /note/i]);
  const subjectRaw = findBy(payload, [/subject/i, /topic/i, /interested/i, /piece/i, /request/i]);

  if (!email && !name) return ok({ error: "no name or address in payload", keys: Object.keys(payload) }, 422);

  // A short subject for the card: their own words where they gave a subject
  // line, otherwise the opening of the message.
  const subject = (subjectRaw || message.split(/[.\n]/)[0] || "custom enquiry").slice(0, 80).trim();

  const H = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" };

  // One record per person: a second enquiry appends rather than duplicating.
  if (email) {
    const dup = await fetch(
      `${SUPABASE_URL}/rest/v1/inquiries?email=eq.${encodeURIComponent(email)}&select=id,note`, { headers: H });
    const rows: Rec[] = dup.ok ? await dup.json() : [];
    if (rows.length) {
      const today = new Date().toISOString().slice(0, 10);
      const note = `${rows[0].note || ""}\n\n[${today}] wrote in again: ${message || subject}`.trim();
      await fetch(`${SUPABASE_URL}/rest/v1/inquiries?id=eq.${rows[0].id}`, {
        method: "PATCH", headers: H,
        body: JSON.stringify({ note, status: "open" }),   // back on the list
      });
      return ok({ status: "appended", id: rows[0].id, email });
    }
  }

  const ins = await fetch(`${SUPABASE_URL}/rest/v1/inquiries`, {
    method: "POST", headers: { ...H, Prefer: "return=representation" },
    body: JSON.stringify({
      name: name || email.split("@")[0],
      email: email || null,
      subject,
      source: findBy(payload, [/source/i, /form.?name/i]) || "website",
      note: message || null,
      status: "open",
    }),
  });
  if (!ins.ok) return ok({ error: "insert failed: " + (await ins.text()) }, 502);
  const [row] = await ins.json();

  return ok({ status: "created", id: row?.id, name: row?.name, email: row?.email, subject: row?.subject });
});
