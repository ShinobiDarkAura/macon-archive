// Maçon — writes a follow-up from the actual conversation.
//
// The templates in drafts.js know the database (name, piece, city) but not a
// word the customer wrote. This reads the thread the Letters view already has
// open and asks Claude for a subject and a body that answer it.
//
//   POST /letter-writer   { name, email, piece, city, kind, signoff, messages[] }
//   -> { subject, body }
//
// Secrets: ANTHROPIC_API_KEY

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY     = Deno.env.get("SUPABASE_ANON_KEY")!;
const API_KEY      = Deno.env.get("ANTHROPIC_API_KEY") || "";
const MODEL        = Deno.env.get("ANTHROPIC_MODEL") || "claude-sonnet-5";
const KEEPERS = ["alex@studiomacon.co", "hannah@studiomacon.co"];

// A thread can run long and most of the meaning is at the end. Enough of it to
// answer honestly, capped so a runaway quote chain cannot blow up the request.
const MAX_MSGS = 12;
const MAX_CHARS = 1800;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
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

const VOICE = `You write follow-up emails for Studio Maçon, a two-person studio in Los Angeles.
Hannah carves waxes and files every bronze by hand; Alex handles design and the writing.
The work is bronze and silver: totems, pendants, objects. Ancient forms, futurist edge.

How the studio writes:
- Plain, warm, specific. A person at a bench, not a brand.
- Short paragraphs. Often one sentence each.
- Curious rather than salesy. The point of a follow-up is to hear back, not to sell again.
- Never use em dashes. Use a comma, a full stop, or start a new sentence.
- No exclamation marks beyond one, no marketing language, no "we hope this email finds you well",
  no "just circling back", no "reaching out", no "excited to".
- American spelling, sentence case.

Rules for this letter:
- Answer what the person actually said in the thread. Refer to their own words and details.
- If they asked a question that is still open, answer it or say plainly what happens next.
- If the thread shows the studio already replied, do not repeat it, move it forward.
- Ask at most one question, and make it one only they can answer.
- Sign off with the literal token {{SIGNOFF}} on its own last line, nothing after it.
- The subject line must be between three and five words. No colons. Not a sentence.`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return new Response("POST only", { status: 405, headers: cors });
  try {
    const who = await keeperEmail(req);
    if (!who) return json({ error: "keepers only" }, 401);
    if (!API_KEY) return json({ error: "no_api_key" }, 503);

    const b = await req.json();
    const msgs = (Array.isArray(b.messages) ? b.messages : []).slice(-MAX_MSGS);
    if (!msgs.length) return json({ error: "no_thread" }, 400);

    const transcript = msgs.map((m: { from?: string; at?: number; mine?: boolean; body?: string }) => {
      const when = m.at ? new Date(Number(m.at)).toISOString().slice(0, 10) : "";
      const speaker = m.mine ? "STUDIO MAÇON" : (m.from || "THEM");
      return `[${when}] ${speaker}:\n${String(m.body || "").trim().slice(0, MAX_CHARS)}`;
    }).join("\n\n---\n\n");

    const facts = [
      b.name ? `Their name: ${b.name}` : "",
      b.email ? `Their address: ${b.email}` : "",
      b.piece ? `What they own or asked about: ${b.piece}` : "",
      b.city ? `Where they are: ${b.city}` : "",
      b.kind === "custom" ? "This is an open commission enquiry, not a past customer."
        : "This is someone who has bought from the studio before.",
    ].filter(Boolean).join("\n");

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": API_KEY, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1000,
        system: VOICE,
        messages: [{
          role: "user",
          content: `${facts}\n\nThe conversation so far, oldest first:\n\n${transcript}\n\n`
            + `Write the next letter from the studio. Reply with JSON only, no prose around it:\n`
            + `{"subject": "three to five words", "body": "the letter, plain text, ending with {{SIGNOFF}}"}`,
        }],
      }),
    });
    const j = await r.json();
    if (!r.ok) return json({ error: j?.error?.message || `claude ${r.status}` }, r.status);

    const text = (j.content || []).map((c: { text?: string }) => c.text || "").join("").trim();
    // Claude is asked for bare JSON but may still fence it; take the object.
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return json({ error: "unparseable", raw: text.slice(0, 400) }, 502);
    let out: { subject?: string; body?: string };
    try { out = JSON.parse(m[0]); } catch { return json({ error: "unparseable", raw: text.slice(0, 400) }, 502); }
    if (!out.subject || !out.body) return json({ error: "incomplete" }, 502);

    // The em dash rule is the one the model breaks most, so it is enforced here
    // rather than only asked for.
    const clean = (s: string) => String(s).replace(/\s*[—–]\s*/g, ", ").replace(/\r/g, "");
    return json({ subject: clean(out.subject).trim(), body: clean(out.body).trim() });
  } catch (e) {
    return json({ error: String((e as Error).message || e) }, 500);
  }
});
