import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyDocument, contentFingerprint, kindPriority, isDocKind } from "../src/services/documents/classify.js";

test("an FIR is recognised from its heading", () => {
  const text = "FIRST INFORMATION REPORT (Under Section 173 BNSS)\nFIR No. 214/2025  Police Station: Bidar Town";
  assert.equal(classifyDocument("scan001.pdf", text).kind, "fir");
});

test("the file name alone is enough when it says so", () => {
  assert.equal(classifyDocument("charge-sheet-final.pdf", "").kind, "charge_sheet");
  assert.equal(classifyDocument("PW1_cross_examination.docx", "").kind, "deposition");
});

test("a section 164 statement is told apart from a section 161 statement", () => {
  const s164 = "Statement recorded before the learned Magistrate under Section 164 CrPC. The witness was cautioned.";
  const s161 = "Statement of Manjunath recorded by the Investigating Officer under Section 161 CrPC.";
  assert.equal(classifyDocument("w1.pdf", s164).kind, "statement_164");
  assert.equal(classifyDocument("w2.pdf", s161).kind, "statement_161");
});

test("Hindi and Kannada headings are read", () => {
  assert.equal(classifyDocument("a.pdf", "प्रथम सूचना रिपोर्ट\nप्रथम सूचना रिपोर्ट क्रमांक 12").kind, "fir");
  assert.equal(classifyDocument("b.pdf", "ಪ್ರಥಮ ವರ್ತಮಾನ ವರದಿ ಪ್ರಥಮ ವರ್ತಮಾನ").kind, "fir");
});

test("one weak sign in the text is not enough: the type stays other", () => {
  const out = classifyDocument("notes.txt", "The matter was heard and the next date of hearing is fixed.");
  assert.equal(out.kind, "other");
  assert.equal(out.score, 0);
});

test("a bail application is not mistaken for an order", () => {
  const text = "IN THE COURT OF SESSIONS\nApplication for regular bail under Section 483 BNSS. B.A. No. 55/2026";
  assert.equal(classifyDocument("application.pdf", text).kind, "bail_application");
});

test("the case file reads the record of events before paperwork", () => {
  assert.ok(kindPriority("fir") < kindPriority("bail_application"));
  assert.ok(kindPriority("statement_164") < kindPriority("order"));
  assert.ok(kindPriority("made-up") >= kindPriority("other"));
});

test("isDocKind accepts only known kinds", () => {
  assert.equal(isDocKind("fir"), true);
  assert.equal(isDocKind("FIR"), false);
  assert.equal(isDocKind(42), false);
});

test("the same words give the same fingerprint, whatever the case, spacing or punctuation", () => {
  const words = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ");
  const a = contentFingerprint([words]);
  const b = contentFingerprint([words.toUpperCase().replace(/ /g, "  \n"), ""]);
  assert.ok(a);
  assert.equal(a, b);
  assert.notEqual(a, contentFingerprint([words + " extra"]));
});

test("a very short document has no fingerprint, so it is never called a duplicate", () => {
  assert.equal(contentFingerprint(["Received. Signed."]), null);
});
