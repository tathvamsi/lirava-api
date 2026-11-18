/**
 * Unit Test Suite: Statute Concordance & Judicial Precedent Citation Lookups
 * Target: lirava-api/tests/unit/concordance.test.ts
 *
 * Verifies:
 * 1. Bidirectional statute concordance between colonial acts (CrPC, IPC, IEA) and 2023 Sanhitas (BNSS, BNS, BSA).
 * 2. Prefix and formatting tolerance ("Section 482" -> "482").
 * 3. Act code normalization across short ("CRPC") and suffixed ("CRPC_1973") conventions.
 * 4. Multi-reporter case citation resolution (primary, neutral, equivalent, and canonical ID).
 * 5. Clean handling of non-existent provisions and judgments.
 */

import "../mocks/setup.js";
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupTestHarness } from "../mocks/index.js";
import {
  normalizeActCode,
  lookupModernConcordance,
  lookupColonialConcordance,
  getAllConcordanceMappings,
  lookupConcordance,
} from "../../src/services/legal/concordance.js";
import { lookupCaseCitation, searchCases } from "../../src/services/legal/cases.js";

describe("Concordance: Colonial ↔ Sanhita Transitions", () => {
  beforeEach(() => {
    setupTestHarness();
  });

  describe("Act Code Normalization", () => {
    it("normalizes CrPC variations to canonical base and candidates", () => {
      const crpc = normalizeActCode("CrPC");
      assert.strictEqual(crpc.base, "CRPC");
      assert.strictEqual(crpc.normalized, "CRPC_1973");
      assert.ok(crpc.candidates.includes("CRPC_1973"));
      assert.ok(crpc.candidates.includes("CRPC"));
    });

    it("normalizes IPC variations to canonical base and candidates", () => {
      const ipc = normalizeActCode("IPC_1860");
      assert.strictEqual(ipc.base, "IPC");
      assert.strictEqual(ipc.normalized, "IPC_1860");
    });

    it("normalizes Evidence Act variations to IEA", () => {
      const iea = normalizeActCode("Indian Evidence Act");
      assert.strictEqual(iea.base, "IEA");
      assert.strictEqual(iea.normalized, "IEA_1872");
    });

    it("normalizes Sanhita codes (BNSS, BNS, BSA)", () => {
      assert.strictEqual(normalizeActCode("BNSS").base, "BNSS");
      assert.strictEqual(normalizeActCode("BNS_2023").base, "BNS");
      assert.strictEqual(normalizeActCode("BSA").base, "BSA");
    });
  });

  describe("Bidirectional Mapping Lookups", () => {
    it("maps CrPC 482 (Quashing) to BNSS 528 and vice versa", async () => {
      const modern = await lookupModernConcordance("CRPC_1973", "482");
      assert.ok(modern.length > 0, "CrPC 482 must resolve to BNSS");
      assert.strictEqual(modern[0].new_act, "BNSS_2023");
      assert.strictEqual(modern[0].new_section, "528");

      const colonial = await lookupColonialConcordance("BNSS_2023", "528");
      assert.ok(colonial.length > 0, "BNSS 528 must resolve back to CrPC");
      assert.strictEqual(colonial[0].old_act, "CRPC_1973");
      assert.strictEqual(colonial[0].old_section, "482");
    });

    it("handles 'Section ' prefix gracefully", async () => {
      const res = await lookupModernConcordance("CRPC_1973", "Section 438");
      assert.ok(res.length > 0);
      assert.strictEqual(res[0].new_section, "482");
    });

    it("maps IPC 302 (Murder) to BNS 103 and vice versa", async () => {
      const modern = await lookupModernConcordance("IPC_1860", "302");
      assert.ok(modern.length > 0);
      assert.strictEqual(modern[0].new_act, "BNS_2023");
      assert.strictEqual(modern[0].new_section, "103");

      const colonial = await lookupColonialConcordance("BNS_2023", "103");
      assert.ok(colonial.length > 0);
      assert.strictEqual(colonial[0].old_section, "302");
    });

    it("maps IEA 65B (Electronic Evidence) to BSA 63", async () => {
      const modern = await lookupModernConcordance("IEA_1872", "65B");
      assert.ok(modern.length > 0);
      assert.strictEqual(modern[0].new_act, "BSA_2023");
      assert.strictEqual(modern[0].new_section, "63");
    });

    it("maps IPC 420 (Cheating) to BNS 318", async () => {
      const match = await lookupConcordance("IPC_1860", "420");
      assert.ok(match);
      assert.strictEqual(match.new_section, "318");
    });

    it("returns empty array for non-existent concordance mappings", async () => {
      const invalid = await lookupModernConcordance("CRPC_1973", "9999");
      assert.deepStrictEqual(invalid, []);

      const invalidCol = await lookupColonialConcordance("BNSS_2023", "9999");
      assert.deepStrictEqual(invalidCol, []);
    });

    it("retrieves all concordance mappings", async () => {
      const all = await getAllConcordanceMappings();
      assert.ok(all.length >= 10, "Should return seeded concordance catalog");
    });
  });

  describe("Judicial Precedent Citation Resolution", () => {
    it("resolves landmark case by primary citation", async () => {
      const c = await lookupCaseCitation("(2022) 10 SCC 51");
      assert.ok(c, "Must find Satender Kumar Antil by primary citation");
      assert.match(c.case_title, /Satender Kumar Antil/i);
      assert.strictEqual(c.year, 2022);
    });

    it("resolves landmark case by official neutral citation (INSC)", async () => {
      const c = await lookupCaseCitation("2022 INSC 690");
      assert.ok(c, "Must find Satender Kumar Antil by neutral citation 2022 INSC 690");
      assert.strictEqual(c.primary_citation, "(2022) 10 SCC 51");
    });

    it("resolves landmark case by equivalent reporter citation (AIR)", async () => {
      const c = await lookupCaseCitation("AIR 1992 SC 604");
      assert.ok(c, "Must find Bhajan Lal by equivalent citation AIR 1992 SC 604");
      assert.match(c.case_title, /Bhajan Lal/i);
    });

    it("resolves landmark case by internal identifier", async () => {
      const c = await lookupCaseCitation("sc-bhajan-lal-1992");
      assert.ok(c);
      assert.strictEqual(c.primary_citation, "1992 Supp (1) SCC 335");
    });

    it("returns null for non-existent synthetic citation", async () => {
      const c = await lookupCaseCitation("2099 INSC 99999");
      assert.strictEqual(c, null);
    });

    it("searches cases by text keyword or ratio", async () => {
      const cases = await searchCases("quashing fir abuse of process", 5);
      assert.ok(cases.length > 0, "Case search should return relevant precedents");
      assert.ok(cases.some((cs) => cs.case_title.includes("Bhajan Lal")));
    });
  });
});
