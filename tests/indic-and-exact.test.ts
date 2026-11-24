process.env.NODE_ENV = "test";

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { englishHints, hasIndicScript, withEnglishHints } from "../src/services/legal/indic-terms.js";
import { classifyOutput } from "../src/services/agent/output-mode.js";
import { intakeKindOf, planIntake } from "../src/services/agent/intake.js";
import { retrieveLegalContext } from "../src/services/legal/rag.js";

const KANNADA_BAIL = "ಈ ಪ್ರಕರಣಕ್ಕೆ ಮುಂಗಡ ಜಾಮೀನು ಅರ್ಜಿಯನ್ನು ಕನ್ನಡದಲ್ಲಿ ಕರಡು ಮಾಡಿ";

describe("legal words in Kannada, Hindi, Marathi, Tamil and Telugu", () => {
  it("are given English equivalents for the search, and English text is left alone", () => {
    assert.equal(hasIndicScript(KANNADA_BAIL), true);
    assert.equal(hasIndicScript("Draft a bail application"), false);
    const hints = englishHints(KANNADA_BAIL);
    for (const t of ["draft", "application", "anticipatory bail", "bail"]) assert.ok(hints.includes(t), `${t} is found`);
    assert.equal(withEnglishHints("What does BNS 348 say?"), "What does BNS 348 say?");
    assert.match(withEnglishHints(KANNADA_BAIL), /^ಈ ಪ್ರಕರಣಕ್ಕೆ .*\(.*anticipatory bail.*\)$/, "the original is kept, the hints are appended");
  });

  it("cover the other four languages", () => {
    assert.ok(englishHints("अग्रिम जमानत का आवेदन तैयार करें").includes("anticipatory bail"));
    assert.ok(englishHints("அவருக்கு முன் ஜாமீன் மனு வரைவு").includes("anticipatory bail"));
    assert.ok(englishHints("ముందస్తు బెయిల్ పిటిషన్ ముసాయిదా").includes("anticipatory bail"));
    assert.ok(englishHints("अटकपूर्व जामीन अर्ज मसुदा").includes("anticipatory bail"));
    assert.ok(englishHints("चेक बाउंस का नोटिस").includes("cheque"));
  });

  it("make a Kannada request for a bail application a document request with the bail checklist", () => {
    assert.equal(classifyOutput(KANNADA_BAIL), "document");
    assert.equal(intakeKindOf(KANNADA_BAIL), "anticipatory_bail");
    const plan = planIntake({ request: KANNADA_BAIL, history: [], matter: null, caseFile: null });
    assert.deepEqual(plan?.missing.map((m) => m.id), ["accused", "court", "case", "custody"], "the language was named in the request, so it is not asked");
    assert.ok(plan?.known.some((k) => /Kannada/.test(k)));
  });

  it("do not turn an ordinary Kannada question into a document request", () => {
    assert.equal(classifyOutput("ಮುಂಗಡ ಜಾಮೀನು ಎಂದರೇನು"), null);
  });
});

describe("a section named in the question is read from the library", () => {
  it("puts the exact text of the named section first and marks it as exact", async () => {
    const r = await retrieveLegalContext("What does BNS 348 say?");
    assert.ok(r, "something was found");
    assert.equal(r!.sources[0].act, "BNS");
    assert.equal(r!.sources[0].section, "Section 348");
    assert.match(r!.contextText, /\[EXACT TEXT of BNS Section 348, read directly from the statute library/);
    assert.match(r!.contextText, /counterfeiting a property mark/i);
  });

  it("reads each section named when there are several, across different Acts", async () => {
    const r = await retrieveLegalContext("Explain Section 482 BNSS and Section 138 of the NI Act");
    const first = r!.sources.slice(0, 2).map((s) => `${s.act} ${s.section}`);
    assert.deepEqual(first, ["BNSS Section 482", "NIA Section 138"]);
  });

  it("finds the right bail provisions for a Kannada request, not unrelated civil rules", async () => {
    const r = await retrieveLegalContext(KANNADA_BAIL);
    const titles = (r?.sources ?? []).map((s) => `${s.title}`).join(" | ");
    assert.match(titles, /bail/i);
    assert.doesNotMatch(titles, /injunction/i);
  });

  it("does not invent a section: one the library does not hold is simply not added", async () => {
    const r = await retrieveLegalContext("What does BNS 99999 say?");
    assert.ok(!r || !/EXACT TEXT of BNS Section 99999/.test(r.contextText));
  });
});
