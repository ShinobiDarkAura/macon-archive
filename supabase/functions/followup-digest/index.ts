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

function isDue(d: Rec): boolean {
  const days = daysSince(d.last_buy);
  if (days == null) return false;
  if (days < leadTime(firstPiece(d.pieces)) + 14) return false;
  if (d.story === "Yes") return false;
  if (d.last_contact) {
    const c = daysSince(d.last_contact);
    if (c != null && c < 21) return false;
  }
  return true;
}
function isReconnectDue(d: Rec): boolean {
  if (!d.first_look) return false;
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

  const order = { High: 0, Medium: 1, Low: 2 } as const;
  const due = data.filter(isDue)
    .map((d) => ({ d, kind: "Story ask", days: daysSince(d.last_buy)!, pri: priority(d) }));
  const recon = data.filter(isReconnectDue)
    .map((d) => ({ d, kind: "Reconnect", days: (d.last_contact ? daysSince(d.last_contact) : daysSince(d.last_buy))!, pri: "High" as const }));
  const items = due.concat(recon).sort((a, b) => order[a.pri] - order[b.pri] || a.days - b.days);

  const row = (x: typeof items[number]) => `
    <tr>
      <td style="padding:8px 14px;border-bottom:1px solid #e7e1d4;font-weight:600">${esc(x.d.name || "—")}</td>
      <td style="padding:8px 14px;border-bottom:1px solid #e7e1d4;color:#9c4a3a">${esc(x.pri)}</td>
      <td style="padding:8px 14px;border-bottom:1px solid #e7e1d4">${esc(x.kind)}</td>
      <td style="padding:8px 14px;border-bottom:1px solid #e7e1d4">${esc(firstPiece(x.d.pieces) || "")}</td>
      <td style="padding:8px 14px;border-bottom:1px solid #e7e1d4;color:#5b5a55">${x.days}d</td>
      <td style="padding:8px 14px;border-bottom:1px solid #e7e1d4;color:#5b5a55">${esc(x.d.email || "")}</td>
    </tr>`;

  const html = `
    <div style="font-family:Georgia,serif;max-width:680px;margin:0 auto;color:#2b2622">
      <p style="font-family:monospace;font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:#8c6a47">Bureau of Provenance</p>
      <h1 style="font-weight:400;font-size:28px;margin:6px 0 2px">Follow-ups due</h1>
      <p style="color:#5b5a55;margin:0 0 18px">${items.length} collector${items.length === 1 ? "" : "s"} waiting to hear from you.</p>
      ${items.length ? `<table style="width:100%;border-collapse:collapse;font-family:Helvetica,Arial,sans-serif;font-size:14px">
        <thead><tr style="text-align:left;color:#8f897e;font-size:11px;text-transform:uppercase;letter-spacing:.08em">
          <th style="padding:0 14px 6px">Name</th><th style="padding:0 14px 6px">Priority</th><th style="padding:0 14px 6px">Type</th><th style="padding:0 14px 6px">Piece</th><th style="padding:0 14px 6px">Since</th><th style="padding:0 14px 6px">Email</th>
        </tr></thead><tbody>${items.map(row).join("")}</tbody></table>`
      : `<p style="color:#5b5a55">No one is due this week. Nicely kept.</p>`}
      <p style="color:#a7a39c;font-size:12px;margin-top:24px">Open the archive to draft each note. Maçon · Artifacts of Love</p>
    </div>`;

  const send = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: DIGEST_FROM,
      to: DIGEST_TO,
      subject: `Maçon · ${items.length} follow-up${items.length === 1 ? "" : "s"} due`,
      html,
    }),
  });
  if (!send.ok) return new Response("Resend failed: " + (await send.text()), { status: 502 });

  return new Response(JSON.stringify({ sent: DIGEST_TO, due: items.length }), {
    headers: { "Content-Type": "application/json" },
  });
});
