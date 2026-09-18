// Maçon Archive — what an order says about the person who placed it.
//
// Two things a person used to have to notice by hand:
//   - an enquiry is answered by an order. Josh King asked in March for a
//     memorial totem for Patsy; his "Custom Patsy Final Payment" in August
//     meant it was made and paid for, but the enquiry sat open for months.
//   - someone buying at trade terms ("half wholesale") is a stockist or a
//     friend, not a collector to send story asks and catch-ups to.

/** Words of an order that mark a commission being paid for. */
const COMMISSION = /\b(custom|commission(ed)?|bespoke|deposit|final payment|balance|memorial)\b/i;
/** Words that mark trade terms rather than a collector's purchase. */
const TRADE = /\b(wholesale|trade price|trade order|stockist|resale|consignment)\b/i;
/** Too common in both enquiries and orders to connect one to the other. */
const COMMON = new Set(("the and for with from that this your have about would like what when where which there their them they " +
  "just could want wants wanted asked asking some into also been more than very make made order orders piece pieces " +
  "totem totems ring rings bronze silver gold pendant pendants necklace chain small large size sizes please thank thanks " +
  "hello dear best love half price").split(" "));

const words = (s: string) => new Set(String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
  .split(/[^a-z]+/).filter((w) => w.length >= 4 && !COMMON.has(w)));

export const isTradeOrder = (items: string[]) => items.some((i) => TRADE.test(i));

export type Enquiry = { id: string; status?: string | null; source?: string | null; subject?: string | null; note?: string | null; first_seen?: string | null };

/** What this order means for an enquiry from the same person. */
export function enquiryVerdict(q: Enquiry, items: string[], orderDate: string): "converted" | "bought-else" | null {
  if (!q || q.status === "closed" || q.source === "composed") return null;
  if (q.first_seen && String(q.first_seen).slice(0, 10) > orderDate) return null;   // bought before they asked
  const text = items.join(" ");
  if (COMMISSION.test(text)) return "converted";
  const asked = words(`${q.subject || ""} ${q.note || ""}`), bought = words(text);
  for (const w of bought) if (asked.has(w)) return "converted";                      // bought what they asked about
  return "bought-else";
}
