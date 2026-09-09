// Maçon — reads the studio mailboxes for the Letters view.
//
// Each mailbox is connected once by signing into it and consenting; Google
// returns a refresh token which is stored server-side and never reaches a
// browser. No service-account key exists, and access covers only the boxes that
// actually consented rather than every mailbox on the domain.
//
// Routes
//   GET  /gmail-reader?path=...&mailbox=...   read Gmail (keepers only)
//   GET  /gmail-reader?action=status          which boxes are connected
//   GET  /gmail-reader?action=connect_url&mailbox=...  a signed consent link
//   GET  /gmail-reader/callback               Google's redirect, no auth header
//
// Secrets: GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, OAUTH_STATE_SECRET

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY     = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CLIENT_ID    = Deno.env.get("GOOGLE_OAUTH_CLIENT_ID")!;
const CLIENT_SECRET= Deno.env.get("GOOGLE_OAUTH_CLIENT_SECRET")!;
const STATE_SECRET = Deno.env.get("OAUTH_STATE_SECRET") || SERVICE_KEY;

const MAILBOXES = (Deno.env.get("GMAIL_USERS") || "hello@studiomacon.co,hannah@studiomacon.co")
  .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const KEEPERS = ["alex@studiomacon.co", "hannah@studiomacon.co"];
const SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const REDIRECT_URI = `${SUPABASE_URL}/functions/v1/gmail-reader/callback`;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" } });

async function keeperEmail(req: Request): Promise<string | null> {
  const auth = req.headers.get("authorization") || "";
  if (!auth.startsWith("Bearer ")) return null;
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: ANON_KEY, Authorization: auth } });
  if (!r.ok) return null;
  const u = await r.json();
  return KEEPERS.includes(String(u.email || "").toLowerCase()) ? u.email : null;
}

/* ---------- token store: service role only, RLS blocks everyone else ------- */

async function storeRow(mailbox: string): Promise<{ refresh_token: string } | null> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/gmail_accounts?mailbox=eq.${encodeURIComponent(mailbox)}&select=refresh_token`,
    { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } });
  if (!r.ok) return null;
  const rows = await r.json();
  return rows[0] || null;
}
async function storeSet(mailbox: string, refresh_token: string, by: string): Promise<void> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/gmail_accounts?on_conflict=mailbox`, {
    method: "POST",
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({ mailbox, refresh_token, connected_by: by, connected_at: new Date().toISOString() }),
  });
  if (!r.ok) throw new Error("could not store token: " + (await r.text()));
}
async function storeList(): Promise<string[]> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/gmail_accounts?select=mailbox`,
    { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } });
  if (!r.ok) return [];
  return (await r.json()).map((x: { mailbox: string }) => x.mailbox);
}

/* ---------- signed state, so only a link we minted can complete ----------- */

const enc = new TextEncoder();
const b64url = (b: ArrayBuffer | string) => {
  const bytes = typeof b === "string" ? enc.encode(b) : new Uint8Array(b);
  let s = ""; for (const c of bytes) s += String.fromCharCode(c);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const unb64url = (s: string) =>
  atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));

let _hmacKey: CryptoKey | null = null;
async function hmacKey(): Promise<CryptoKey> {
  if (_hmacKey) return _hmacKey;
  _hmacKey = await crypto.subtle.importKey("raw", enc.encode(STATE_SECRET),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  return _hmacKey;
}
async function signState(payload: Record<string, unknown>): Promise<string> {
  const body = b64url(JSON.stringify(payload));
  const sig = b64url(await crypto.subtle.sign("HMAC", await hmacKey(), enc.encode(body)));
  return `${body}.${sig}`;
}
async function readState(state: string): Promise<Record<string, unknown> | null> {
  const [body, sig] = String(state || "").split(".");
  if (!body || !sig) return null;
  const ok = await crypto.subtle.verify("HMAC", await hmacKey(),
    Uint8Array.from(unb64url(sig), (c) => c.charCodeAt(0)), enc.encode(body));
  if (!ok) return null;
  try {
    const p = JSON.parse(unb64url(body));
    return (typeof p.exp === "number" && Date.now() < p.exp) ? p : null;
  } catch { return null; }
}

/* ---------- access tokens, cached per mailbox for the isolate's life ------ */

const _tok = new Map<string, { value: string; exp: number }>();
async function accessToken(mailbox: string): Promise<string> {
  const hit = _tok.get(mailbox);
  if (hit && Date.now() < hit.exp - 60_000) return hit.value;
  const row = await storeRow(mailbox);
  if (!row) throw Object.assign(new Error("not connected"), { code: "not_connected" });
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: row.refresh_token,
      client_id: CLIENT_ID, client_secret: CLIENT_SECRET }),
  });
  const j = await r.json();
  // A revoked or expired grant is a reconnect, not a bug worth retrying.
  if (!r.ok || !j.access_token) {
    throw Object.assign(new Error(j.error_description || j.error || "refresh failed"),
      { code: j.error === "invalid_grant" ? "not_connected" : "google_error" });
  }
  const tok = { value: j.access_token, exp: Date.now() + (Number(j.expires_in) || 3600) * 1000 };
  _tok.set(mailbox, tok);
  return tok.value;
}

const ALLOWED = /^(messages|threads)(\/[A-Za-z0-9_-]+)?(\?[^#]*)?$/;
const page = (title: string, body: string) => new Response(
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
   <title>${title}</title>
   <style>body{font-family:-apple-system,system-ui,sans-serif;background:#F4F1EA;color:#1C1A18;
     display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center}
     div{max-width:30rem;padding:2rem}h1{font-weight:500;font-size:1.4rem;margin:0 0 .6rem}
     p{color:#6b6355;line-height:1.6;margin:0}</style>
   <div><h1>${title}</h1><p>${body}</p></div>`,
  { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  const url = new URL(req.url);

  // Google's redirect lands here with no auth header of its own, so the signed
  // state is what proves this flow started from a keeper's own session.
  if (url.pathname.endsWith("/callback")) {
    const err = url.searchParams.get("error");
    if (err) return page("Not connected", `Google said: ${err}. You can close this tab and try again.`);
    const st = await readState(url.searchParams.get("state") || "");
    if (!st) return page("Link expired", "That connect link is no longer valid. Start again from the archive.");
    const code = url.searchParams.get("code") || "";
    const r = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code, client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
        redirect_uri: REDIRECT_URI, grant_type: "authorization_code" }),
    });
    const j = await r.json();
    if (!r.ok || !j.refresh_token) {
      return page("Not connected",
        "Google did not return a refresh token. This usually means the mailbox was already connected to this app: remove it at myaccount.google.com/permissions and try again.");
    }
    // Whoever actually signed in must be the mailbox that was asked for,
    // otherwise a slip at the account chooser silently connects the wrong box.
    let signedIn = "";
    try { signedIn = String(JSON.parse(unb64url(String(j.id_token).split(".")[1])).email || "").toLowerCase(); } catch { /* id_token is optional */ }
    const wanted = String(st.mailbox).toLowerCase();
    if (signedIn && signedIn !== wanted) {
      return page("Wrong account", `You signed in as ${signedIn}, but this link was for ${wanted}. Nothing was saved. Sign out of Google, or use a private window, and try again.`);
    }
    try { await storeSet(wanted, j.refresh_token, String(st.by || "")); }
    catch (e) { return page("Not connected", String((e as Error).message)); }
    return page("Connected", `${wanted} is connected. You can close this tab and go back to the archive.`);
  }

  if (req.method !== "GET") return new Response("GET only", { status: 405, headers: cors });

  try {
    const who = await keeperEmail(req);
    if (!who) return json({ error: "keepers only" }, 401);
    const action = url.searchParams.get("action") || "";

    if (action === "status") {
      const connected = await storeList();
      return json({ mailboxes: MAILBOXES, connected });
    }

    if (action === "connect_url") {
      const mailbox = (url.searchParams.get("mailbox") || "").toLowerCase();
      if (!MAILBOXES.includes(mailbox)) return json({ error: "mailbox not allowed" }, 400);
      const state = await signState({ mailbox, by: who, exp: Date.now() + 15 * 60_000 });
      const auth = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      auth.search = new URLSearchParams({
        client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, response_type: "code", scope: SCOPE,
        access_type: "offline", prompt: "consent", include_granted_scopes: "true",
        login_hint: mailbox, state,
      }).toString();
      return json({ url: auth.toString() });
    }

    const path = url.searchParams.get("path") || "";
    if (!ALLOWED.test(path)) return json({ error: "path not allowed" }, 400);
    const mailbox = (url.searchParams.get("mailbox") || MAILBOXES[0]).toLowerCase();
    if (!MAILBOXES.includes(mailbox)) return json({ error: "mailbox not allowed" }, 400);

    const token = await accessToken(mailbox);
    const g = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`,
      { headers: { Authorization: `Bearer ${token}` } });
    return new Response(await g.text(), { status: g.status,
      headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" } });
  } catch (e) {
    const err = e as Error & { code?: string };
    if (err.code === "not_connected") return json({ error: "not_connected" }, 409);
    return json({ error: String(err.message || err) }, 500);
  }
});
