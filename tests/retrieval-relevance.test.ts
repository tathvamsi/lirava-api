process.env.NODE_ENV = "test";

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { selectRelevant } from "../src/services/legal/rag.js";

type C = Parameters<typeof selectRelevant>[0][number];
const prov = (title: string, text: string, score: number, origin: C["origin"] = "vector"): C => ({ entityType: "provision", act: "BNSS", section: "Section 1", title, text, score, origin });

describe("only sources that are really about the question are attached", () => {
  it("drops weak vector matches that share no wording with the question", () => {
    const out = selectRelevant(
      [prov("Written statement filing timeline", "The defendant shall file a written statement within thirty days.", 0.5), prov("Direction for grant of bail", "When any person apprehends arrest he may apply for anticipatory bail.", 0.6)],
      "What is anticipatory bail?",
    );
    assert.deepEqual(out.map((c) => c.title), ["Direction for grant of bail"]);
  });

  it("returns nothing when nothing matches, instead of the four nearest", () => {
    const out = selectRelevant([prov("Remand procedure", "Remand of the accused.", 0.46), prov("Secondary evidence", "Copies of documents.", 0.44)], "What is the IT Act 2000?");
    assert.deepEqual(out, []);
  });

  it("keeps a fair vector match only when it shares at least two of the question's subject words", () => {
    const q = "limitation period for a suit on a cheque";
    const sharing = prov("Dishonour of cheque", "Limitation for a suit on the cheque is three years.", 0.52);
    const not = prov("Remand procedure", "Remand of the accused to custody.", 0.55);
    assert.deepEqual(selectRelevant([sharing, not], q).map((c) => c.title), ["Dishonour of cheque"]);
  });

  it("does not let one common word make a text match relevant", () => {
    const lexical = prov("Procedure on hearing", "Notice of hearing shall be given to all parties.", 0.5, "lexical");
    assert.deepEqual(selectRelevant([lexical], "translate: the hearing is adjourned until the next date of hearing"), [], "one shared word is not enough");
    const strong = prov("Adjournment of hearing", "The court may adjourn the hearing and the next date shall be fixed.", 0.5, "lexical");
    assert.equal(selectRelevant([strong], "when can the court adjourn the hearing and fix the next date").length, 1);
  });

  it("generic words (court, section, case) prove nothing", () => {
    const appeal = prov("Second appeal on substantial question", "A second appeal lies to the High Court from a decree of the court.", 0.55);
    assert.deepEqual(selectRelevant([appeal], "Which court has jurisdiction for a section 138 complaint?"), []);
  });

  it("always keeps a section named in the question, and with it only one strong extra", () => {
    const exact = prov("False charge of offence", "Whoever makes a false charge.", 1, "exact");
    const out = selectRelevant([exact, prov("Saving of inherent powers", "inherent powers of the court to quash", 0.44), prov("Discharge in sessions trial", "discharge of the accused", 0.62)], "What does BNS 248 say?");
    assert.equal(out[0].title, "False charge of offence");
    assert.ok(out.length <= 2);
    assert.ok(!out.some((c) => c.title === "Saving of inherent powers"), "a weak extra is not kept beside an exact section");
  });

  it("trims the weakest against the best", () => {
    const out = selectRelevant([prov("Punishment for murder", "punishment for murder is death or imprisonment for life", 0.71), prov("Attempt to commit murder", "attempt murder punishment", 0.62), prov("Punishment for theft", "punishment for theft", 0.55)], "What is the punishment for murder?");
    assert.deepEqual(out.map((c) => c.title), ["Punishment for murder", "Attempt to commit murder"]);
  });
});
