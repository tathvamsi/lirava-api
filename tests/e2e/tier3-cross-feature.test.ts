import "../mocks/setup.js";

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import app from "../../src/index.js";
import {
  setupTestHarness,
  restoreMockEmbeddingsFetch,
  generateDeterministicVector,
} from "../mocks/index.js";
import {
  verifyTextCitations,
} from "../../src/services/citation/verifier.js";
import { splitIntoSections } from "../../src/services/legal/parser.js";
import { upsertProvisions } from "../../src/services/legal/provisions.js";
import { retrieveLegalContext } from "../../src/services/legal/rag.js";
import { searchStatutes, upsertLegalChunks } from "../../src/services/legal/qdrant.js";
import { createTestUser } from "../helpers.js";

describe("Tier 3: Cross-Feature Integration Pipelines (Pairwise & E2E)", () => {
  let harness: ReturnType<typeof setupTestHarness>;

  beforeEach(() => {
    harness = setupTestHarness();
  });

  afterEach(() => {
    restoreMockEmbeddingsFetch();
  });

  it("Pipeline 1: Full Ingestion -> Store -> Index -> Search -> Verify Flow (NI Act 138)", async () => {
    // 1. Raw statutory text ingestion
    const rawActText = `
1. Short title. — Negotiable Instruments Act, 1881.
138. Dishonour of cheque for insufficiency of funds in the accounts. — Where any cheque drawn by a person on an account maintained by him with a banker for payment of any amount of money to another person from out of that account for the discharge, in whole or in part, of any debt or other liability, is returned by the bank unpaid... provided that the drawer of such cheque fails to make the payment of the said amount of money to the payee within fifteen days of the receipt of the said notice.
    `.trim();

    const sections = splitIntoSections(rawActText);
    assert.strictEqual(sections.length, 2);
    const sec138 = sections.find((s) => s.section === "138");
    assert.ok(sec138, "Section 138 must be parsed");

    // 2. Store in PostgreSQL legal_provisions
    const storedCount = await upsertProvisions({
      act: "Negotiable Instruments Act, 1881",
      year: 1881,
      source: "Official Gazette",
      category: "commercial",
      sections: [sec138],
    });
    assert.ok(storedCount >= 1, "Must store provision in database");

    // 3. Generate deterministic vector and index in Qdrant
    const chunkText = `Negotiable Instruments Act, 1881 - Section 138: ${sec138.title}\n${sec138.text}`;
    const vector = generateDeterministicVector(chunkText, 1024);
    await upsertLegalChunks([
      {
        id: "pipeline1-sec-138",
        vector,
        payload: {
          act: "Negotiable Instruments Act, 1881",
          section: "Section 138",
          title: sec138.title,
          text: sec138.text,
          statutoryText: sec138.text,
          ratio: "Strict liability offence with 15-day cure notice requirement.",
          source: "Bare Act: NI Act 1881",
          year: 1881,
          category: "commercial",
        },
      },
    ]);

    // 4. Execute hybrid retrieval query
    const context = await retrieveLegalContext("cheque dishonour unpaid funds insufficient fifteen days notice");
    assert.ok(context, "Hybrid context must be returned");
    assert.ok(context.sources.length > 0, "Sources must be populated");
    assert.ok(
      context.sources.some((s) => s.section?.includes("138")),
      "Section 138 must be retrieved by hybrid search",
    );

    // 5. Pass generated legal advice text to citation verifier
    const generatedAnswer = `Under Section 138 of the Negotiable Instruments Act, the payee must issue a statutory demand notice within 30 days giving the drawer 15 days to pay.`;
    const verification = await verifyTextCitations(generatedAnswer);

    // 6. Assert verification success
    assert.ok(verification.verified.length >= 1, "Must verify the citation");
    assert.strictEqual(verification.unverified.length, 0, "Must have 0 unverified citations");
    const verifiedSec = verification.verified[0];
    assert.strictEqual(verifiedSec.section_num, "138");
    assert.strictEqual(verifiedSec.confidence, 1.0);
    assert.strictEqual(verifiedSec.status, "verified");
  });

  it("Pipeline 2: Concordance Bridge & Transition Verification Flow (CrPC 482 -> BNSS 528)", async () => {
    // 1. A legacy petition references Section 482 CrPC for quashing FIR
    const legacyDraft = "The petitioner moves this petition under Section 482 CrPC for quashing of FIR No. 123.";

    // 2. Verifier extracts the legacy provision
    const initialVerification = await verifyTextCitations(legacyDraft);
    const crpcCit = initialVerification.verified.find((v) => v.section_num === "482" && v.act_code === "CRPC_1973");
    assert.ok(crpcCit, "Legacy Section 482 CrPC citation must be identified");

    // 3. Concordance engine looks up the replacement provision under BNSS 2023
    const db = harness.mockDb;
    const mapping = Array.from(db.statuteConcordance.values()).find(
      (m) => m.old_act === "CRPC_1973" && m.old_section === "482",
    );
    assert.ok(mapping, "Concordance mapping from CrPC 482 must exist");
    assert.strictEqual(mapping.new_act, "BNSS_2023");
    assert.strictEqual(mapping.new_section, "528");

    // 4. Assistant formats updated dual-captioned submission
    const modernizedDraft = `Petition under Section 528 BNSS, 2023 read with Section 482 CrPC, 1973 for quashing of FIR.`;
    const modernVerification = await verifyTextCitations(modernizedDraft);

    // 5. Verifier confirms both provisions exist in verified corpus without collision
    assert.ok(modernVerification.verified.length >= 2, "Both BNSS 528 and CrPC 482 must be verified");
    assert.ok(modernVerification.verified.some((v) => v.section_num === "528" && v.act_code === "BNSS_2023"));
    assert.ok(modernVerification.verified.some((v) => v.section_num === "482" && v.act_code === "CRPC_1973"));
    assert.strictEqual(modernVerification.unverified.length, 0, "No homonym collisions or invalid citations");
  });

  it("Pipeline 3: Landmark Precedent Ingestion to Case Search Flow (Bhajan Lal 7 Principles)", async () => {
    // 1. Ingest landmark case law
    const caseData = {
      id: "sc-bhajan-lal-1992",
      case_title: "State of Haryana and others v. Bhajan Lal and others",
      primary_citation: "1992 Supp (1) SCC 335",
      neutral_citation: "1990 INSC 363",
      court: "Supreme Court of India",
      year: 1992,
      bench_description: "S. Ratnavel Pandian, J. & K. Jayachandra Reddy, J.",
      ratio: "High Court inherent power under Sec 482 CrPC (now Sec 528 BNSS) can be exercised to quash FIR in 7 categories: allegations inherently improbable, no cognizable offence, mala fide vengeance.",
      principles: [
        "1. Allegations in FIR, taken at face value, do not prima facie constitute any offence.",
        "2. Allegations do not disclose a cognizable offence.",
        "3. Uncontroverted allegations do not disclose any offence.",
        "4. Non-cognizable offence investigated without Magisterial order.",
        "5. Allegations are absurd and inherently improbable.",
        "6. Express statutory bar against continuation of proceedings.",
        "7. Proceeding manifestly attended with mala fide or private grudge.",
      ],
      category: "quashing",
    };

    harness.mockDb.legalCases.set(caseData.id, caseData);

    // 2. Index in Qdrant
    const textToEmbed = `${caseData.court} - ${caseData.case_title} (${caseData.primary_citation} / ${caseData.neutral_citation}): ${caseData.ratio}\nPrinciples: ${caseData.principles.join(" ")}`;
    await upsertLegalChunks([
      {
        id: "case-bhajan-lal-qdrant",
        vector: generateDeterministicVector(textToEmbed, 1024),
        payload: {
          act: caseData.court,
          section: caseData.primary_citation,
          title: caseData.case_title,
          text: caseData.ratio,
          statutoryText: caseData.ratio,
          ratio: caseData.ratio,
          court: caseData.court,
          year: caseData.year,
          neutral_citation: caseData.neutral_citation,
          category: caseData.category,
        },
      },
    ]);

    // 3. User queries legal search API
    const user = await createTestUser("pipeline3_user");
    const res = await app.request("/api/legal/search?q=quashing+absurd+inherently+improbable+allegations&limit=3", {
      headers: user.headers,
    });

    assert.strictEqual(res.status, 200);
    const json = await res.json();
    assert.ok(json.results.length > 0, "API search must return results");

    const topHit = json.results.find((r: any) => r.payload?.title?.includes("Bhajan Lal") || r.payload?.section?.includes("SCC 335"));
    assert.ok(topHit, "Bhajan Lal must be among the top search results");
    assert.strictEqual(topHit.payload?.neutral_citation, "1990 INSC 363");
    assert.match(topHit.payload?.ratio || "", /inherently improbable/i);
  });

  it("Pipeline 4: Assistant Persona RAG API Answer Flow with Zero Hallucinations", async () => {
    // 1. Invoke /api/legal/answer with an anticipatory bail query
    const user = await createTestUser("pipeline4_user");
    const res = await app.request("/api/legal/answer", {
      method: "POST",
      headers: user.headers,
      body: JSON.stringify({
        question: "Can an anticipatory bail petition be filed directly before the High Court under Section 482 BNSS, and what principles apply?",
      }),
    });

    assert.strictEqual(res.status, 200);
    const data = await res.json();

    assert.ok(data.answer, "Must return an answer string");
    assert.ok(Array.isArray(data.citations), "Must return a citations array");
    assert.ok(data.citations.length > 0, "Must attach verified citations from retrieved context");

    // 2. Validate that returned citations map to existing provisions
    for (const cit of data.citations) {
      assert.ok(cit.documentId || cit.documentTitle, "Citation must have document identifier");
      assert.ok(cit.score >= 0.35, "Citation score must meet minimum threshold");
    }

    // 3. Verify that the answer text contains only authentic citations
    const verification = await verifyTextCitations(data.answer);
    assert.strictEqual(
      verification.unverified.length,
      0,
      `Answer must contain zero hallucinated citations, found: ${JSON.stringify(verification.unverified)}`,
    );
  });
});
