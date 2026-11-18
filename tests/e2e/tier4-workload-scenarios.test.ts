import "../mocks/setup.js";

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  setupTestHarness,
  restoreMockEmbeddingsFetch,
} from "../mocks/index.js";
import {
  verifyTextCitations,
} from "../../src/services/citation/verifier.js";
import { retrieveLegalContext } from "../../src/services/legal/rag.js";
import { searchStatutes } from "../../src/services/legal/qdrant.js";

describe("Tier 4: Real-World Indian Litigation Workload Scenarios", () => {
  let harness: ReturnType<typeof setupTestHarness>;

  beforeEach(() => {
    harness = setupTestHarness();
  });

  afterEach(() => {
    restoreMockEmbeddingsFetch();
  });

  it("Scenario 1: Anticipatory Bail Application under BNSS 482 (citing Satender Kumar Antil & Arnesh Kumar)", async () => {
    // Factual Context: Accused apprehending arrest in commercial cheating dispute (Section 318 BNS).
    // Punishment is up to 7 years. Investigating officer issued no notice under Section 35 BNSS.

    // 1. Retrieve Statutory Grounds: BNSS Section 482 (Anticipatory Bail)
    const db = harness.mockDb;
    const bnss482 = db.legalProvisions.get("bnss-2023-sec-482");
    assert.ok(bnss482, "BNSS Section 482 must exist in the corpus");
    assert.match(bnss482.ratio || "", /flight risk|antecedents|gravity/i);

    // 2. Retrieve Mandatory Procedure: BNSS Section 35 (Notice of Appearance)
    const bnss35 = db.legalProvisions.get("bnss-2023-sec-35");
    assert.ok(bnss35, "BNSS Section 35 must exist");
    assert.match(bnss35.ratio || "", /Mandatory notice of appearance prior to arrest for offences punishable up to 7 years/i);

    // 3. Retrieve Landmark Precedent: Satender Kumar Antil v. CBI, (2022) 10 SCC 51
    const antil = Array.from(db.legalCases.values()).find((c) => c.neutral_citation === "2022 INSC 690");
    assert.ok(antil, "Satender Kumar Antil precedent must be retrieved");
    assert.ok(
      antil.principles?.some((p) => p.includes("Category A")),
      "Antil must define Category A offences (punishable up to 7 years)",
    );
    assert.match(antil.ratio, /Bail is the rule, jail is the exception/i);

    // 4. Retrieve Landmark Precedent: Arnesh Kumar v. State of Bihar, (2014) 8 SCC 273
    const arnesh = Array.from(db.legalCases.values()).find((c) => c.neutral_citation === "2014 INSC 473");
    assert.ok(arnesh, "Arnesh Kumar precedent must be retrieved");
    assert.match(arnesh.ratio, /notice of appearance/i);
    assert.match(arnesh.ratio, /humiliation/i);

    // 5. Build and Verify Anticipatory Bail Petition Grounding
    const petitionSubmission = `
The Applicant applies for Anticipatory Bail under Section 482 BNSS in connection with FIR registered under Section 318 BNS.
The offence carries a maximum term of seven years imprisonment, squarely falling under Category A of the guidelines established in Satender Kumar Antil v. CBI, (2022) 10 SCC 51.
The Investigating Officer failed to serve a notice of appearance under Section 35 BNSS, violating the mandatory arrest directives in Arnesh Kumar v. State of Bihar, (2014) 8 SCC 273.
    `.trim();

    const verification = await verifyTextCitations(petitionSubmission);
    assert.strictEqual(verification.unverified.length, 0, "All citations in anticipatory bail application must be verified");
    assert.ok(verification.verified.length >= 4, "Must verify Section 482 BNSS, Section 318 BNS, Antil, and Arnesh Kumar");
    assert.ok(verification.verified.some((v) => v.section_num === "482" && v.act_code === "BNSS_2023"));
    assert.ok(verification.verified.some((v) => v.section_num === "35" && v.act_code === "BNSS_2023"));
    assert.ok(verification.verified.some((v) => v.primary_citation === "(2022) 10 SCC 51"));
    assert.ok(verification.verified.some((v) => v.primary_citation === "(2014) 8 SCC 273"));
  });

  it("Scenario 2: Quashing Petition under Section 528 BNSS / Section 482 CrPC (citing Bhajan Lal 7 principles)", async () => {
    // Factual Context: Purely commercial dispute arising from breach of contract cloaked as criminal breach of trust and cheating.
    const db = harness.mockDb;

    // 1. Concordance Mapping Check for Transition Regimes
    const quashConcordance = Array.from(db.statuteConcordance.values()).find(
      (m) => m.old_act === "CRPC_1973" && m.old_section === "482",
    );
    assert.ok(quashConcordance);
    assert.strictEqual(quashConcordance.new_act, "BNSS_2023");
    assert.strictEqual(quashConcordance.new_section, "528");

    // 2. Retrieve Landmark Precedent: State of Haryana v. Bhajan Lal, 1992 Supp (1) SCC 335
    const bhajanLal = Array.from(db.legalCases.values()).find((c) => c.neutral_citation === "1990 INSC 363");
    assert.ok(bhajanLal, "Bhajan Lal precedent must exist");
    assert.strictEqual(bhajanLal.principles?.length, 7, "Must contain all 7 quashing categories");

    // Verify Category 1 (No prima facie offence) and Category 7 (Mala fide / vengeance)
    assert.match(bhajanLal.principles![0], /prima facie constitute any offence/i);
    assert.match(bhajanLal.principles![4], /absurd and inherently improbable/i);
    assert.match(bhajanLal.principles![6], /mala fide or maliciously instituted/i);

    // 3. Draft Criminal Misc Petition Grounds
    const quashingDraft = `
Criminal Miscellaneous Petition under Section 528 BNSS for quashing of FIR.
The dispute between the parties is purely civil in nature arising from a commercial contract.
As held in State of Haryana v. Bhajan Lal, 1992 Supp (1) SCC 335, the criminal proceedings are manifestly attended with mala fide and the uncontroverted allegations do not disclose any offence under Section 318 BNS.
    `.trim();

    const verification = await verifyTextCitations(quashingDraft);
    assert.strictEqual(verification.unverified.length, 0, "Quashing submission must contain zero unverified citations");
    assert.ok(verification.verified.some((v) => v.section_num === "528" && v.act_code === "BNSS_2023"));
    assert.ok(verification.verified.some((v) => v.primary_citation === "1992 Supp (1) SCC 335"));

    // 4. Adversarial Hazard Test: Ensure citing BNSS 482 for quashing is rejected
    const badQuashing = `The petitioner moves under Section 482 BNSS for quashing of the FIR.`;
    const badVerification = await verifyTextCitations(badQuashing);
    assert.ok(badVerification.unverified.length > 0, "Citing BNSS 482 for quashing must be flagged");
    assert.strictEqual(badVerification.unverified[0].reason, "homonym_mismatch");
  });

  it("Scenario 3: Cheque Bounce Statutory Demand Notice & Complaint under Section 138 NI Act", async () => {
    // Factual Context: Cheque of INR 15,00,000 returned unpaid with memo "Funds Insufficient".
    const db = harness.mockDb;

    // 1. Retrieve Statutory Requirements of Section 138 NI Act
    const sec138 = db.legalProvisions.get("ni-act-sec-138");
    assert.ok(sec138, "Section 138 NI Act must be present");
    assert.match(sec138.ratio || "", /presentation in 3 months/i);
    assert.match(sec138.ratio || "", /statutory demand notice in 30 days/i);
    assert.match(sec138.ratio || "", /15-day cure window/i);

    // 2. Retrieve Presumption under Section 139 NI Act
    const sec139 = db.legalProvisions.get("ni-act-sec-139");
    assert.ok(sec139, "Section 139 NI Act must be present");
    assert.match(sec139.ratio || "", /rebuttable by preponderance of probabilities/i);

    // 3. Retrieve Director Liability under Section 141 NI Act
    const sec141 = db.legalProvisions.get("ni-act-sec-141");
    assert.ok(sec141, "Section 141 NI Act must be present");
    assert.match(sec141.ratio || "", /actively in charge of company's business/i);

    // 4. Retrieve Limitation for Cognizance under Section 142 NI Act
    const sec142 = db.legalProvisions.get("ni-act-sec-142");
    assert.ok(sec142, "Section 142 NI Act must be present");
    assert.match(sec142.ratio || "", /within 1 month from date cause of action arises/i);

    // 5. Timeline Calculation Assertion:
    // Dishonour Memo Date: Day 0
    // Notice dispatched within 30 days: Day 5, delivered: Day 8
    // 15-day cure window: Day 9 to Day 23
    // Cause of action arises: Day 24
    // 1-month limitation period: Day 24 to Day 54
    const memoDate = new Date("2024-10-01");
    const noticeServedDate = new Date("2024-10-09");
    const curePeriodDays = 15;
    const causeOfActionDate = new Date(noticeServedDate);
    causeOfActionDate.setDate(causeOfActionDate.getDate() + curePeriodDays + 1);

    const limitationExpiryDate = new Date(causeOfActionDate);
    limitationExpiryDate.setMonth(limitationExpiryDate.getMonth() + 1);

    assert.strictEqual(causeOfActionDate.toISOString().split("T")[0], "2024-10-25");
    assert.strictEqual(limitationExpiryDate.toISOString().split("T")[0], "2024-11-25");

    // 6. Verify Citation Grounding
    const noticeText = `Demand notice issued under Section 138 of the Negotiable Instruments Act, 1881. In default, complaint shall be filed under Section 142 NIA with presumption under Section 139 NIA and director liability under Section 141 NIA.`;
    const res = await verifyTextCitations(noticeText);
    assert.strictEqual(res.unverified.length, 0);
    assert.ok(res.verified.some((v) => v.section_num === "138"));
    assert.ok(res.verified.some((v) => v.section_num === "139"));
    assert.ok(res.verified.some((v) => v.section_num === "141"));
    assert.ok(res.verified.some((v) => v.section_num === "142"));
  });

  it("Scenario 4: Electronic Evidence Certificate under Section 63 BSA (citing Arjun Panditrao Khotkar)", async () => {
    // Factual Context: Commercial fraud prosecution introducing WhatsApp chats, server logs, CCTV footage.
    const db = harness.mockDb;

    // 1. Retrieve Statutory Evidence Principles
    const bsa61 = db.legalProvisions.get("bsa-2023-sec-61");
    assert.ok(bsa61, "Section 61 BSA must be present");
    assert.match(bsa61.ratio || "", /identical legal validity and enforceability as physical documents/i);

    const bsa63 = db.legalProvisions.get("bsa-2023-sec-63");
    assert.ok(bsa63, "Section 63 BSA must be present");
    assert.match(bsa63.ratio || "", /Mandatory certificate condition precedent/i);

    // 2. Concordance check: Section 65B Indian Evidence Act 1872 -> Section 63 BSA 2023
    const concordance = Array.from(db.statuteConcordance.values()).find(
      (m) => m.old_act === "IEA_1872" && m.old_section === "65B",
    );
    assert.ok(concordance);
    assert.strictEqual(concordance.new_act, "BSA_2023");
    assert.strictEqual(concordance.new_section, "63");

    // 3. Retrieve Landmark Precedent: Arjun Panditrao Khotkar v. Kailash Kushanrao Gorantyal, (2020) 7 SCC 1
    const khotkar = Array.from(db.legalCases.values()).find((c) => c.neutral_citation === "2020 INSC 452");
    assert.ok(khotkar, "Arjun Panditrao Khotkar precedent must exist");
    assert.strictEqual(khotkar.primary_citation, "(2020) 7 SCC 1");
    assert.match(khotkar.bench_description || "", /3-Judge|Nariman/i);
    assert.match(khotkar.ratio, /indispensable condition precedent/i);
    assert.match(khotkar.ratio, /Oral testimony cannot cure the defect/i);

    // 4. Verify Legal Submission Grounding
    const submission = `
Under Section 63 BSA read with Section 61 BSA, production of the statutory electronic record certificate is an indispensable condition precedent as held in Arjun Panditrao Khotkar v. Kailash Kushanrao Gorantyal, (2020) 7 SCC 1.
    `.trim();

    const verification = await verifyTextCitations(submission);
    assert.strictEqual(verification.unverified.length, 0);
    assert.ok(verification.verified.some((v) => v.section_num === "63" && v.act_code === "BSA_2023"));
    assert.ok(verification.verified.some((v) => v.primary_citation === "(2020) 7 SCC 1"));
    assert.ok(verification.verified.some((v) => v.neutral_citation === "2020 INSC 452"));
  });

  it("Scenario 5: Commercial Contract Frustration under Section 56 ICA (citing Satyabrata Ghose)", async () => {
    // Factual Context: Sudden government embargo prevents delivery of goods under commercial supply contract.
    // Buyer sues for breach and damages under Section 73 ICA.
    const db = harness.mockDb;

    // 1. Ingestion check: Section 56 and Section 73 ICA exist despite repealed sections gap (76-123)
    const ica56 = db.legalProvisions.get("ica-1872-sec-56");
    const ica73 = db.legalProvisions.get("ica-1872-sec-73");
    const ica124 = db.legalProvisions.get("ica-1872-sec-124");

    assert.ok(ica56, "Section 56 ICA must exist");
    assert.ok(ica73, "Section 73 ICA must exist");
    assert.ok(ica124, "Section 124 ICA must exist across the gap");

    // 2. Retrieve Landmark Precedent: Satyabrata Ghose v. Mugneeram Bangur & Co., [1954] SCR 310
    const satyabrata = Array.from(db.legalCases.values()).find((c) => c.neutral_citation === "1953 INSC 70");
    assert.ok(satyabrata, "Satyabrata Ghose precedent must exist");
    assert.strictEqual(satyabrata.primary_citation, "[1954] SCR 310");
    assert.match(satyabrata.ratio, /exhaustive positive rule of law/i);
    assert.match(satyabrata.ratio, /English common law doctrine of implied terms/i);
    assert.match(satyabrata.ratio, /practical and commercial impossibility/i);

    // 3. Verify Commercial Defense Written Statement
    const writtenStatement = `
The Defendant submits that the contract was frustrated by operation of law under Section 56 of the Indian Contract Act, 1872 due to the sudden government export embargo.
As held by the Supreme Court in Satyabrata Ghose v. Mugneeram Bangur & Co., [1954] SCR 310, Section 56 is an exhaustive code, and supervening events destroying the foundation of the adventure discharge performance without liability for damages under Section 73 of the Indian Contract Act, 1872.
    `.trim();

    const verification = await verifyTextCitations(writtenStatement);
    assert.strictEqual(verification.unverified.length, 0);
    assert.ok(verification.verified.some((v) => v.section_num === "56" && v.act_code === "ICA_1872"));
    assert.ok(verification.verified.some((v) => v.section_num === "73" && v.act_code === "ICA_1872"));
    assert.ok(verification.verified.some((v) => v.primary_citation === "[1954] SCR 310"));
  });
});
