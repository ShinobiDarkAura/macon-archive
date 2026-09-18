import { assertEquals } from "jsr:@std/assert@1";
import { firstNamesFit, matchPerson, type Person } from "./identity.ts";

const josh: Person = { acc: "M-009", name: "Josh King", email: "king.js@aol.com", phone: "8146607478", location: "Smithfield, USA" };
const order = (o: Partial<{ name: string; phone: string; postcode: string; address: string; city: string }>) =>
  ({ name: "", phone: "", postcode: "", address: "", city: "", ...o });

Deno.test("first names that are one person", () => {
  assertEquals(firstNamesFit("Josh King", "Joshua King"), true);
  assertEquals(firstNamesFit("Bill Hart", "William Hart"), true);
  assertEquals(firstNamesFit("Liz Moss", "Elizabeth Moss"), true);
  assertEquals(firstNamesFit("Jo King", "Joshua King"), false);     // too short to be sure
  assertEquals(firstNamesFit("Sarah King", "Joshua King"), false);
});
Deno.test("the August order: what the record held then only makes it possible", () => {
  const m = matchPerson(order({ name: "Joshua King", city: "Smithfield" }), [josh]);
  assertEquals(m?.kind, "possible"); assertEquals(m?.person.acc, "M-009");
});
Deno.test("the same phone proves it, in any format", () => {
  const m = matchPerson(order({ name: "Joshua King", phone: "+1 (814) 660-7478" }), [josh]);
  assertEquals(m?.kind, "verified");
});
Deno.test("the same street and postcode prove it, however it is written", () => {
  const p = { ...josh, postcode: "15658", address: "12 Laurel Street" };
  assertEquals(matchPerson(order({ name: "Jane King", postcode: "15658", address: "12 laurel st." }), [p])?.kind, "verified");
});
Deno.test("a stranger with the same surname is never matched", () => {
  assertEquals(matchPerson(order({ name: "Sarah King", city: "Smithfield" }), [josh]), null);
  assertEquals(matchPerson(order({ name: "Joshua King", city: "Portland" }), [josh]), null);
  assertEquals(matchPerson(order({ name: "Joshua Kingsley", city: "Smithfield" }), [josh]), null);
});
Deno.test("a record already folded into another is not offered", () => {
  assertEquals(matchPerson(order({ name: "Josh King", phone: "8146607478" }), [{ ...josh, merged_into: "M-001" }]), null);
});
