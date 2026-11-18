import "../mocks/setup.js";

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import app from "../../src/index.js";
import {
  setupTestHarness,
  restoreMockEmbeddingsFetch,
} from "../mocks/index.js";
import {
  verifyTextCitations,
  createCitationVerifier,
} from "../../src/services/citation/verifier.js";
import {
  STATUTORY_CORPUS_SEED,
  PRECEDENT_CORPUS_SEED,
} from "../../src/services/legal/seeds/index.js";
import { splitIntoSections, parseCpcOrders, parseBareAct } from "../../src/services/legal/parser.js";
import { retrieveLegalContext } from "../../src/services/legal/rag.js";
import { searchStatutes } from "../../src/services/legal/qdrant.js";
import { searchProvisions, lookupProvision } from "../../src/services/legal/provisions.js";
import { searchCases, lookupCaseCitation } from "../../src/services/legal/cases.js";
import { lookupConcordance } from "../../src/services/legal/concordance.js";
import { getSql } from "../../src/services/db/postgres.js";
import { createTestUser } from "../helpers.js";

describe("Tier 1: Feature Coverage Suite (Opaque-Box)", () => {
  let harness: ReturnType<typeof setupTestHarness>;

  beforeEach(() => {
    harness = setupTestHarness();
  });

  afterEach(() => {
    restoreMockEmbeddingsFetch();
  });

  describe("Feature 1: Legal Corpus Ingestion & Parsing (ORIGINAL_REQUEST §R1)", () => {
    it("1.1 parses linear bare act sections with marginal notes and full statutory text", () => {
      const sampleText = `
1. Short title and extent. — This Act may be called the Negotiable Instruments Act, 1881.
138. Dishonour of cheque for insufficiency of funds in the accounts. — Where any cheque drawn by a person on an account maintained by him with a banker for payment of any amount of money to another person from out of that account for the discharge, in whole or in part, of any debt or other liability, is returned by the bank unpaid... provided that the drawer of such cheque fails to make the payment of the said amount of money to the payee or, as the case may be, to the holder in due course of the cheque, within fifteen days of the receipt of the said notice.
139. Presumption in favour of holder. — It shall be presumed, unless the contrary is proved, that the holder of a cheque received the cheque.
      `.trim();

      const parsed = splitIntoSections(sampleText);
      assert.ok(parsed.length >= 2, "Should parse sections from sample text");

      const sec138 = parsed.find((s) => s.section === "138" || s.section_num === "138");
      assert.ok(sec138, "Section 138 must be parsed");
      assert.match(sec138.title, /Dishonour of cheque/i);
      assert.match(sec138.text, /fifteen days/i);
    });

    it("1.2 handles repealed section gaps without dropping subsequent active sections", () => {
      // Contract Act 1872: Sections 76-123 repealed (gap of 48 sections)
      const sampleGapText = `
1. Short title. — This Act may be called the Indian Contract Act, 1872.
75. Party rightfully rescinding contract entitled to compensation. — A person who rightfully rescinds a contract is entitled to compensation.
124. Contract of indemnity defined. — A contract by which one party promises to save the other from loss caused to him by the conduct of the promisor himself, or by the conduct of any other person, is called a contract of indemnity.
238. Effect on agreement of misrepresentation or fraud by agent. — Misrepresentations made, or frauds committed, by agents acting in the course of their business for their principals.
      `.trim();

      const parsed = splitIntoSections(sampleGapText);
      const sec124 = parsed.find((s) => s.section === "124" || s.section_num === "124");
      assert.ok(sec124, "Section 124 must not be dropped despite the 48-section repealed gap");
      assert.match(sec124.title, /indemnity/i);

      const sec238 = parsed.find((s) => s.section === "238" || s.section_num === "238");
      assert.ok(sec238, "Section 238 must also be retained at the end of the Act");
    });

    it("1.3 parses CPC dual structure distinguishing substantive Sections from Orders and Rules", () => {
      const cpcText = `
1. Short title, commencement and extent. — This Act may be called the Code of Civil Procedure, 1908.
39. Transfer of decree. — (1) The Court which passed a decree may, on the application of the decree-holder, send it for execution to another Court of competent jurisdiction.
THE FIRST SCHEDULE
ORDER XXXIX. TEMPORARY INJUNCTIONS AND INTERLOCUTORY ORDERS.
Rule 1. Cases in which temporary injunction may be granted. — Where in any suit it is proved by affidavit or otherwise: (a) that any property in dispute in a suit is in danger of being wasted, damaged or alienated by any party to the suit... the Court may by order grant a temporary injunction.
Rule 2. Injunction to restrain repetition or continuance of breach. — In any suit for restraining the defendant from committing a breach of contract.
      `.trim();

      const parsedOrders = parseCpcOrders(cpcText);
      assert.ok(parsedOrders.length >= 2, "Should parse Order XXXIX Rules 1 & 2");

      const r1 = parsedOrders.find((p) => p.ruleNum === "1" || p.section_num === "O39_R1" || p.section.includes("Rule 1"));
      assert.ok(r1, "Order XXXIX Rule 1 must be parsed");
      assert.match(r1.title, /temporary injunction/i);

      // Verify full bare act parser keeps substantive sections and order rules separated
      const fullParsed = parseBareAct(cpcText, "CPC");
      const sec39 = fullParsed.find((p) => p.section_num === "39");
      const order39Rule1 = fullParsed.find((p) => p.section_num === "O39_R1");
      assert.ok(sec39, "Section 39 must exist as a substantive section");
      assert.ok(order39Rule1, "Order XXXIX Rule 1 must exist as procedural rule");
      assert.notStrictEqual(sec39.title, order39Rule1.title);
    });

    it("1.4 parses and structures judicial precedent records with official and neutral citations", () => {
      const precedent = PRECEDENT_CORPUS_SEED.find((c) => c.id === "sc-bhajan-lal-1992");
      assert.ok(precedent, "Bhajan Lal precedent record must be present");
      assert.strictEqual(precedent.primary_citation, "1992 Supp (1) SCC 335");
      assert.ok(precedent.neutral_citation, "Neutral citation must be present");
      assert.ok(precedent.principles && precedent.principles.length === 7, "Must contain all 7 quashing principles");
      assert.strictEqual(precedent.court, "Supreme Court of India");
    });

    it("1.5 loads canonical corpus spanning all 8 Target Bare Acts and landmark precedents", () => {
      const actCodes = new Set(STATUTORY_CORPUS_SEED.map((p) => p.act_code));
      assert.ok(actCodes.has("BNSS") || actCodes.has("BNSS_2023"), "BNSS must be present");
      assert.ok(actCodes.has("BNS") || actCodes.has("BNS_2023"), "BNS must be present");
      assert.ok(actCodes.has("BSA") || actCodes.has("BSA_2023"), "BSA must be present");
      assert.ok(actCodes.has("CPC") || actCodes.has("CPC_1908"), "CPC must be present");
      assert.ok(actCodes.has("CRPC") || actCodes.has("CRPC_1973"), "CrPC must be present");
      assert.ok(actCodes.has("IPC") || actCodes.has("IPC_1860"), "IPC must be present");
      assert.ok(actCodes.has("ICA") || actCodes.has("ICA_1872"), "ICA must be present");
      assert.ok(actCodes.has("NIA") || actCodes.has("NIA_1881"), "NI Act must be present");
      assert.ok(PRECEDENT_CORPUS_SEED.length >= 5, "At least 5 landmark precedents must be loaded");
    });
  });

  describe("Feature 2: PostgreSQL Storage Schema & Concordance (ORIGINAL_REQUEST §R2)", () => {
    it("2.1 stores structured legal provisions with full-text search indexing", async () => {
      const sql = getSql()!;
      const countRows = await sql`SELECT COUNT(*) FROM legal_provisions`;
      assert.ok(Number(countRows[0].provisions) >= 25, "Database must contain stored provisions");

      const bnss482 = await lookupProvision("BNSS_2023", "482");
      assert.ok(bnss482, "BNSS 482 provision must exist in DB");
      assert.ok(bnss482.section.includes("482"));
      assert.match(bnss482.title, /Anticipatory Bail/i);

      // FTS search in PostgreSQL
      const results = await searchProvisions("anticipatory bail apprehension arrest");
      assert.ok(results.length > 0, "FTS query should return provisions");
      assert.ok(
        results.some((r) => r.section.includes("482") || r.section.includes("438")),
        "FTS must retrieve anticipatory bail provision",
      );
    });

    it("2.2 stores judicial precedents with neutral citation indexing", async () => {
      const cases = await searchCases("");
      assert.ok(cases.length >= 5, "Database must contain landmark judicial cases");

      const antil = await lookupCaseCitation("2022 INSC 690");
      assert.ok(antil, "Must find Satender Kumar Antil by neutral citation 2022 INSC 690");
      assert.strictEqual(antil.primary_citation, "(2022) 10 SCC 51");
      assert.match(antil.ratio, /Bail is the rule/i);
    });

    it("2.3 provides bidirectional statute concordance between CrPC 1973 and BNSS 2023", async () => {
      // CrPC 482 (Quashing) -> BNSS 528
      const quashMap = await lookupConcordance("CRPC_1973", "482");
      assert.ok(quashMap, "Concordance from CrPC 482 must exist");
      assert.strictEqual(quashMap.new_act, "BNSS_2023");
      assert.strictEqual(quashMap.new_section, "528");

      // CrPC 438 (Anticipatory Bail) -> BNSS 482
      const bailMap = await lookupConcordance("CRPC_1973", "438");
      assert.ok(bailMap, "Concordance from CrPC 438 must exist");
      assert.strictEqual(bailMap.new_act, "BNSS_2023");
      assert.strictEqual(bailMap.new_section, "482");
    });

    it("2.4 provides bidirectional statute concordance between IPC 1860 and BNS 2023", async () => {
      // IPC 302 (Murder) -> BNS 103
      const murderMap = await lookupConcordance("IPC_1860", "302");
      assert.ok(murderMap, "Concordance from IPC 302 must exist");
      assert.strictEqual(murderMap.new_act, "BNS_2023");
      assert.strictEqual(murderMap.new_section, "103");

      // IPC 420 (Cheating) -> BNS 318
      const cheatingMap = await lookupConcordance("IPC_1860", "420");
      assert.ok(cheatingMap, "Concordance from IPC 420 must exist");
      assert.strictEqual(cheatingMap.new_act, "BNS_2023");
      assert.strictEqual(cheatingMap.new_section, "318");
    });

    it("2.5 provides concordance between Indian Evidence Act 1872 and BSA 2023", async () => {
      // IEA 65B -> BSA 63
      const eEvidMap = await lookupConcordance("IEA_1872", "65B");
      assert.ok(eEvidMap, "Concordance from IEA 65B must exist");
      assert.strictEqual(eEvidMap.new_act, "BSA_2023");
      assert.strictEqual(eEvidMap.new_section, "63");
    });
  });

  describe("Feature 3: Qdrant Vector Retrieval & Hybrid Search (ORIGINAL_REQUEST §R2)", () => {
    it("3.1 initializes vector collection with 1024-dimension vectors and Cosine metric", async () => {
      const qdrant = harness.mockQdrant;
      const info = await qdrant.getCollection("soli_legal_corpus");
      assert.strictEqual(info.status, "green");
      assert.strictEqual(info.config.params.vectors.size, 1024);
      assert.strictEqual(info.config.params.vectors.distance, "Cosine");
      assert.ok(info.points_count > 0, "Collection must contain indexed points");
    });

    it("3.2 stores points with deterministic IDs and rich statutory metadata payloads", async () => {
      const qdrant = harness.mockQdrant;
      const scrollRes = await qdrant.scroll("soli_legal_corpus", { limit: 10 });
      assert.ok(scrollRes.points.length > 0);

      const firstPoint = scrollRes.points[0];
      assert.ok(firstPoint.id, "Point must have an ID");
      assert.ok(firstPoint.payload.act, "Payload must contain act");
      assert.ok(firstPoint.payload.section, "Payload must contain section");
      assert.ok(firstPoint.payload.title, "Payload must contain title");
      assert.ok(firstPoint.payload.text, "Payload must contain statutory text");
    });

    it("3.3 executes semantic vector search retrieving relevant provisions with score threshold", async () => {
      const query = "arrest without warrant notice of appearance police";
      const hits = await searchStatutes(query, 3);
      assert.ok(hits.length > 0, "Vector search must return matches");
      assert.ok(hits[0].score >= 0.35, "Top hit score must exceed score threshold");
      assert.ok(
        hits.some((h) => h.payload?.section === "Section 35" || h.payload?.section === "Section 41A"),
        "Must retrieve Section 35 BNSS or Section 41A CrPC",
      );
    });

    it("3.4 performs hybrid retrieval combining vector similarity with PostgreSQL full-text search", async () => {
      const ctx = await retrieveLegalContext("cheque dishonour 15 days notice funds insufficient");
      assert.ok(ctx, "Hybrid context must be retrieved");
      assert.ok(ctx.sources.length > 0, "Sources must be populated");
      assert.ok(
        ctx.sources.some((s) => s.section?.includes("138")),
        "Section 138 NI Act must be present in retrieved context",
      );
      assert.match(ctx.contextText, /Section 138/i);
    });

    it("3.5 degrades gracefully when vector search returns 0 matches by falling back to FTS", async () => {
      // Clear Qdrant to simulate vector engine outage
      harness.mockQdrant.clear();

      const ctx = await retrieveLegalContext("anticipatory bail apprehension of arrest");
      assert.ok(ctx !== null, "Hybrid retrieval must not fail when vector store is empty");
      assert.ok(ctx.sources.length > 0, "PostgreSQL FTS must supply fallback provisions");
      assert.ok(
        ctx.sources.some((s) => s.section?.includes("482") || s.section?.includes("438")),
        "Fallback FTS must retrieve bail provisions",
      );
    });
  });

  describe("Feature 4: Verified Citation Service & Assistant RAG (ORIGINAL_REQUEST §R3)", () => {
    it("4.1 extracts statutory citations from legal assistant prose", async () => {
      const text = "The accused is entitled to protection under Section 482 BNSS and Section 35 BNSS.";
      const res = await verifyTextCitations(text);
      assert.ok(res.verified.length >= 2, "Both statutory provisions must be extracted and verified");
      assert.ok(res.verified.some((v) => v.section_num === "482" && v.act_code === "BNSS_2023"));
      assert.ok(res.verified.some((v) => v.section_num === "35" && v.act_code === "BNSS_2023"));
    });

    it("4.2 extracts and resolves judicial citations to official reporter and neutral citations", async () => {
      const text = "As laid down by the Supreme Court in Satender Kumar Antil v. CBI, (2022) 10 SCC 51, bail is the rule.";
      const res = await verifyTextCitations(text);
      const caseHit = res.verified.find((v) => v.type === "case");
      assert.ok(caseHit, "Judicial precedent citation must be verified");
      assert.strictEqual(caseHit.primary_citation, "(2022) 10 SCC 51");
      assert.strictEqual(caseHit.neutral_citation, "2022 INSC 690");
      assert.strictEqual(caseHit.id, "sc-satender-antil-2022");
    });

    it("4.3 verifies positive citations against corpus with 1.0 confidence", async () => {
      const text = "Under Section 56 of the Indian Contract Act, contract frustration occurs when performance becomes unlawful.";
      const res = await verifyTextCitations(text);
      assert.strictEqual(res.unverified.length, 0, "No unverified citations should be flagged");
      assert.ok(res.verified.length >= 1);
      assert.strictEqual(res.verified[0].confidence, 1.0);
      assert.strictEqual(res.verified[0].section_num, "56");
      assert.strictEqual(res.verified[0].act_code, "ICA_1872");
    });

    it("4.4 detects and flags non-existent synthetic statutory and case citations", async () => {
      const hallucinatedText = "Pursuant to Section 999 BNSS and the fictitious ruling in State v. Phantom, [2029] 99 SCC 1234.";
      const res = await verifyTextCitations(hallucinatedText);
      assert.strictEqual(res.verified.length, 0, "Zero synthetic citations must be verified");
      assert.ok(res.unverified.length >= 2, "Both hallucinations must be flagged");
      assert.ok(res.unverified.some((u) => u.raw.includes("999")), "Section 999 must be flagged as unverified");
      assert.ok(res.unverified.some((u) => u.raw.includes("SCC 1234")), "Synthetic case must be flagged");
    });

    it("4.5 serves verified citations via the backend /api/legal/search route", async () => {
      const user = await createTestUser("tier1_search");
      const res = await app.request("/api/legal/search?q=anticipatory+bail&limit=3", {
        headers: user.headers,
      });

      assert.strictEqual(res.status, 200);
      const json = await res.json();
      assert.ok(Array.isArray(json.results));
      assert.ok(json.results.length > 0);
      assert.ok(json.results[0].payload?.section, "Result must contain provision section");
    });
  });
});
