process.env.NODE_ENV = "test";

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fixtureStore, loadGold, runGold, summarise } from "./gold-runner.js";

/**
 * The gold set: real Supreme Court citations and statute sections sampled from the loaded data, plus invented, mismatched,
 * not-covered, native-script and look-alike text. Built by scripts/build-gold.ts; runs against a library held in memory.
 *
 * The rule that matters most: nothing may be "verified" that the gold set says must not be (zero false verifications).
 */
const fixture = loadGold();
const results = await runGold(fixture.cases, fixtureStore(fixture));
const summary = summarise(results);

describe("citation gold set", () => {
  it("is large enough to mean something, and covers every category", () => {
    assert.ok(fixture.cases.length >= 300, `only ${fixture.cases.length} cases`);
    const cats = new Set(fixture.cases.map((c) => c.category));
    for (const c of ["real_insc", "real_scr", "wrong_name", "invented_insc", "invented_scr", "scc_not_covered", "air_not_covered", "statute_present", "statute_section_missing", "indic_statute_hi", "indic_statute_kn", "indic_statute_ta", "indic_statute_te", "indic_statute_mr", "injection", "no_citation", "mixed_answer"]) {
      assert.ok(cats.has(c), `missing category ${c}`);
    }
  });

  it("never verifies something it must not (zero false verifications)", () => {
    const bad = results.filter((r) => r.falseVerified).map((r) => `${r.gold.id} [${r.gold.category}] ${r.gold.text}`);
    assert.deepEqual(bad, []);
  });

  it("raises no false alarm on text with nothing to check", () => {
    const bad = results.filter((r) => r.falseAlarm).map((r) => `${r.gold.id} [${r.gold.category}] ${r.gold.text} -> ${JSON.stringify(r.actual)}`);
    assert.deepEqual(bad, []);
  });

  it("verifies every real citation and section it should", () => {
    const bad = results.filter((r) => r.missedVerification).map((r) => `${r.gold.id} [${r.gold.category}] ${r.gold.text} -> ${JSON.stringify(r.actual)}`);
    assert.deepEqual(bad, []);
  });

  it("gives every case exactly the verdict the gold set expects", () => {
    const bad = results.filter((r) => !r.pass).map((r) => `${r.gold.id} [${r.gold.category}] ${r.gold.text}\n    expected ${JSON.stringify(r.gold.expect)}\n    got      ${JSON.stringify(r.actual)}`);
    assert.deepEqual(bad, []);
  });

  it("prints the result by category", () => {
    const rows = [...summary.byCategory.entries()].map(([c, v]) => `${c.padEnd(30)} ${v.pass}/${v.n}`);
    console.log(`gold set: ${summary.passed}/${summary.total} as expected; false verifications ${summary.falseVerified}; false alarms ${summary.falseAlarms}\n${rows.join("\n")}`);
    assert.equal(summary.total, fixture.cases.length);
  });
});
