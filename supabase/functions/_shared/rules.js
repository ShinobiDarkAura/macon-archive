// Maçon Archive — rules the Letters desk (index.html) and the Monday digest
// (followup-digest) must agree on. Plain JavaScript, no dependencies, so the
// browser loads it as a module and Deno imports it as is. Change a rule here and
// both change together; copies in each place are how they drifted apart.

/* ---------- Enquiries that are not really enquiries ----------
   The studio testing its own form, a form with no address to answer, nothing
   written, or a short message that is plainly a test. The studio's private
   addresses are held only as SHA-256 hashes, because the site is public; a
   "+tag" alias counts as the address it hangs off. */
export const OWN_DOMAINS_PLAIN = ["studiomacon.co"];
export const OWN_HASHES = new Set([
  "f87b488f0549cc55978cfb3d8403adc20329653cf6007b0bfcb607dedf77866a",   // a personal address
  "5e0befc4571f78822157800541a1d8f6a18f20e6d8423a1edc4d50088763babe",   // a personal domain
]);
const _seen = new Map();
export async function sha256hex(t) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t));
  return [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
export async function fromTheStudio(email) {
  const e = String(email || "").trim().toLowerCase();
  if (!e.includes("@")) return false;
  if (_seen.has(e)) return _seen.get(e);
  const [local, domain] = e.split("@"), base = local.split("+")[0] + "@" + domain;
  let own = OWN_DOMAINS_PLAIN.includes(domain);
  if (!own && globalThis.crypto && crypto.subtle) {
    try { own = OWN_HASHES.has(await sha256hex(base)) || OWN_HASHES.has(await sha256hex(domain)); } catch (_e) { /* treated as not ours */ }
  }
  _seen.set(e, own); return own;
}
/** Why an enquiry row is not a real enquiry, or "" if it is one. */
export async function whyNotAnEnquiry(q) {
  const studio = await fromTheStudio(q.email) || await fromTheStudio(q.name);
  if (q.source === "composed") return studio ? "written to the studio" : "";
  if (studio) return "sent by the studio";
  if (!String(q.email || "").trim() && /^website (contact|commission)$/i.test(q.source || "")) return "no address to answer";
  const text = [q.subject, q.note].map((v) => String(v || "").trim()).filter(Boolean).join(" ");
  if (!text) return "nothing written";
  if (text.length <= 60 && /\b(test(ing)?|please ignore|ignore this|asdf|lorem ipsum)\b/i.test(text)) return "a test";
  return "";
}

/* ---------- One person, whatever address they used ---------- */
/** Every address a collector is known by, mapped to their main one. */
export function primaryEmails(collectors) {
  const m = new Map();
  for (const d of collectors || []) {
    if (d.merged_into) continue;
    const e = String(d.email || "").toLowerCase(); if (!e) continue;
    m.set(e, e);
    for (const a of d.alt_emails || []) m.set(String(a).toLowerCase(), e);
  }
  return m;
}
/** The person an item (a collector card or an enquiry) is about, by main address. */
export function personOf(item, primary) {
  const e = String(item?.d?.email || item?.q?.email || item?.email || "").toLowerCase();
  return e ? (primary.get(e) || e) : "";
}
/** Keep the first item for each person; the order given decides which. */
export function onePerPerson(items, primary) {
  const seen = new Set();
  return items.filter((x) => { const k = personOf(x, primary); if (!k) return true; if (seen.has(k)) return false; seen.add(k); return true; });
}
/** Every "cleared until they write" key that could stand for this person. */
export function personKeys(item, collectors, primary) {
  const who = personOf(item, primary), keys = new Set();
  if (who) {
    keys.add("d:" + who);
    for (const [addr, main] of primary) if (main === who) keys.add("d:" + addr);
  }
  if (item?.q?.id) keys.add("q:" + item.q.id);
  if (item?.d && !who) keys.add("d:" + String(item.d.acc || item.d.name || "").toLowerCase());
  return [...keys];
}
