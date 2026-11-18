process.env.NODE_ENV = "test";

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { namesDisagree, selectPairs, type MinedEdge, type Resolver } from "../src/services/library/parallel-cites.js";

const edge = (anchor: string, other: string, count = 3, names: string[] = []): MinedEdge => ({ anchor, other, count, files: ["scj:x"], names });

const library: Record<string, { id: string; title: string } | "ambiguous"> = {
  "SCR:2007:3:507": { id: "scj:goa", title: "STATE OF GOA v. SANJAY THAKRAN" },
  "SCR:2009:6:982": { id: "scj:nepal", title: "NEPAL SINGH v. STATE OF HARYANA" },
  "SCR:2001:1:1": "ambiguous",
};
const resolve: Resolver = (k) => library[k] ?? null;

describe("which mined parallel citations may become keys", () => {
  it("accepts a pair printed several times whose anchor is one known case", () => {
    const { accepted, rejected } = selectPairs([edge("SCR:2007:3:507", "SCC:2007:3:755", 4, ["State of Goa v. Sanjay Thakran"])], resolve);
    assert.deepEqual(accepted, [{ key: "SCC:2007:3:755", caseId: "scj:goa", count: 4 }]);
    assert.equal(Object.values(rejected).reduce((a, b) => a + b, 0), 0);
  });

  it("drops a pair whose anchor is not in the library, or is shared by two cases", () => {
    const { accepted, rejected } = selectPairs([edge("SCR:1999:9:9", "SCC:1999:9:9"), edge("SCR:2001:1:1", "SCC:2001:1:2")], resolve);
    assert.equal(accepted.length, 0);
    assert.equal(rejected.anchor_unknown, 1);
    assert.equal(rejected.anchor_ambiguous, 1);
  });

  it("drops a pair printed beside a name that does not fit the library's title", () => {
    const { accepted, rejected } = selectPairs([edge("SCR:2007:3:507", "SCC:2007:3:755", 5, ["Arnesh Kumar v. State of Bihar"])], resolve);
    assert.equal(accepted.length, 0);
    assert.equal(rejected.name_mismatch, 1);
  });

  it("does not reject for lack of a printed name, and ignores 'Case Law Cited' noise in one", () => {
    assert.equal(selectPairs([edge("SCR:2007:3:507", "SCC:2007:3:755", 3, [])], resolve).accepted.length, 1);
    assert.equal(selectPairs([edge("SCR:2007:3:507", "SCC:2007:3:755", 3, ["Case Law Cited State of Goa v. Sanjay Thakran"])], resolve).accepted.length, 1);
  });

  it("needs the pair to be printed at least twice by default", () => {
    const { accepted, rejected } = selectPairs([edge("SCR:2007:3:507", "SCC:2007:3:755", 1)], resolve);
    assert.equal(accepted.length, 0);
    assert.equal(rejected.too_few_sightings, 1);
    assert.equal(selectPairs([edge("SCR:2007:3:507", "SCC:2007:3:755", 1)], resolve, { minCount: 1 }).accepted.length, 1);
  });

  it("keeps the SCC number a case is printed with most often, and drops a case with two close rivals", () => {
    const dominant = selectPairs([edge("SCR:2007:3:507", "SCC:2007:3:755", 9), edge("SCR:2007:3:507", "SCC:2007:3:775", 2)], resolve);
    assert.deepEqual(dominant.accepted.map((a) => a.key), ["SCC:2007:3:755"]);
    const close = selectPairs([edge("SCR:2007:3:507", "SCC:2007:3:755", 3), edge("SCR:2007:3:507", "SCC:2007:3:775", 2)], resolve);
    assert.equal(close.accepted.length, 0);
    assert.equal(close.rejected.conflict_same_case, 2);
  });

  it("allows one SCC and one AIR for the same case, since they are different series", () => {
    const { accepted } = selectPairs([edge("SCR:2007:3:507", "SCC:2007:3:755", 3), edge("SCR:2007:3:507", "AIR:2007:SC:100", 3)], resolve);
    assert.deepEqual(accepted.map((a) => a.key).sort(), ["AIR:2007:SC:100", "SCC:2007:3:755"]);
  });

  it("drops a citation claimed by two different cases, for both", () => {
    const { accepted, rejected } = selectPairs([edge("SCR:2007:3:507", "SCC:2009:12:351", 3), edge("SCR:2009:6:982", "SCC:2009:12:351", 3)], resolve);
    assert.equal(accepted.length, 0);
    assert.equal(rejected.conflict_same_citation, 2);
  });

  it("compares names by whole words of four letters or more, ignoring State, Union and the like", () => {
    assert.equal(namesDisagree(["State of Goa v. Sanjay Thakran"], "STATE OF GOA v. SANJAY THAKRAN"), false);
    assert.equal(namesDisagree(["State of Bihar v. Ram"], "STATE OF GOA v. SANJAY THAKRAN"), true, "only 'State' in common, which does not count");
    assert.equal(namesDisagree([], "ANY TITLE HERE"), false);
    assert.equal(namesDisagree(["X v. Y"], "ANY TITLE HERE"), false, "nothing comparable in the printed name");
  });
});
