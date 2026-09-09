// Maçon — reads the studio mailboxes for the Letters view.
//
// A Google service account with domain-wide delegation acts as each mailbox in
// turn; its key lives here as a secret and never reaches a browser. The app
// sends a keeper's Supabase session, a Gmail API path and which mailbox to
// read; this verifies the keeper, mints a token for that box, and forwards the
// read. GET only, users/me only, and only mailboxes on the allowlist.
//
// Secrets: GOOGLE_SA_EMAIL, GOOGLE_SA_KEY (PEM private key), GMAIL_USERS

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY     = Deno.env.get("SUPABASE_ANON_KEY")!;
const SA_EMAIL     = Deno.env.get("GOOGLE_SA_EMAIL")!;
const SA_KEY       = Deno.env.get("GOOGLE_SA_KEY")!;
// Which mailboxes this function may act as. Domain-wide delegation is granted
// across the domain in one step, so adding a mailbox here is all it takes.
const MAILBOXES = (Deno.env.get("GMAIL_USERS") || "hello@studiomacon.co,hannah@studiomacon.co")
  .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const KEEPERS      = ["alex@studiomacon.co", "hannah@studiomacon.co"];
const SCOPE        = "https://www.googleapis.com/auth/gmail.readonly";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

async function keeperEmail(req: Request): Promise<string | null> {
  const auth = req.headers.get("authorization") || "";
  if (!auth.startsWith("Bearer ")) return null;
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: ANON_KEY, Authorization: auth } });
  if (!r.ok) return null;
  const u = await r.json();
  return KEEPERS.includes(String(u.email || "").toLowerCase()) ? u.email : null;
}

const b64url = (b: ArrayBuffer | string) => {
  const bytes = typeof b === "string" ? new TextEncoder().encode(b) : new Uint8Array(b);
  let s = ""; for (const c of bytes) s += String.fromCharCode(c);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

let _key: CryptoKey | null = null;
async function signingKey(): Promise<CryptoKey> {
  if (_key) return _key;
  const pem = SA_KEY.replace(/\\n/g, "\n").replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(pem), c => c.charCodeAt(0));
  _key = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  return _key;
}

// Cached per mailbox for the isolate's life; Google tokens last an hour.
const _tok = new Map<string, { value: string; exp: number }>();
async function gmailToken(mailbox: string): Promise<string> {
  const hit = _tok.get(mailbox);
  if (hit && Date.now() < hit.exp - 60_000) return hit.value;
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({ iss: SA_EMAIL, sub: mailbox, scope: SCOPE,
    aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 }));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", await signingKey(), new TextEncoder().encode(`${header}.${claims}`));
  const assertion = `${header}.${claims}.${b64url(sig)}`;
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }) });
  const j = await r.json();
  if (!r.ok || !j.access_token) throw new Error("google token: " + (j.error_description || j.error || r.status));
  const tok = { value: j.access_token, exp: Date.now() + (Number(j.expires_in) || 3600) * 1000 };
  _tok.set(mailbox, tok);
  return tok.value;
}

const ALLOWED = /^(messages|threads)(\/[A-Za-z0-9_-]+)?(\?[^#]*)?$/;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "GET") return new Response("GET only", { status: 405, headers: cors });
  try {
    const who = await keeperEmail(req);
    if (!who) return new Response(JSON.stringify({ error: "keepers only" }), { status: 401, headers: { ...cors, "Content-Type": "application/json" } });
    if (new URL(req.url).searchParams.get("list") === "mailboxes") {
      return new Response(JSON.stringify({ mailboxes: MAILBOXES }), { status: 200, headers: { ...cors, "Content-Type": "application/json" } });
    }
    const url = new URL(req.url);
    const path = url.searchParams.get("path") || "";
    if (!ALLOWED.test(path)) return new Response(JSON.stringify({ error: "path not allowed" }), { status: 400, headers: { ...cors, "Content-Type": "application/json" } });
    // "mailboxes" with no path lets the app ask which boxes it may read.
    const asked = (url.searchParams.get("mailbox") || MAILBOXES[0]).toLowerCase();
    if (!MAILBOXES.includes(asked)) return new Response(JSON.stringify({ error: "mailbox not allowed" }), { status: 400, headers: { ...cors, "Content-Type": "application/json" } });
    const g = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, { headers: { Authorization: `Bearer ${await gmailToken(asked)}` } });
    const body = await g.text();
    return new Response(body, { status: g.status, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String((e as Error).message || e) }), { status: 500, headers: { ...cors, "Content-Type": "application/json" } });
  }
});
