/**
 * Unit Test Suite: Hybrid Retrieval Engine (`rag.ts`) & Graceful Degradation
 * Target: lirava-api/tests/unit/hybrid-retrieval.test.ts
 *
 * Verifies:
 * 1. Concurrent hybrid retrieval combining dense vector search and full-text search.
 * 2. Deduplication of identical provisions/cases across search channels.
 * 3. Precedent and statutory formatting under strict courtroom directives.
 * 4. Length budget enforcement (maxChars truncation).
 * 5. Graceful offline degradation when vector store, relational store, or both are unavailable.
 */

import "../mocks/setup.js";
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupTestHarness, getMockQdrant, getMockDatabase } from "../mocks/index.js";
import { retrieveLegalContext } from "../../src/services/legal/rag.js";

describe("RAG: Hybrid Retrieval Engine & Fault Tolerance", () => {
  beforeEach(() => {
    setupTestHarness();
  });

  describe("Query Validation & Input Hygiene", () => {
    it("returns null immediately for empty string", async () => {
      const res = await retrieveLegalContext("");
      assert.strictEqual(res, null);
    });

    it("returns null immediately for whitespace-only query", async () => {
      const res = await retrieveLegalContext("    \t\n   ");
      assert.strictEqual(res, null);
    });
  });

  describe("Hybrid Retrieval & Deduplication", () => {
    it("retrieves unified context containing statutory provisions and precedents", async () => {
      const res = await retrieveLegalContext("anticipatory bail apprehension of arrest BNSS 482", 2000);
      assert.ok(res, "Retrieval result must not be null");
      assert.ok(res.contextText.length > 0);
      assert.ok(res.sources.length > 0);
      assert.ok(res.documentTitle);

      // Verify formatted output structure
      assert.match(res.contextText, /\[PROVISION\]/);
      // A bail provision is among them, and a precedent travels with it. (Which bail section ranks first depends on the search
      // scores, which are meaningless with the offline mock vectors, so any of the bail sections of the BNSS counts.)
      assert.ok(res.sources.some((s) => s.section && /\b48[0-3]\b/.test(s.section)));
      assert.ok(res.sources.some((s) => /SCC|Supreme/.test(`${s.act} ${s.section}`)));
    });

    it("deduplicates results when the same provision appears in both vector and FTS hits", async () => {
      const res = await retrieveLegalContext("cheque dishonour section 138 negotiable instruments act", 2500);
      assert.ok(res);

      const sectionKeys = res.sources.map((s) => `${s.act}|${s.section}`.toLowerCase());
      const uniqueKeys = new Set(sectionKeys);
      assert.strictEqual(
        uniqueKeys.size,
        sectionKeys.length,
        "Retrieved context must not contain duplicate provisions",
      );
    });

    it("caps retrieved candidate items to MAX_CANDIDATES (4)", async () => {
      const res = await retrieveLegalContext("bail arrest police custody remand offences", 4000);
      assert.ok(res);
      assert.ok(res.sources.length <= 4, `Sources count (${res.sources.length}) must be <= 4`);
    });
  });

  describe("Length Budget & Context Truncation", () => {
    it("truncates context cleanly when exceeding maxChars budget", async () => {
      const smallBudget = 250;
      const res = await retrieveLegalContext("anticipatory bail apprehension of arrest", smallBudget);
      assert.ok(res);
      assert.ok(
        res.contextText.length <= smallBudget + 50,
        `Context length (${res.contextText.length}) should not exceed budget + truncation notice`,
      );
      assert.match(res.contextText, /\.\.\.\[truncated for length\]/);
    });

    it("does not truncate when content fits within maxChars budget", async () => {
      const largeBudget = 10000;
      const res = await retrieveLegalContext("anticipatory bail Section 482", largeBudget);
      assert.ok(res);
      assert.doesNotMatch(res.contextText, /\.\.\.\[truncated for length\]/);
    });
  });

  describe("Fault Tolerance & Offline Fallback Degradation", () => {
    it("degrades gracefully to FTS when Qdrant vector index is completely empty", async () => {
      const mockQdrant = getMockQdrant();
      await mockQdrant.deleteCollection("soli_legal_corpus");

      const res = await retrieveLegalContext("anticipatory bail Section 482", 1500);
      assert.ok(res, "Must return PostgreSQL FTS hits even if Qdrant collection is absent");
      assert.ok(res.sources.length > 0);
      assert.ok(res.sources.some((s) => s.section && s.section.includes("482")));
    });

    it("degrades gracefully to vector retrieval when PostgreSQL stores no matching rows", async () => {
      const mockDb = getMockDatabase();
      mockDb.legalProvisions.clear();
      mockDb.legalCases.clear();

      const res = await retrieveLegalContext("anticipatory bail arrest release", 1500);
      assert.ok(res, "Must return Qdrant vector hits even when PostgreSQL tables are empty");
      assert.ok(res.sources.length > 0);
    });

    it("returns null cleanly without throwing when both vector and FTS yield zero matches", async () => {
      const mockQdrant = getMockQdrant();
      const mockDb = getMockDatabase();
      await mockQdrant.deleteCollection("soli_legal_corpus");
      mockDb.legalProvisions.clear();
      mockDb.legalCases.clear();

      const res = await retrieveLegalContext("completely unrelated extraterrestrial astrophysics", 1500);
      assert.strictEqual(res, null, "Must return null cleanly without throwing exceptions");
    });
  });
});
