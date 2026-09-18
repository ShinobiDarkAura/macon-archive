// Maçon Archive — is this order from someone we already know?
//
// An email address is not a person. People buy from a second address, and the
// webhook used to make a second collector of them (Josh King and Joshua King).
// Every Wix order carries more than the address, though: a phone number and a
// place to send the parcel. With the surname those settle it.
//
//   verified  same surname, and the same phone, or the same postcode with
//             either the same street or a first name that fits. The order is
//             theirs: it joins their record and the new address is kept.
//   possible  same surname, a first name that fits, and the same town, but
//             nothing that proves it. A new record is made, carrying a note
//             that names who it may be, so a person decides.

export type Person = {
  acc: string; name?: string | null; email?: string | null; alt_emails?: string[] | null;
  phone?: string | null; postcode?: string | null; address?: string | null;
  location?: string | null; merged_into?: string | null;
};
export type Order = { name: string; phone: string; postcode: string; address: string; city: string };
export type Match = { kind: "verified" | "possible"; person: Person; why: string };

const NICK: Record<string, string> = {
  bill: "william", will: "william", liam: "william", bob: "robert", rob: "robert", bobby: "robert",
  jim: "james", jimmy: "james", jack: "john", johnny: "john", mike: "michael", mick: "michael",
  dick: "richard", rick: "richard", rich: "richard", ted: "edward", ned: "edward", ed: "edward",
  chuck: "charles", charlie: "charles", hank: "henry", harry: "henry", tony: "anthony",
  peggy: "margaret", meg: "margaret", maggie: "margaret", liz: "elizabeth", beth: "elizabeth",
  betsy: "elizabeth", kate: "katherine", katie: "katherine", kathy: "katherine", sue: "susan",
  becky: "rebecca", patty: "patricia", jen: "jennifer", jenny: "jennifer", andy: "andrew",
};
const canon = (s: string) => NICK[s] || s;
const words = (name: string) =>
  String(name || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z\s'-]/g, " ").split(/\s+/).filter(Boolean);

export const surname = (name: string) => { const w = words(name); return w.length > 1 ? w[w.length - 1] : ""; };
const firstName = (name: string) => words(name)[0] || "";

/** Josh and Joshua, Bill and William: the same first name, or one short for the other. */
export function firstNamesFit(a: string, b: string): boolean {
  const x = firstName(a), y = firstName(b);
  if (!x || !y) return false;
  if (x === y || canon(x) === canon(y)) return true;
  const [s, l] = x.length <= y.length ? [x, y] : [y, x];
  return s.length >= 3 && l.startsWith(s);
}

export const phoneKey = (p: string | null | undefined) => {
  const d = String(p || "").replace(/\D/g, "");
  return d.length >= 7 ? d.slice(-10) : "";
};
export const postKey = (p: string | null | undefined) => String(p || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
export const streetKey = (a: string | null | undefined) =>
  String(a || "").toLowerCase()
    .replace(/\b(street)\b/g, "st").replace(/\b(road)\b/g, "rd").replace(/\b(avenue)\b/g, "ave")
    .replace(/\b(drive)\b/g, "dr").replace(/\b(lane)\b/g, "ln").replace(/\b(boulevard)\b/g, "blvd")
    .replace(/\b(apartment|apt|unit|suite|ste)\b.*$/g, "").replace(/[^a-z0-9]/g, "");
const townKey = (s: string | null | undefined) => String(s || "").split(",")[0].toLowerCase().replace(/[^a-z]/g, "");

/** The best match among people who share the order's surname, or null. */
export function matchPerson(order: Order, people: Person[]): Match | null {
  const last = surname(order.name);
  if (!last) return null;
  const same = people.filter((p) => !p.merged_into && surname(p.name || "") === last);
  const ph = phoneKey(order.phone), pc = postKey(order.postcode), st = streetKey(order.address), town = townKey(order.city);
  for (const p of same) {
    if (ph && phoneKey(p.phone) === ph) return { kind: "verified", person: p, why: "same surname and phone" };
    if (pc && postKey(p.postcode) === pc) {
      if (st && streetKey(p.address) === st) return { kind: "verified", person: p, why: "same surname, street and postcode" };
      if (firstNamesFit(order.name, p.name || "")) return { kind: "verified", person: p, why: "same surname and postcode, first names fit" };
    }
  }
  for (const p of same) {
    if (town && townKey(p.location) === town && firstNamesFit(order.name, p.name || ""))
      return { kind: "possible", person: p, why: "same surname and town, first names fit" };
  }
  return null;
}
