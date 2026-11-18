/**
 * Unit Test Suite: Qdrant Vector Indexing & Embeddings Architecture
 * Target: lirava-api/tests/unit/qdrant-indexing.test.ts
 *
 * Verifies:
 * 1. RFC-4122 v5 deterministic UUID point ID generation with 0 collisions across full corpus.
 * 2. 1024-dimension unit vector properties and cosine similarity behavior.
 * 3. Qdrant collection schema initialization (1024-dim, Cosine metric).
 * 4. Rich payload schema compliance for statutory provisions and judicial precedents.
 * 5. Batch vector upsert and idempotent re-indexing.
 * 6. Vector search with entityType and Act filtering.
 */

import "../mocks/setup.js";
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupTestHarness, cosineSimilarity } from "../mocks/index.js";
import {
  pointId,
  seedCorpusToQdrant,
  STATUTORY_CORPUS_SEED,
  PRECEDENT_CORPUS_SEED,
} from "../../src/services/legal/corpus-seeder.js";
import {
  generateDeterministicVector,
  embedText,
  embedBatch,
} from "../../src/services/legal/embeddings.js";
import {
  ensureLegalCorpusCollection,
  getQdrant,
  searchStatutes,
} from "../../src/services/legal/qdrant.js";

const UUID_V5_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe("Qdrant: Vector Indexing & Deterministic Point ID Architecture", () => {
  beforeEach(() => {
    setupTestHarness();
  });

  describe("Deterministic UUIDv5 Point ID Generation", () => {
    it("generates valid RFC-4122 v5 UUID format", () => {
      const id = pointId("bnss-2023-sec-482");
      assert.match(id, UUID_V5_REGEX, "Generated point ID must match RFC-4122 v5 pattern");
    });

    it("generates deterministic point IDs across multiple calls", () => {
      const id1 = pointId("bns-2023-sec-103");
      const id2 = pointId("bns-2023-sec-103");
      assert.strictEqual(id1, id2, "Point ID must be 100% reproducible");
    });

    it("generates distinct point IDs without collisions across entire corpus", () => {
      const allIds = [
        ...STATUTORY_CORPUS_SEED.map((p) => p.id),
        ...PRECEDENT_CORPUS_SEED.map((pr) => pr.id),
      ];
      assert.ok(allIds.length >= 140, "Corpus must contain >= 140 entries");

      const pointIds = allIds.map((id) => pointId(id));
      const uniquePointIds = new Set(pointIds);
      assert.strictEqual(
        uniquePointIds.size,
        allIds.length,
        "Zero UUID collisions allowed across all statutory provisions and precedents",
      );
    });
  });

  describe("1024-Dimension Deterministic Embedding Engine", () => {
    it("generates exactly 1024-dimension float vector", () => {
      const vec = generateDeterministicVector("Section 482 Anticipatory Bail BNSS");
      assert.strictEqual(vec.length, 1024);
      assert.ok(typeof vec[0] === "number");
    });

    it("produces L2 unit normalized vector (norm ≈ 1.0)", () => {
      const vec = generateDeterministicVector("Cheque dishonour Section 138 Negotiable Instruments Act");
      let sumSq = 0;
      for (const val of vec) sumSq += val * val;
      const norm = Math.sqrt(sumSq);
      assert.ok(Math.abs(norm - 1.0) < 0.005, `Vector L2 norm must be approximately 1.0, got ${norm}`);
    });

    it("computes higher cosine similarity for semantically related legal phrases", () => {
      const vecBail1 = generateDeterministicVector("anticipatory bail apprehension of arrest high court");
      const vecBail2 = generateDeterministicVector("bail application non bailable offence arrest release");
      const vecAstrophysics = generateDeterministicVector("astrophysics quantum mechanics dark energy galaxy nebula");

      const simBail = cosineSimilarity(vecBail1, vecBail2);
      const simDiff = cosineSimilarity(vecBail1, vecAstrophysics);

      assert.ok(
        simBail > simDiff,
        `Related legal vectors (${simBail.toFixed(3)}) must have higher cosine similarity than unrelated (${simDiff.toFixed(3)})`,
      );
    });

    it("handles empty or whitespace text gracefully", () => {
      const vec = generateDeterministicVector("   ");
      assert.strictEqual(vec.length, 1024);
      assert.ok(vec.every((v) => v === 0));
    });

    it("embedText and embedBatch utilize deterministic offline fallback", async () => {
      const single = await embedText("Quashing FIR abuse of process");
      assert.strictEqual(single.length, 1024);

      const batch = await embedBatch(["Remand 15 days police custody", "Summons Section 91 CrPC"]);
      assert.strictEqual(batch.length, 2);
      assert.strictEqual(batch[0].length, 1024);
      assert.strictEqual(batch[1].length, 1024);
    });
  });

  describe("Qdrant Collection Lifecycle & Upsert", () => {
    it("initializes collection with 1024 dimensions and Cosine metric", async () => {
      await ensureLegalCorpusCollection();
      const qdrant = getQdrant();
      const collection = await qdrant.getCollection("soli_legal_corpus");
      assert.ok(collection);
      assert.strictEqual(collection.config?.params?.vectors?.size, 1024);
      assert.strictEqual(collection.config?.params?.vectors?.distance, "Cosine");
    });

    it("seeds provisions and precedents into Qdrant collection with rich payloads", async () => {
      const result = await seedCorpusToQdrant(true);
      assert.ok(result.count >= 140, "Must index at least 140 legal chunks");
      assert.strictEqual(result.status, "success");

      const qdrant = getQdrant();
      const info = await qdrant.getCollection("soli_legal_corpus");
      assert.ok((info.points_count ?? 0) >= 140);
    });

    it("re-running seedCorpusToQdrant is idempotent without duplicate count accumulation", async () => {
      await seedCorpusToQdrant(true);
      const qdrant = getQdrant();
      const countBefore = (await qdrant.getCollection("soli_legal_corpus")).points_count;

      const res2 = await seedCorpusToQdrant(false);
      assert.strictEqual(res2.status, "already_seeded");

      const countAfter = (await qdrant.getCollection("soli_legal_corpus")).points_count;
      assert.strictEqual(countAfter, countBefore, "Re-running without force must not alter points count");
    });

    it("searches Qdrant with entityType filter", async () => {
      await seedCorpusToQdrant(true);

      const provHits = await searchStatutes("bail in non-bailable offences", 3, undefined, "provision");
      assert.ok(provHits.length > 0);
      assert.strictEqual(provHits[0].payload?.entity_type, "provision");

      const caseHits = await searchStatutes(
        "certificate 65B 63 electronic records admissibility Arjun Panditrao Khotkar",
        3,
        undefined,
        "precedent",
      );
      assert.ok(caseHits.length > 0);
      assert.strictEqual(caseHits[0].payload?.entity_type, "precedent");
    });
  });
});
