process.env.NODE_ENV = "test";

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MAX_MEMORY_CHARS, cleanMemory, formatMemoryBlock } from "../src/services/memories/index.js";
import { validatePreference } from "../src/services/preferences/index.js";

describe("memories", () => {
  it("collapses whitespace and rejects empty or non-text input", () => {
    assert.equal(cleanMemory("  I appear   in\n the Karnataka High Court "), "I appear in the Karnataka High Court");
    assert.equal(cleanMemory("   "), null);
    assert.equal(cleanMemory(42), null);
    assert.equal(cleanMemory(undefined), null);
  });

  it("limits a memory to its maximum length", () => {
    assert.equal(cleanMemory("a".repeat(MAX_MEMORY_CHARS + 200))?.length, MAX_MEMORY_CHARS);
  });

  it("renders nothing when there are no memories", () => {
    assert.equal(formatMemoryBlock([]), "");
  });

  it("lists memories as background and says they are not sources or instructions", () => {
    const text = formatMemoryBlock([{ content: "Prefers short paragraphs" }, { content: "Practises criminal law" }]);
    assert.match(text, /- Prefers short paragraphs/);
    assert.match(text, /- Practises criminal law/);
    assert.match(text, /background only/);
    assert.match(text, /not legal sources/);
    assert.match(text, /never cite them/);
  });

  it("accepts only a true or false value for the memoryEnabled preference", () => {
    assert.equal(validatePreference("memoryEnabled", false), false);
    assert.equal(validatePreference("memoryEnabled", true), true);
    assert.equal(validatePreference("memoryEnabled", "no"), undefined);
    assert.equal(validatePreference("memoryEnabled", null), undefined);
  });
});
