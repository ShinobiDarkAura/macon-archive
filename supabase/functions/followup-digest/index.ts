// Maçon Archive — weekly follow-up digest
// Re-runs the same due-detection as the app, server-side, and emails a summary
// to the keepers via Resend. Deploy + schedule per ../README-followups.md.
//
// Env (set as function secrets, except the two SUPABASE_* which Supabase injects):
//   SUPABASE_URL                 (auto)
//   SUPABASE_SERVICE_ROLE_KEY    (auto) — bypasses RLS to read the table
//   RESEND_API_KEY               your Resend key
//   DIGEST_TO                    comma-separated recipients, e.g. "alex@studiomacon.co,hannah@studiomacon.co"
//   DIGEST_FROM                  verified Resend sender, e.g. "Maçon Archive <archive@studiomacon.co>"

// The letters come from _shared/drafts.js, which the archive loads over HTTP
// from the same path, so a wording fix lands in both. Only the timing rules below are still
// duplicated, and those are flagged in README-followups.md.
import { collectorDraft, enquiryDraft } from "../_shared/drafts.js";

// --- keep these in sync with index.html ---
const LEAD_DEFAULT = 21;
const PIECE_LEAD: Record<string, number> = {
  // "Ren": 14, "Caldera Arc": 45,
};
const firstPiece = (p?: string) =>
  ((p || "").split(",")[0] || "").trim().replace(/\s*[×x]\d+$/, "");
const leadTime = (piece: string) =>
  piece && PIECE_LEAD[piece] != null ? PIECE_LEAD[piece] : LEAD_DEFAULT;
const countPieces = (p?: string) =>
  (p || "").split(",").map((s) => s.trim()).filter(Boolean).length;

function daysSince(str?: string): number | null {
  if (!str) return null;
  const t = Date.parse(str);
  if (isNaN(t)) return null;
  return Math.floor((Date.now() - t) / 86400000);
}
const num = (v: unknown) => {
  const n = parseFloat(String(v ?? "").replace(/[^0-9.]/g, ""));
  return isNaN(n) ? 0 : n;
};

type Rec = Record<string, any>;

// A story ask is for a recent purchase. Past STORY_WINDOW it is not a story ask
// any more, it is a reconnect, and asking "how has it settled in" about
// something bought two years ago reads as a form letter.
const STORY_WINDOW = 180;
const PATRON_LTV = 600;

function isDue(d: Rec): boolean {
  const days = daysSince(d.last_buy);
  if (days == null) return false;
  if (days < leadTime(firstPiece(d.pieces)) + 14) return false;
  if (days > STORY_WINDOW) return false;
  if (d.story === "Yes") return false;
  if (d.last_contact) {
    const c = daysSince(d.last_contact);
    if (c != null && c < 21) return false;
  }
  return true;
}
// Reconnects follow value, not just the VIP flag: the patrons above PATRON_LTV
// are half of all revenue, and they are the ones worth never losing touch with.
function isReconnectDue(d: Rec): boolean {
  if (!d.first_look && num(d.ltv) < PATRON_LTV) return false;
  if (isDue(d)) return false;
  const last = d.last_contact ? daysSince(d.last_contact) : daysSince(d.last_buy);
  return last != null && last >= 90;
}
function priority(d: Rec): "High" | "Medium" | "Low" {
  let s = 0;
  if (d.first_look) s += 3;
  if (num(d.ltv) > 1000) s += 2;
  if (countPieces(d.pieces) >= 2) s += 1;
  if (d.gift_self === "Gift") s += 1;
  return s >= 3 ? "High" : s >= 1 ? "Medium" : "Low";
}
const esc = (s: string) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

Deno.serve(async (_req) => {
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;
  const DIGEST_TO = (Deno.env.get("DIGEST_TO") || "").split(",").map((s) => s.trim()).filter(Boolean);
  const DIGEST_FROM = Deno.env.get("DIGEST_FROM") || "Maçon Archive <onboarding@resend.dev>";

  if (!RESEND_API_KEY || !DIGEST_TO.length) {
    return new Response("Missing RESEND_API_KEY or DIGEST_TO", { status: 500 });
  }

  // Read the archive (service role bypasses RLS)
  const res = await fetch(`${SUPABASE_URL}/rest/v1/collectors?select=*`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  if (!res.ok) return new Response("Fetch failed: " + (await res.text()), { status: 502 });
  const data: Rec[] = await res.json();

  // Open enquiries, with the same needs-attention rule the app uses
  const iq = await fetch(`${SUPABASE_URL}/rest/v1/inquiries?select=*`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  const inquiries: Rec[] = iq.ok ? await iq.json() : [];
  const INQ_STALE = 7;
  const inqState = (q: Rec) => {
    if (q.status === "closed") return "closed";
    if (q.status === "open") return "attention";
    const d = daysSince(q.last_touched) ?? daysSince(q.first_seen) ?? 0;
    return d >= INQ_STALE ? "attention" : "followed";
  };
  const waiting = inquiries
    .filter((q) => inqState(q) === "attention")
    .map((q) => ({ q, days: (daysSince(q.last_touched) ?? daysSince(q.first_seen) ?? 0) }))
    .sort((a, b) => b.days - a.days);

  // The letter to send, chosen by where the thread actually is. Prepared drafts
  // win; otherwise it is a first reply, a nudge, or an apology for the silence.

  const order = { High: 0, Medium: 1, Low: 2 } as const;
  const CAP = 10;   // a briefing, not the whole ledger

  // "Thailand bronzes enquiry" is a label, not a name. Only greet by first name
  // when the record actually looks like a person.
  // "a snail", "an armoured bear", and nothing at all in front of a plural
  // Only put an article in front of something short and plainly singular.
  // "a bronze pieces, possibly cutlery" is worse than no article at all.
  // Plurality comes from the last word, not the first: "Ida's Wonder Horn" is
  // one thing, "Custom Bronze Dog Totems" is several. A leading count settles it.

  /* Drafts follow the studio's own rules: no em dashes, short ideas joined with
     commas rather than stacked, nothing pitchy, and each one ends on something
     answerable in a sentence. */

  type Card = { d: Rec; kind: string; days: number; pri: "High" | "Medium" | "Low"; draft: string };
  const due: Card[] = data.filter(isDue)
    .map((d) => ({ d, kind: "Story ask", days: daysSince(d.last_buy)!, pri: priority(d) as Card["pri"], draft: collectorDraft(d, "story").body }));
  const recon: Card[] = data.filter(isReconnectDue)
    .map((d) => ({ d, kind: "Patron gone quiet", days: (d.last_contact ? daysSince(d.last_contact) : daysSince(d.last_buy))!, pri: "High", draft: collectorDraft(d, "reconnect").body }));

  // Patrons first, then the most overdue, then by what they are worth.
  const ranked = recon.concat(due).sort((a, b) =>
    order[a.pri] - order[b.pri] || b.days - a.days || num(b.d.ltv) - num(a.d.ltv));
  const items = ranked.slice(0, CAP);
  const overflow = ranked.length - items.length;

  const money = (v: unknown) => { const n = num(v); return n ? `$${Math.round(n).toLocaleString("en-US")}` : ""; };

  const card = (x: Card) => `
    <div style="border:1px solid #e7e1d4;border-radius:10px;padding:14px 16px;margin-bottom:12px">
      <div style="font-family:Helvetica,Arial,sans-serif;font-size:14px">
        <strong>${esc(x.d.name || "—")}</strong>
        <span style="color:#8f897e"> · ${esc(x.kind)} · ${x.days}d${money(x.d.ltv) ? " · " + money(x.d.ltv) : ""}</span>
        ${x.d.email ? `<span style="color:#8f897e"> · ${esc(x.d.email)}</span>` : `<span style="color:#9c4a3a"> · no address</span>`}
      </div>
      ${firstPiece(x.d.pieces) ? `<div style="color:#8f897e;font-size:12.5px;margin-top:3px">${esc(firstPiece(x.d.pieces))}</div>` : ""}
      <pre style="white-space:pre-wrap;font-family:Georgia,serif;font-size:13.5px;color:#2b2622;background:#faf7f0;border-radius:8px;padding:12px;margin:10px 0 0">${esc(x.draft)}</pre>
    </div>`;

  const total = items.length + waiting.length;
  const html = `
    <div style="font-family:Georgia,serif;max-width:680px;margin:0 auto;color:#2b2622">
      <p style="font-family:monospace;font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:#8c6a47">Bureau of Provenance</p>
      <h1 style="font-weight:400;font-size:28px;margin:6px 0 2px">This week</h1>
      <p style="color:#5b5a55;margin:0 0 22px">${total ? `${total} ${total === 1 ? "letter" : "letters"} worth writing. Each one is drafted below, ready to edit and send.` : "Nothing pressing. Nicely kept."}</p>

      ${waiting.length ? `
      <h2 style="font-weight:400;font-size:21px;margin:26px 0 2px">Enquiries waiting on you</h2>
      <p style="color:#5b5a55;margin:0 0 14px;font-size:14px">Someone wrote in and has not heard back.</p>
      ${waiting.map(({ q, days }) => `
        <div style="border:1px solid #e7e1d4;border-radius:10px;padding:14px 16px;margin-bottom:12px">
          <div style="font-family:Helvetica,Arial,sans-serif;font-size:14px">
            <strong>${esc(q.name || "—")}</strong>
            <span style="color:#8f897e"> · ${esc(q.subject || "")} · ${days}d</span>
            ${q.email ? `<span style="color:#8f897e"> · ${esc(q.email)}</span>` : `<span style="color:#9c4a3a"> · no address on file</span>`}
            ${q.draft ? `<span style="color:#9c4a3a"> · prepared</span>` : ""}
          </div>
          ${q.note ? `<p style="color:#5b5a55;font-size:13px;margin:8px 0 0">${esc(q.note)}</p>` : ""}
          <pre style="white-space:pre-wrap;font-family:Georgia,serif;font-size:13.5px;color:#2b2622;background:#faf7f0;border-radius:8px;padding:12px;margin:10px 0 0">${esc(enquiryDraft(q, days).body)}</pre>
        </div>`).join("")}` : ""}

      ${items.length ? `
      <h2 style="font-weight:400;font-size:21px;margin:30px 0 2px">Collectors</h2>
      <p style="color:#5b5a55;margin:0 0 14px;font-size:14px">Patrons who have gone quiet, then recent pieces worth asking about.</p>
      ${items.map(card).join("")}` : ""}

      ${overflow > 0 ? `<p style="color:#a7a39c;font-size:12.5px">${overflow} more in the archive, not pressing this week.</p>` : ""}
      <p style="color:#a7a39c;font-size:12px;margin-top:24px">Maçon · Artifacts of Love</p>
    </div>`;

  const send = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: DIGEST_FROM,
      to: DIGEST_TO,
      subject: `Maçon · ${total} ${total === 1 ? "letter" : "letters"} to write this week`,
      html,
    }),
  });
  if (!send.ok) return new Response("Resend failed: " + (await send.text()), { status: 502 });

  return new Response(JSON.stringify({ sent: DIGEST_TO, collectors: items.length, enquiries: waiting.length, held_back: overflow }), {
    headers: { "Content-Type": "application/json" },
  });
});
