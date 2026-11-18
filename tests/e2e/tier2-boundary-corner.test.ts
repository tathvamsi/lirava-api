import "../mocks/setup.js";

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  setupTestHarness,
  restoreMockEmbeddingsFetch,
} from "../mocks/index.js";
import {
  verifyTextCitations,
  createCitationVerifier,
} from "../../src/services/citation/verifier.js";
import {
  splitIntoSections,
  parseCpcOrders,
  parseBareAct,
  extractStructuralElements,
} from "../../src/services/legal/parser.js";
import { retrieveLegalContext } from "../../src/services/legal/rag.js";
import { searchStatutes } from "../../src/services/legal/qdrant.js";
import { searchProvisions } from "../../src/services/legal/provisions.js";
import { getSql } from "../../src/services/db/postgres.js";

describe("Tier 2: Boundary & Corner Cases Suite (Adversarial Coverage)", () => {
  let harness: ReturnType<typeof setupTestHarness>;

  beforeEach(() => {
    harness = setupTestHarness();
  });

  afterEach(() => {
    restoreMockEmbeddingsFetch();
  });

  describe("Boundary 1: Parser & Lexer Edge Cases", () => {
    it("2.1.1 parses extreme section gap jumps (>100 sections) without premature termination", () => {
      const extremeGapText = `
1. Short title and extent. — This Act may be called the Special Enactment Act, 2024.
2. Definitions. — In this Act, unless the context otherwise requires...
[Sections 3 to 199 Repealed by Act 50 of 2024]
200. Power of Central Government to make rules. — (1) The Central Government may, by notification in the Official Gazette, make rules for carrying out the purposes of this Act.
      `.trim();

      const parsed = splitIntoSections(extremeGapText);
      const sec200 = parsed.find((s) => s.section === "200" || s.section_num === "200");
      assert.ok(sec200, "Section 200 must be parsed despite gap of 197 repealed sections");
      assert.match(sec200.title, /Power of Central Government/i);
    });

    it("2.1.2 handles multi-lettered and compound section suffixes without truncation", () => {
      const multiLetterText = `
1. Short title. — Indian Penal Code Amendments.
376D. Gang rape. — Where a woman is raped by one or more persons...
376DA. Punishment for gang rape on woman under sixteen years of age. — Where a woman under sixteen years of age is raped by one or more persons constituting a group or acting in furtherance of a common intention, each of those persons shall be punished with imprisonment for life.
376DB. Punishment for gang rape on woman under twelve years of age. — Where a woman under twelve years of age is raped...
      `.trim();

      const parsed = splitIntoSections(multiLetterText);
      const sec376DA = parsed.find((s) => s.section === "376DA" || s.section_num === "376DA");
      const sec376DB = parsed.find((s) => s.section === "376DB" || s.section_num === "376DB");

      assert.ok(sec376DA, "Section 376DA must be parsed with full letters");
      assert.strictEqual(sec376DA.section, "376DA");
      assert.ok(sec376DB, "Section 376DB must be parsed with full letters");
      assert.strictEqual(sec376DB.section, "376DB");
    });

    it("2.1.3 extracts sub-clauses, provisos, and explanations into structural elements", () => {
      const complexSection = `
Section 138. Dishonour of cheque for insufficiency of funds in the accounts.
Where any cheque drawn by a person on an account maintained by him with a banker for payment of any amount of money is returned unpaid:
Provided that nothing contained in this section shall apply unless:
(a) the cheque has been presented to the bank within a period of three months;
(b) the payee makes a demand for payment within thirty days;
(c) the drawer fails to make payment within fifteen days.
Explanation. — For the purposes of this section, debt or other liability means a legally enforceable debt.
      `.trim();

      const struct = extractStructuralElements(complexSection);
      assert.ok(struct.provisos.length >= 1, "Must extract statutory proviso");
      assert.match(struct.provisos[0], /Provided that/i);
      assert.ok(struct.explanations.length >= 1, "Must extract statutory explanation");
      assert.match(struct.explanations[0], /legally enforceable debt/i);
    });

    it("2.1.4 parses complex CPC Order Roman numerals and sub-rules", () => {
      const cpcOrderText = `
ORDER XXI. EXECUTION OF DECREES AND ORDERS.
Rule 106. Setting aside orders passed ex parte, etc. — (1) The applicant, against whom an order is made under sub-rule (2) of rule 105 or the opposite party against whom an order is passed ex parte... may apply to the Court to set aside the order.
ORDER XXXIX. TEMPORARY INJUNCTIONS.
Rule 2A. Consequence of disobedience or breach of injunction. — (1) In the case of disobedience of any injunction granted or other order made under rule 1 or rule 2... the Court granting the injunction may order the property of the person guilty of such disobedience to be attached.
      `.trim();

      const orders = parseCpcOrders(cpcOrderText);
      const r106 = orders.find((o) => o.ruleNum === "106" && o.orderRoman === "XXI");
      const r2a = orders.find((o) => o.ruleNum === "2A" && o.orderRoman === "XXXIX");

      assert.ok(r106, "Order XXI Rule 106 must be parsed");
      assert.strictEqual(r106.section_num, "O21_R106");
      assert.ok(r2a, "Order XXXIX Rule 2A must be parsed");
      assert.strictEqual(r2a.section_num, "O39_R2A");
      assert.match(r2a.title, /breach of injunction/i);
    });

    it("2.1.5 rejects malformed non-legal text and handles corrupted inputs gracefully", () => {
      const arbitraryInvoice = `
INVOICE #98234
Date: 2024-11-01
Total: $450.00
Thank you for your business! Please remit payment via wire transfer.
      `.trim();

      const parsed = splitIntoSections(arbitraryInvoice);
      assert.strictEqual(parsed.length, 0, "Non-statutory text must produce 0 sections");

      // Corrupted unicode / empty input
      const emptyParsed = splitIntoSections("");
      assert.strictEqual(emptyParsed.length, 0);
    });
  });

  describe("Boundary 2: Homonyms, Collisions & Concordance Boundaries", () => {
    it("2.2.1 differentiates homonymous Section 482 BNSS vs Section 482 CrPC", () => {
      const db = harness.mockDb;
      const bnss482 = db.legalProvisions.get("bnss-2023-sec-482");
      const crpc482 = db.legalProvisions.get("crpc-1973-sec-482");
      const bnss528 = db.legalProvisions.get("bnss-2023-sec-528");

      assert.ok(bnss482 && crpc482 && bnss528);
      // BNSS 482 = Anticipatory Bail
      assert.match(bnss482.title, /Anticipatory Bail/i);
      // CrPC 482 = Inherent Powers / Quashing
      assert.match(crpc482.title, /inherent powers/i);
      // BNSS 528 = Inherent Powers / Quashing
      assert.match(bnss528.title, /inherent powers/i);

      assert.notStrictEqual(bnss482.title, crpc482.title, "BNSS 482 and CrPC 482 must have distinct subject matters");
    });

    it("2.2.2 differentiates homonymous Section 302 BNS vs Section 302 IPC", () => {
      const db = harness.mockDb;
      const bns302 = db.legalProvisions.get("bns-2023-sec-304") || db.legalProvisions.get("bns-2023-sec-303");
      const ipc302 = db.legalProvisions.get("ipc-1860-sec-302");
      const bns103 = db.legalProvisions.get("bns-2023-sec-103-1");

      assert.ok(ipc302, "IPC 302 must exist");
      assert.match(ipc302.title, /murder/i);

      assert.ok(bns103, "BNS 103(1) must exist for murder");
      assert.match(bns103.title, /murder/i);

      // In BNS, murder is 103, not 302 (which is snatching/theft)
      assert.notStrictEqual(bns103.section_num, ipc302.section_num);
    });

    it("2.2.3 enforces Article 20(1) ex-post facto bar for offences committed prior to July 1, 2024", async () => {
      const text = "The accused committed the offence of cheating on 15 May 2024 and is charged under Section 318 BNS.";
      const res = await verifyTextCitations(text, { offenceDate: "2024-05-15" });

      assert.ok(res.unverified.length > 0, "Must flag ex-post facto violation");
      const violation = res.unverified.find((u) => u.reason === "ex_post_facto_violation");
      assert.ok(violation, "Ex-post facto reason must be specified");
      assert.match(violation.warning || "", /Article 20\(1\)|July 1, 2024/i);
    });

    it("2.2.4 flags repealed or held-in-abeyance provisions like Section 124A IPC", async () => {
      const text = "The police registered an FIR under Section 124A IPC for sedition against the speaker.";
      const res = await verifyTextCitations(text);
      const seditionHit = res.verified.find((v) => v.section_num === "124A");

      assert.ok(seditionHit, "Section 124A IPC should be found");
      assert.strictEqual(seditionHit.status, "held_in_abeyance");
    });

    it("2.2.5 returns null for non-existent provisions like Section 999 BNSS", () => {
      const db = harness.mockDb;
      const nonexistent = db.legalProvisions.get("bnss-2023-sec-999");
      assert.strictEqual(nonexistent, undefined);
    });
  });

  describe("Boundary 3: Retrieval & Vector Boundaries", () => {
    it("3.3.1 returns null immediately for empty and whitespace queries", async () => {
      assert.strictEqual(await retrieveLegalContext(""), null);
      assert.strictEqual(await retrieveLegalContext("   "), null);
      assert.strictEqual(await retrieveLegalContext("\n\t  \r"), null);
    });

    it("3.3.2 handles queries up to length cap without buffer overflow or degradation", async () => {
      // 5000 character prompt
      const hugeQuery = "bail ".repeat(1000) + "anticipatory custody Section 482";
      const ctx = await retrieveLegalContext(hugeQuery, 1400);
      assert.ok(ctx, "Must process large query cleanly");
      assert.ok(ctx.contextText.length <= 1450, "Context must respect maxChars truncation");
    });

    it("3.3.3 safely sanitizes SQL injection sequences in search queries", async () => {
      const maliciousQuery = "'; DROP TABLE legal_provisions; SELECT * FROM users WHERE '1'='1";
      const results = await searchProvisions(maliciousQuery);
      // Must not throw, and table must remain intact
      assert.ok(Array.isArray(results));
      assert.ok(harness.mockDb.legalProvisions.size > 0, "Table must not have been dropped");
    });

    it("3.3.4 isolates act-specific filtering in vector search", async () => {
      // Search with specific act filter
      const hits = await searchStatutes("bail in non-bailable offences", 5, "BNSS");
      assert.ok(hits.length > 0);
      for (const hit of hits) {
        assert.ok(
          hit.payload?.act?.includes("BNSS") || hit.payload?.act?.includes("Bharatiya Nagarik Suraksha"),
          `Expected BNSS match, got: ${hit.payload?.act}`,
        );
      }

      // Mutual exclusion test (Challenger 1 finding remediation):
      // Filtering for "BNS" must return provisions with act_code "BNS_2023" and strictly exclude "BNSS_2023"
      const bnsHits = await searchStatutes("punishment for murder or snatching", 5, "BNS");
      assert.ok(bnsHits.length > 0, "BNS filter should return BNS provisions");
      for (const hit of bnsHits) {
        const actCode = hit.payload?.act_code || "";
        assert.strictEqual(
          actCode.split("_")[0],
          "BNS",
          `Expected BNS act code, got: ${actCode}`,
        );
        assert.ok(
          !actCode.includes("BNSS") && !hit.payload?.act?.includes("Nagarik"),
          `BNSS provision must not leak into BNS search: ${actCode}`,
        );
      }

      // Filtering for "BNSS" must strictly exclude "BNS_2023"
      const bnssHits = await searchStatutes(
        "notice of appearance before police officer arrest not required",
        5,
        "BNSS",
      );
      assert.ok(bnssHits.length > 0, "BNSS filter should return BNSS provisions");
      for (const hit of bnssHits) {
        const actCode = hit.payload?.act_code || "";
        assert.strictEqual(
          actCode.split("_")[0],
          "BNSS",
          `Expected BNSS act code, got: ${actCode}`,
        );
        assert.ok(
          !actCode.includes("BNS_2023") && !hit.payload?.act?.includes("Nyaya"),
          `BNS provision must not leak into BNSS search: ${actCode}`,
        );
      }

      // Regression test: point with payload `{ act: "BNS" }` (and no act_code)
      // must never match filter `{ act: "BNSS" }` (Challenger 3 defect remediation)
      const qdrant = harness.mockQdrant as any;
      const bnsPayloadNoActCode = { act: "BNS", title: "Murder", section: "Section 103" };
      const bnssFilter = { must: [{ key: "act", match: { value: "BNSS" } }] };
      const matched = qdrant.matchesFilter(bnsPayloadNoActCode, bnssFilter);
      assert.strictEqual(
        matched,
        false,
        "Payload with act: 'BNS' and no act_code must NOT match filter act: 'BNSS'",
      );

      const bnssPayloadNoActCode = { act: "BNSS", title: "Bail", section: "Section 482" };
      const bnsFilter = { must: [{ key: "act", match: { value: "BNS" } }] };
      const reverseMatched = qdrant.matchesFilter(bnssPayloadNoActCode, bnsFilter);
      assert.strictEqual(
        reverseMatched,
        false,
        "Payload with act: 'BNSS' and no act_code must NOT match filter act: 'BNS'",
      );
    });

    it("3.3.5 enforces minimum cosine score threshold discarding irrelevant hits", async () => {
      // Search with completely irrelevant query to legal statutes
      const hits = await searchStatutes("quantum astrophysics dark matter cosmology", 5);
      // Irrelevant query must have low scores and be pruned
      for (const h of hits) {
        assert.ok(h.score >= 0.35, "Any returned hit must strictly meet the score threshold");
      }
    });

    it("3.3.6 completely reverts in-place UPDATE mutations upon transaction rollback", async () => {
      const sql = getSql()!;
      const db = harness.mockDb;
      const provId = "bnss-2023-sec-482";
      const prov = db.legalProvisions.get(provId)!;
      assert.ok(prov, "Target provision must exist");
      const originalIndexedAt = prov.indexed_at;

      let threw = false;
      try {
        await sql.begin(async (tx) => {
          await tx.unsafe("UPDATE legal_provisions SET indexed_at = $1 WHERE id IN ($2)", [999999, [provId]]);
          throw new Error("Simulated transaction failure");
        });
      } catch (err: any) {
        threw = true;
        assert.strictEqual(err.message, "Simulated transaction failure");
      }
      assert.ok(threw, "Transaction must throw");

      const postRollbackProv = db.legalProvisions.get(provId)!;
      assert.strictEqual(
        postRollbackProv.indexed_at,
        originalIndexedAt,
        "indexed_at must revert to original value in database map after transaction rollback",
      );
      assert.strictEqual(
        prov.indexed_at,
        originalIndexedAt,
        "Original object reference must also have its fields reverted",
      );
    });
  });

  describe("Boundary 4: Citation Verifier Boundaries", () => {
    it("2.4.1 detects homonym mismatch when Section 482 BNSS is cited for quashing", async () => {
      const text = "The High Court exercised jurisdiction under Section 482 BNSS and quashed the criminal proceedings.";
      const res = await verifyTextCitations(text);
      assert.ok(res.unverified.length > 0, "Must flag homonym mismatch");
      const mismatch = res.unverified.find((u) => u.reason === "homonym_mismatch");
      assert.ok(mismatch, "Should flag reason as homonym_mismatch");
      assert.match(mismatch.warning || "", /BNSS 482 is Anticipatory Bail, not Quashing/i);
    });

    it("2.4.2 resolves multi-reporter synonyms to the exact same landmark precedent entity", async () => {
      const text1 = "Satender Kumar Antil v. CBI, (2022) 10 SCC 51.";
      const text2 = "Satender Kumar Antil v. CBI, 2022 INSC 690.";
      const text3 = "Satender Kumar Antil v. CBI, AIR 2022 SC 3386.";

      const res1 = await verifyTextCitations(text1);
      const res2 = await verifyTextCitations(text2);
      const res3 = await verifyTextCitations(text3);

      const id1 = res1.verified.find((v) => v.type === "case")?.id;
      const id2 = res2.verified.find((v) => v.type === "case")?.id;
      const id3 = res3.verified.find((v) => v.type === "case")?.id;

      assert.strictEqual(id1, "sc-satender-antil-2022");
      assert.strictEqual(id2, "sc-satender-antil-2022");
      assert.strictEqual(id3, "sc-satender-antil-2022");
      assert.strictEqual(id1, id2);
      assert.strictEqual(id2, id3);
    });

    it("2.4.3 flags synthetic fabricated case citations in legal submissions", async () => {
      const fakeText = "Relying on State of Maharashtra v. ABC, (2025) 18 SCC 9999.";
      const res = await verifyTextCitations(fakeText);
      const fakeHit = res.unverified.find((u) => u.reason === "synthetic_citation");
      assert.ok(fakeHit, "Must flag (2025) 18 SCC 9999 as synthetic");
      assert.match(fakeHit.raw, /SCC 9999/);
    });

    it("2.4.4 correctly isolates verified and unverified citations in mixed text", async () => {
      const mixedText = "Under Section 482 BNSS for bail, and fake Section 999 BNSS, and Arnesh Kumar v. State of Bihar, (2014) 8 SCC 273.";
      const res = await verifyTextCitations(mixedText);

      assert.ok(res.verified.some((v) => v.section_num === "482"), "Section 482 BNSS must be verified");
      assert.ok(res.verified.some((v) => v.primary_citation === "(2014) 8 SCC 273"), "Arnesh Kumar must be verified");
      assert.ok(res.unverified.some((u) => u.raw.includes("999")), "Section 999 must be unverified");
    });

    it("2.4.5 normalizes punctuation and whitespace variations in statutory citations", async () => {
      const texts = [
        "Sec.482 BNSS",
        "Sec 482, BNSS",
        "Section 482 of BNSS, 2023",
        "Section 482 BNSS",
      ];

      for (const t of texts) {
        const res = await verifyTextCitations(t);
        const hit = res.verified.find((v) => v.section_num === "482");
        assert.ok(hit, `Should verify variation: "${t}"`);
        assert.strictEqual(hit.act_code, "BNSS_2023");
        assert.strictEqual(hit.section_num, "482");
      }
    });
  });
});
