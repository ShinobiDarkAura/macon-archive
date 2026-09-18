import { assertEquals } from "jsr:@std/assert@1";
import { enquiryVerdict, isTradeOrder } from "./settle.ts";

const patsy = { id: "q1", status: "open", source: "instagram", first_seen: "2026-03-19",
  subject: "memorial totem for a late pet", note: "Wants a totem for his partner in memory of Patsy, the pet they lost early in the year." };

Deno.test("Josh King's final payment closes his Patsy enquiry", () => {
  assertEquals(enquiryVerdict(patsy, ["Custom Patsy Final Payment"], "2026-08-13"), "converted");
});
Deno.test("a deposit, or buying the very thing they asked about, closes it", () => {
  assertEquals(enquiryVerdict({ ...patsy, subject: "hare commission", note: "" }, ["Totem commission deposit"], "2026-09-20"), "converted");
  assertEquals(enquiryVerdict({ ...patsy, subject: "A question about sizing on the Sietch Ring", note: "" }, ["Sietch Ring - 9"], "2026-09-20"), "converted");
});
Deno.test("buying something else leaves the enquiry open", () => {
  assertEquals(enquiryVerdict(patsy, ["Pip"], "2026-08-29"), "bought-else");
  // "totem" alone is too common to connect a stock totem to a custom one
  assertEquals(enquiryVerdict(patsy, ["Eleph totem"], "2026-08-29"), "bought-else");
});
Deno.test("an order from before they asked, a closed enquiry, or the studio's own letter: no verdict", () => {
  assertEquals(enquiryVerdict(patsy, ["Custom Patsy Final Payment"], "2026-02-01"), null);
  assertEquals(enquiryVerdict({ ...patsy, status: "closed" }, ["Custom"], "2026-08-13"), null);
  assertEquals(enquiryVerdict({ ...patsy, source: "composed" }, ["Custom"], "2026-08-13"), null);
});
Deno.test("trade terms are recognised, a collector's purchase is not", () => {
  assertEquals(isTradeOrder(["3 IHOR totems, half wholesale Lisa <3"]), true);
  assertEquals(isTradeOrder(["Stockist order: 12 Pips"]), true);
  assertEquals(isTradeOrder(["One-of-a-kind bronze fox totem for Suzy"]), false);
  assertEquals(isTradeOrder(["Custom Patsy Final Payment"]), false);
});
