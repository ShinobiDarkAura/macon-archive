import { assertEquals } from "jsr:@std/assert@1";
import { onePerPerson, personKeys, primaryEmails, whyNotAnEnquiry } from "./rules.js";

Deno.test("the studio's own test enquiries are recognised; real ones are not", async () => {
  assertEquals(await whyNotAnEnquiry({ email: "shakerflannelkimono+c3@gmail.com", note: "Still no name given." }), "sent by the studio");
  assertEquals(await whyNotAnEnquiry({ email: "", source: "website contact", note: "How do I reach you?" }), "no address to answer");
  assertEquals(await whyNotAnEnquiry({ email: "a@b.com", note: "testing" }), "a test");
  assertEquals(await whyNotAnEnquiry({ email: "anboardman@gmail.com", note: "Asked how big the totems are." }), "");
  assertEquals(await whyNotAnEnquiry({ email: "hannah@studiomacon.co", source: "composed" }), "written to the studio");
});
const collectors = [
  { acc: "M-009", email: "king.js@aol.com", alt_emails: ["bladedcarry@gmail.com"] },
  { acc: "M-097", email: "bladedcarry@gmail.com", merged_into: "M-009" },
];
Deno.test("an enquiry from a second address and the collector letter are one person", () => {
  const p = primaryEmails(collectors);
  const items = [{ q: { id: "q1", email: "bladedcarry@gmail.com" } }, { d: collectors[0] }, { d: { email: "other@x.com" } }];
  assertEquals(onePerPerson(items, p).length, 2);
  assertEquals(personKeys(items[0], collectors, p).sort(), ["d:bladedcarry@gmail.com", "d:king.js@aol.com", "q:q1"]);
});
