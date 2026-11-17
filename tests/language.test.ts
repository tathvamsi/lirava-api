process.env.NODE_ENV = "test";

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DOCUMENT_LANGUAGES, isDocumentLanguage, languageSection } from "../src/services/agent/language.js";
import { validatePreference } from "../src/services/preferences/index.js";

describe("document language", () => {
  it("offers English, Hindi, Kannada, Tamil, Telugu and Marathi", () => {
    assert.deepEqual(Object.keys(DOCUMENT_LANGUAGES), ["en", "hi", "kn", "ta", "te", "mr"]);
  });

  it("with nothing saved, tells the assistant to ask before writing a document, naming all six languages", () => {
    const text = languageSection(undefined);
    assert.match(text, /has not said which language/);
    assert.match(text, /do not start writing/);
    for (const l of Object.values(DOCUMENT_LANGUAGES)) assert.ok(text.includes(l.name), `mentions ${l.name}`);
    assert.match(text, /names a language.*already answers the question/s);
  });

  it("limits the question to documents, so ordinary questions are still answered at once", () => {
    assert.match(languageSection(undefined), /only for documents/);
  });

  it("with a language saved, says to use it and to let a named language win for that one document", () => {
    const text = languageSection("kn");
    assert.match(text, /saved language for documents is Kannada/);
    assert.match(text, /names a different language/);
    assert.doesNotMatch(text, /Which language should I write this in/);
  });

  it("treats an unknown saved value as nothing saved", () => {
    assert.match(languageSection("klingon"), /has not said which language/);
  });

  it("always keeps citations and section references checkable and marks translations as unofficial", () => {
    for (const saved of [undefined, "ta"]) {
      const text = languageSection(saved);
      assert.match(text, /2023 INSC 1043/);
      assert.match(text, /Section 103 BNS/);
      assert.match(text, /unofficial translation/);
    }
  });

  it("recognises only the six codes", () => {
    for (const code of ["en", "hi", "kn", "ta", "te", "mr"]) assert.equal(isDocumentLanguage(code), true);
    for (const bad of ["EN", "kannada", "", null, 3, "bn", "toString", "constructor"]) assert.equal(isDocumentLanguage(bad), false);
  });

  it("saves the preference only for a valid code", () => {
    assert.equal(validatePreference("documentLanguage", "te"), "te");
    assert.equal(validatePreference("documentLanguage", "tamil"), undefined);
    assert.equal(validatePreference("documentLanguage", { x: 1 }), undefined);
  });
});
