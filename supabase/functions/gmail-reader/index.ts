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
// Reading plus sending as the connected box. Adding send here is what lets a
// reply land inside the customer's existing thread rather than starting a new
// one, which a compose window opened from a URL can never do.
const SCOPE = "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send";
const REDIRECT_URI = `${SUPABASE_URL}/functions/v1/gmail-reader/callback`;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
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
const b64 = (t: string) => {
  const bytes = enc.encode(t);
  let s = ""; for (const c of bytes) s += String.fromCharCode(c);
  return btoa(s);
};
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

// Supabase's gateway rewrites our Content-Type to text/plain and sends
// nosniff, so an HTML confirmation page can never render. Send the keeper back
// to the archive instead, which is a better ending anyway.
const APP_HOSTS = ["shinobidarkaura.github.io", "localhost", "127.0.0.1"];
function safeOrigin(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (!APP_HOSTS.includes(u.hostname)) return null;
    if (u.protocol !== "https:" && u.hostname !== "localhost" && u.hostname !== "127.0.0.1") return null;
    return u.origin + u.pathname;
  } catch { return null; }
}
const backTo = (origin: string | null, params: Record<string, string>) => {
  const base = origin || "https://shinobidarkaura.github.io/macon-archive/";
  const u = new URL(base);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return new Response(null, { status: 302, headers: { Location: u.toString(), "Cache-Control": "no-store" } });
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  const url = new URL(req.url);

  // Google's redirect lands here with no auth header of its own, so the signed
  // state is what proves this flow started from a keeper's own session.
  if (url.pathname.endsWith("/callback")) {
    const st = await readState(url.searchParams.get("state") || "");
    const back = st ? safeOrigin(String(st.origin || "")) : null;
    const err = url.searchParams.get("error");
    if (err) return backTo(back, { gmail: "error", detail: err });
    if (!st) return backTo(null, { gmail: "error", detail: "expired" });
    const code = url.searchParams.get("code") || "";
    const r = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code, client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
        redirect_uri: REDIRECT_URI, grant_type: "authorization_code" }),
    });
    const j = await r.json();
    if (!r.ok || !j.refresh_token) return backTo(back, { gmail: "error", detail: "no_refresh_token" });
    // Whoever actually signed in must be the mailbox that was asked for,
    // otherwise a slip at the account chooser silently connects the wrong box.
    let signedIn = "";
    try { signedIn = String(JSON.parse(unb64url(String(j.id_token).split(".")[1])).email || "").toLowerCase(); } catch { /* id_token is optional */ }
    const wanted = String(st.mailbox).toLowerCase();
    if (signedIn && signedIn !== wanted) return backTo(back, { gmail: "error", detail: "wrong_account", got: signedIn });
    try { await storeSet(wanted, j.refresh_token, String(st.by || "")); }
    catch { return backTo(back, { gmail: "error", detail: "store_failed" }); }
    return backTo(back, { gmail: "connected", mailbox: wanted });
  }

  // Sending is the one write this function does, so it is the one POST.
  if (req.method === "POST") {
    try {
      const who = await keeperEmail(req);
      if (!who) return json({ error: "keepers only" }, 401);
      const b = await req.json();
      const from = String(b.mailbox || "").toLowerCase();
      if (!MAILBOXES.includes(from)) return json({ error: "mailbox not allowed" }, 400);
      if (!b.to || !b.subject) return json({ error: "need a recipient and a subject" }, 400);

      // RFC 2047 for the subject and base64 for the body, so accents and the
      // studio's own name survive the trip.
      const enc2047 = (t: string) => /^[\x20-\x7E]*$/.test(t) ? t : `=?UTF-8?B?${b64(t)}?=`;
      const headers = [
        `From: ${from}`,
        `To: ${b.to}`,
        ...(b.cc ? [`Cc: ${b.cc}`] : []),
        `Subject: ${enc2047(String(b.subject))}`,
        ...(b.inReplyTo ? [`In-Reply-To: ${b.inReplyTo}`, `References: ${b.references || b.inReplyTo}`] : []),
        "MIME-Version: 1.0",
        'Content-Type: text/plain; charset="UTF-8"',
        "Content-Transfer-Encoding: base64",
        "",
      ].join("\r\n");
      const raw = b64url(headers + "\r\n" + b64(String(b.body || "")));

      const token = await accessToken(from);
      const g = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(b.threadId ? { raw, threadId: b.threadId } : { raw }),
      });
      const out = await g.json();
      if (!g.ok) return json({ error: out?.error?.message || "send failed" }, g.status);
      return json({ ok: true, id: out.id, threadId: out.threadId });
    } catch (e) {
      const err = e as Error & { code?: string };
      if (err.code === "not_connected") return json({ error: "not_connected" }, 409);
      return json({ error: String(err.message || err) }, 500);
    }
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
      const origin = safeOrigin(url.searchParams.get("origin") || "") || "";
      const state = await signState({ mailbox, by: who, origin, exp: Date.now() + 15 * 60_000 });
      const auth = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      auth.search = new URLSearchParams({
        client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, response_type: "code", scope: SCOPE,
        access_type: "offline", prompt: "consent", include_granted_scopes: "true",
        login_hint: mailbox, state,
      }).toString();
      return json({ url: auth.toString() });
    }

    // The browser was making one request to list ids and then one per message
    // for its headers, thirty-odd round trips through here for a single inbox.
    // The fan-out belongs on this side, next to Google, in parallel, returning
    // one assembled answer.
    if (action === "inbox") {
      const q = url.searchParams.get("q") || "in:inbox newer_than:14d";
      const per = Math.min(Number(url.searchParams.get("per") || 12), 25);
      const boxes = MAILBOXES;
      const all = await Promise.all(boxes.map(async (box) => {
        try {
          const token = await accessToken(box);
          const h = { Authorization: `Bearer ${token}` };
          const lr = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(q)}&maxResults=${per}`, { headers: h });
          if (!lr.ok) return [];
          const list = await lr.json();
          const ids = (list.messages || []).map((m: { id: string }) => m.id);
          const metas = await Promise.all(ids.map(async (id: string) => {
            const r = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`, { headers: h });
            if (!r.ok) return null;
            const m = await r.json();
            const head = (n: string) => ((m.payload && m.payload.headers) || [])
              .find((x: { name: string }) => x.name.toLowerCase() === n.toLowerCase())?.value || "";
            return { id: m.id, box, from: head("From"), subject: head("Subject"),
                     snippet: m.snippet || "", at: Number(m.internalDate),
                     unread: (m.labelIds || []).includes("UNREAD") };
          }));
          return metas.filter(Boolean);
        } catch { return []; }
      }));
      const rows = all.flat().sort((a, b) => (b as {at:number}).at - (a as {at:number}).at);
      return json({ messages: rows });
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
