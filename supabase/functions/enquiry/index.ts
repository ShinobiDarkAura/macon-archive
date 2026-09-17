// Maçon Archive — enquiry webhook
//
// Point the studiomacon.co contact form at this and every enquiry lands in
// public.inquiries as a warm lead, the same way wix-order lands a purchase.
// Nothing is retyped and nothing is missed because someone was busy that day.
//
// Secrets (supabase secrets set ...):
//   ENQUIRY_WEBHOOK_SECRET   shared secret; the URL must carry ?secret=<value>
//   RESEND_API_KEY           optional: turns on the two emails below
//   ENQUIRY_FROM             sender, e.g. "Studio Maçon <hello@studiomacon.co>" (domain verified in Resend)
//   ENQUIRY_NOTIFY           comma-separated inboxes told about each enquiry:
//                            "hello@studiomacon.co,alex@studiomacon.co,hannah@studiomacon.co"
//   ENQUIRY_ORIGINS          comma-separated sites allowed to post from a browser, e.g.
//                            "https://studiomacon.co,https://www.studiomacon.co,http://localhost:3470"
//
// New website (pdp/contact.html, pdp/custom.html) posts JSON straight from the browser:
//   { form: "contact" | "commission", name, email, message, subject?, details?: {...}, company? (honeypot) }
// On success: the enquiry is saved, the studio inbox gets a copy, and the sender gets a short
// "we've got your message" reply.
//
// Wix: Automations → When a form is submitted → Send via webhook, POST to
//   https://<project>.supabase.co/functions/v1/enquiry?secret=<value>
//
// Accepts whatever shape the form sends: it walks the payload for anything that
// looks like a name, an address and a message rather than demanding a schema.

type Rec = Record<string, any>;

let CORS: Record<string, string> = {};
const ok = (body: Rec, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...CORS } });

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

type Attachment = { filename: string; content: string };

async function sendMail(to: string[], subject: string, html: string, replyTo?: string, attachments?: Attachment[]) {
  const key = Deno.env.get("RESEND_API_KEY");
  const from = Deno.env.get("ENQUIRY_FROM");
  if (!key || !from || !to.length) return false;
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to, subject, html, ...(replyTo ? { reply_to: replyTo } : {}),
      ...(attachments && attachments.length ? { attachments } : {}) }),
  });
  if (r.status === 429) {                       // Resend allows two sends a second; the studio copy goes first
    await new Promise((f) => setTimeout(f, 1200));
    return sendMail(to, subject, html, replyTo, attachments);
  }
  if (!r.ok) console.error("resend refused the email:", r.status, await r.text());
  return r.ok;
}

// The two emails every enquiry sends: a copy to the studio, a short thank-you to the sender.
async function notify(kind: string, name: string, email: string, subject: string, message: string, details: Rec, photos?: Attachment[]) {
  const inbox = (Deno.env.get("ENQUIRY_NOTIFY") || "").split(",").map((s) => s.trim()).filter(Boolean);
  const rows = Object.entries(details || {}).filter(([, v]) => v !== "" && v != null)
    .map(([k, v]) => `<tr><td style="padding:2px 12px 2px 0;color:#777;font-size:11px;letter-spacing:.08em;text-transform:uppercase;white-space:nowrap;vertical-align:top">${esc(k)}</td><td style="vertical-align:top">${esc(String(v))}</td></tr>`).join("");
  const label = kind === "commission" ? "Commission request" : "Message";
  await sendMail(inbox, `${label} from ${name || email}: ${subject}`,
    `<p><b>${esc(name || "")}</b> &lt;${esc(email || "")}&gt;</p><p>${esc(message || "").replace(/\n/g, "<br>")}</p>` +
    (rows ? `<table style="font-size:14px">${rows}</table>` : "") +
    (photos && photos.length ? `<p style="font-size:14px;color:#777">${photos.length} photo${photos.length > 1 ? "s" : ""} attached.</p>` : ""),
    email || undefined, photos);
  if (email) {
    const first = (name || "").split(" ")[0];
    const body = kind === "commission"
      ? "Thanks for reaching out! We've got your commission request and will write back as soon as we can with next steps. If there's anything else you need, feel free to reply directly to this email."
      : "Thanks for reaching out! We've got your message and will write back as soon as we can. If there's anything else you need, feel free to reply directly to this email.";
    await sendMail([email], "We've got your message",
      `<p>${first ? "Hey " + esc(first) + "," : "Hey,"}</p><p>${body}</p><p>Quite sincerely,<br>Alex-Bot 🤖<br><a href="https://studiomacon.co">studiomacon.co</a></p>`);
  }
}

// Reference photos arrive as base64 already shrunk by the browser. Anything oversized,
// mistyped or beyond the first six is dropped rather than risking a refused send.
function readPhotos(raw: unknown): Attachment[] {
  if (!Array.isArray(raw)) return [];
  const out: Attachment[] = [];
  let bytes = 0;
  for (const p of raw.slice(0, 6)) {
    const content = typeof p?.content === "string" ? p.content.replace(/^data:[^,]*,/, "") : "";
    if (!content || !/^[A-Za-z0-9+/=]+$/.test(content)) continue;
    bytes += content.length * 0.75;
    if (bytes > 12_000_000) break;                       // Resend refuses much beyond this
    const name = String(p?.filename || "photo").replace(/[^\w.\-]/g, "").slice(0, 60) || "photo";
    out.push({ filename: /\.\w{2,5}$/.test(name) ? name : name + ".jpg", content });
  }
  return out;
}

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

  const origin = req.headers.get("origin") || "";
  const allowed = (Deno.env.get("ENQUIRY_ORIGINS") || "").split(",").map((s) => s.trim()).filter(Boolean);
  CORS = allowed.includes(origin)
    ? { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "content-type", Vary: "Origin" }
    : {};
  if (req.method === "OPTIONS") return new Response(null, { status: allowed.includes(origin) ? 204 : 403, headers: CORS });

  const url = new URL(req.url);
  // browsers on an allowed site don't need the secret (it would be visible in the page); everyone else does
  if (SECRET && url.searchParams.get("secret") !== SECRET && !allowed.includes(origin)) return ok({ error: "bad secret" }, 401);
  if (req.method !== "POST") return ok({ error: "POST an enquiry" }, 405);

  let payload: Rec;
  try { payload = await req.json(); } catch { return ok({ error: "not json" }, 400); }
  if (typeof payload.company === "string" && payload.company.trim()) return ok({ status: "ok" });   // honeypot: bots fill hidden fields
  const kind = payload.form === "commission" ? "commission" : "contact";
  const details: Rec = payload.details && typeof payload.details === "object" ? payload.details : {};
  const photos = readPhotos(payload.photos);

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
      await notify(kind, name, email, subject, message, details, photos);
      return ok({ status: "appended", id: rows[0].id, email });
    }
  }

  const ins = await fetch(`${SUPABASE_URL}/rest/v1/inquiries`, {
    method: "POST", headers: { ...H, Prefer: "return=representation" },
    body: JSON.stringify({
      name: name || email.split("@")[0],
      email: email || null,
      subject,
      source: payload.form ? `website ${kind}` : (findBy(payload, [/source/i, /form.?name/i]) || "website"),
      note: [message, ...Object.entries(details).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`)].filter(Boolean).join("\n") || null,
      status: "open",
    }),
  });
  if (!ins.ok) return ok({ error: "insert failed: " + (await ins.text()) }, 502);
  const [row] = await ins.json();

  await notify(kind, name, email, subject, message, details, photos);
  return ok({ status: "created", id: row?.id, name: row?.name, email: row?.email, subject: row?.subject });
});
