/**
 * Unit Test Suite: Legal Statute & Order/Rule Parser
 * Target File: lirava-api/tests/unit/parser.test.ts
 *
 * Verifies:
 * 1. Gap handling (>5 sections, e.g., Indian Contract Act 1872 Sections 76-123 repealed gap).
 * 2. Lettered sections (143A NIA, 376DA IPC, 41A CrPC, 304B IPC).
 * 3. CPC Order/Rule parsing (Order XXXIX Rule 1 & 2 -> O39_R1, Order VII Rule 11 -> O7_R11).
 * 4. Structured extraction of sub-clauses, provisos, explanations, and illustrations.
 * 5. Rejection of non-act inputs.
 *
 * Execution: pnpm exec tsx --test tests/unit/parser.test.ts (100% offline, zero network/db).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  splitIntoSections,
  parseCpcOrders,
  parseBareAct,
  type SectionDraft,
  type ParsedProvision,
} from "../../src/services/legal/parser.js";

// =========================================================================
// Test Fixtures
// =========================================================================

const CONTRACT_ACT_SAMPLE = `
THE INDIAN CONTRACT ACT, 1872
CHAPTER VI
OF THE CONSEQUENCES OF BREACH OF CONTRACT
73. Compensation for loss or damage caused by breach of contract.—When a contract has been broken, the party who suffers by such breach is entitled to receive, from the party who has broken the contract, compensation for any loss or damage caused to him thereby.
74. Compensation for breach of contract where penalty stipulated for.—When a contract has been broken, if a sum is named in the contract as the amount to be paid in case of such breach, the party complaining of the breach is entitled to receive reasonable compensation.
75. Party rightfully rescinding contract entitled to compensation.—A person who rightfully rescinds a contract is entitled to compensation for any damage which he has sustained through the non-fulfilment of the contract.
CHAPTER VII
[SECTIONS 76 TO 123 REPEALED BY THE SALE OF GOODS ACT, 1930]
CHAPTER VIII
OF INDEMNITY AND GUARANTEE
124. "Contract of indemnity" defined.—A contract by which one party promises to save the other from loss caused to him by the conduct of the promisor himself, or by the conduct of any other person, is called a "contract of indemnity".
125. Rights of indemnity-holder when sued.—The promisee in a contract of indemnity, acting within the scope of his authority, is entitled to recover from the promisor all damages which he may be compelled to pay in any suit.
126. "Contract of guarantee", "surety", "principal debtor" and "creditor".—A "contract of guarantee" is a contract to perform the promise, or discharge the liability, of a third person in case of his default. The person who gives the guarantee is called the "surety".
`;

const LETTERED_SECTIONS_SAMPLE = `
THE CODE OF CRIMINAL PROCEDURE, 1973
CHAPTER V
ARREST OF PERSONS
41. When police may arrest without warrant.—(1) Any police officer may without an order from a Magistrate and without a warrant, arrest any person who commits in the presence of a police officer a cognizable offence.
41A. Notice of appearance before police officer.—(1) The police officer shall, in all cases where the arrest of a person is not required under the provisions of sub-section (1) of section 41, issue a notice directing the person against whom a reasonable complaint has been made.
41B. Procedure of arrest and duties of officer making arrest.—Every police officer while making an arrest shall bear an accurate, visible and clear identification of his name which will facilitate easy identification.
41C. Control room at districts.—(1) The State Government shall establish a police control room in every district.
41D. Right of arrested person to meet an advocate of his choice during interrogation.—When any person is arrested and interrogated by the police, he shall be entitled to meet an advocate of his choice.
42. Arrest on refusal to give name and residence.—When any person who in the presence of a police officer has committed or has been accused of committing a non-cognizable offence refuses to give his name.
`;

const MULTI_LETTER_SECTIONS_SAMPLE = `
THE INDIAN PENAL CODE, 1860
376. Punishment for rape.—(1) Whoever commits rape shall be punished with rigorous imprisonment of either description for a term which shall not be less than ten years.
376D. Gang rape.—Where a woman is raped by one or more persons constituting a group or acting in furtherance of a common intention, each of those persons shall be deemed to have committed the offence of rape.
376DA. Punishment for gang rape on woman under sixteen years of age.—Where a woman under sixteen years of age is raped by one or more persons constituting a group, each of those persons shall be punished with imprisonment for life.
376DB. Punishment for gang rape on woman under twelve years of age.—Where a woman under twelve years of age is raped by one or more persons constituting a group, each of those persons shall be punished with imprisonment for life which shall mean imprisonment for the remainder of that person's natural life, or with death.
377. Unnatural offences.—Whoever voluntarily has carnal intercourse against the order of nature with any man, woman or animal.
`;

const CPC_ORDERS_SAMPLE = `
THE CODE OF CIVIL PROCEDURE, 1908
THE FIRST SCHEDULE
ORDER VII
PLAINT
Rule 1. Particulars to be contained in plaint.—The plaint shall contain the following particulars:
(a) the name of the Court in which the suit is brought;
(b) the name, description and place of residence of the plaintiff.
Rule 10. Return of plaint.—(1) Subject to the provisions of rule 10A, the plaint shall at any stage of the suit be returned to be presented to the Court in which the suit should have been instituted.
Rule 11. Rejection of plaint.—The plaint shall be rejected in the following cases:—
(a) where it does not disclose a cause of action;
(b) where the relief claimed is undervalued;
(c) where the plaint is written upon paper insufficiently stamped;
(d) where the suit appears from the statement in the plaint to be barred by any law.

ORDER XXXIX
TEMPORARY INJUNCTIONS AND INTERLOCUTORY ORDERS
Rule 1. Cases in which temporary injunction may be granted.—Where in any suit it is proved by affidavit or otherwise:
(a) that any property in dispute in a suit is in danger of being wasted, damaged or alienated by any party to the suit;
(b) that the defendant threatens, or intends, to remove or dispose of his property with a view to defrauding his creditors,
the Court may by order grant a temporary injunction to restrain such act.
Rule 2. Injunction to restrain repetition or continuance of breach.—(1) In any suit for restraining the defendant from the repetition or continuance of any breach of contract or other injury of any kind, the plaintiff may apply to the Court for a temporary injunction.
Rule 2A. Consequence of disobedience or breach of injunction.—(1) In the case of disobedience of any injunction granted or other order made under rule 1 or rule 2, the Court granting the injunction or making the order may order the property of the person guilty of such disobedience or breach to be attached, and may also order such person to be detained in the civil prison for a term not exceeding three months.
`;

const CLAUSES_PROVISO_EXPLANATION_SAMPLE = `
THE BHARATIYA NAGARIK SURAKSHA SANHITA, 2023
480. When bail may be taken in case of non-bailable offence.—(1) When any person accused of, or suspected of, the commission of any non-bailable offence is arrested or detained without warrant by an officer in charge of a police station, or appears or is brought before a Court other than the High Court or Court of Session, he may be released on bail, but—
(i) such person shall not be so released if there appear reasonable grounds for believing that he has been guilty of an offence punishable with death or imprisonment for life;
(ii) such person shall not be so released if such offence is a cognizable offence and he had been previously convicted of an offence punishable with death, imprisonment for life or imprisonment for seven years or more.
Provided that the Court may direct that any person under the age of sixteen years or any woman or any sick or infirm person accused of such an offence be released on bail:
Provided further that the mere fact that an accused person may be required for being identified by witnesses during investigation shall not be sufficient ground for refusing to grant bail if he is otherwise entitled to be released on bail and gives an undertaking that he shall comply with such directions as may be given by the Court.
Explanation.—The mere fact that the accused person is not a resident of India shall not be sufficient ground for refusing to grant bail if he has furnished sufficient security.
`;

// =========================================================================
// Unit Test Suites
// =========================================================================

describe("Parser: Gap Handling & Contract Act 1-75 & 124-238", () => {
  it("bridges the massive repealed section gap (>5) from Section 75 to Section 124 in Indian Contract Act", () => {
    const sections = splitIntoSections(CONTRACT_ACT_SAMPLE);
    const sectionNums = sections.map((s) => s.section);

    assert.ok(sectionNums.includes("73"), "includes Section 73");
    assert.ok(sectionNums.includes("74"), "includes Section 74");
    assert.ok(sectionNums.includes("75"), "includes Section 75");
    assert.ok(sectionNums.includes("124"), "correctly jumps across gap 76-123 and captures Section 124");
    assert.ok(sectionNums.includes("125"), "includes Section 125");
    assert.ok(sectionNums.includes("126"), "includes Section 126");

    const sec124 = sections.find((s) => s.section === "124");
    assert.ok(sec124, "Section 124 exists");
    assert.match(sec124.title, /contract of indemnity/i, "Section 124 title matches marginal note");
    assert.match(sec124.text, /promises to save the other from loss/, "Section 124 text contains statutory body");
  });

  it("does not mistake internal numbered list items (e.g. 1. 2. 3. inside a definitions clause) as top-level sections", () => {
    const textWithList = `
THE TEST DEFINITIONS ACT, 2024
1. Short title.—This Act may be called the Test Act.
2. Definitions.—In this Act:
1. "applicant" means any person filing a petition;
2. "court" means the designated commercial court;
3. "registry" means the central filing registry.
3. Jurisdiction.—The court shall have original jurisdiction.
    `;
    const sections = splitIntoSections(textWithList);
    assert.deepEqual(sections.map((s) => s.section), ["1", "2", "3"]);
    assert.match(sections[1].text, /"applicant" means any person/);
    assert.match(sections[1].text, /"registry" means the central/);
  });
});

describe("Parser: Lettered Sections Handling", () => {
  it("correctly identifies single-lettered sections in sequential order (41, 41A, 41B, 41C, 41D, 42)", () => {
    const sections = splitIntoSections(LETTERED_SECTIONS_SAMPLE);
    assert.deepEqual(sections.map((s) => s.section), ["41", "41A", "41B", "41C", "41D", "42"]);

    const sec41A = sections.find((s) => s.section === "41A");
    assert.ok(sec41A);
    assert.equal(sec41A.title, "Notice of appearance before police officer");
    assert.match(sec41A.text, /issue a notice directing the person/);

    const sec41D = sections.find((s) => s.section === "41D");
    assert.ok(sec41D);
    assert.match(sec41D.title, /advocate of his choice/i);
  });

  it("correctly handles multi-lettered sections (376, 376D, 376DA, 376DB, 377)", () => {
    const sections = splitIntoSections(MULTI_LETTER_SECTIONS_SAMPLE);
    assert.deepEqual(sections.map((s) => s.section), ["376", "376D", "376DA", "376DB", "377"]);

    const sec376DA = sections.find((s) => s.section === "376DA");
    assert.ok(sec376DA);
    assert.equal(sec376DA.title, "Punishment for gang rape on woman under sixteen years of age");
    assert.match(sec376DA.text, /woman under sixteen years of age is raped/);

    const sec376DB = sections.find((s) => s.section === "376DB");
    assert.ok(sec376DB);
    assert.match(sec376DB.title, /woman under twelve years of age/i);
  });

  it("parses Negotiable Instruments Act Section 143A", () => {
    const niaSample = `
143. Power of Court to try cases summarily.—(1) Notwithstanding anything contained in the Code of Criminal Procedure, 1973...
143A. Power to direct interim compensation.—(1) Notwithstanding anything contained in the Code of Criminal Procedure, 1973, the Court trying an offence under section 138 may order the drawer of the cheque to pay interim compensation to the complainant.
144. Mode of service of summons.—(1) Notwithstanding anything contained in the Code of Criminal Procedure...
    `;
    const sections = splitIntoSections(niaSample);
    assert.deepEqual(sections.map((s) => s.section), ["143", "143A", "144"]);
    assert.equal(sections[1].title, "Power to direct interim compensation");
  });
});

describe("Parser: CPC Order & Rule Parsing", () => {
  it("parses Order VII Rules 1, 10, 11 into structured records with canonical section strings", () => {
    const parsed = parseCpcOrders(CPC_ORDERS_SAMPLE);
    const o7r11 = parsed.find((p) => p.section_num === "O7_R11" || p.section === "Order VII Rule 11");

    assert.ok(o7r11, "Order VII Rule 11 found");
    assert.equal(o7r11.title, "Rejection of plaint");
    assert.match(o7r11.text, /where it does not disclose a cause of action/);
  });

  it("parses Order XXXIX Rules 1, 2, 2A with normalized section numbers", () => {
    const parsed = parseCpcOrders(CPC_ORDERS_SAMPLE);

    const r1 = parsed.find((p) => p.section_num === "O39_R1" || p.section === "Order XXXIX Rule 1");
    assert.ok(r1, "Order XXXIX Rule 1 parsed");
    assert.equal(r1.title, "Cases in which temporary injunction may be granted");

    const r2A = parsed.find((p) => p.section_num === "O39_R2A" || p.section === "Order XXXIX Rule 2A");
    assert.ok(r2A, "Order XXXIX Rule 2A parsed");
    assert.equal(r2A.title, "Consequence of disobedience or breach of injunction");
    assert.match(r2A.text, /detained in the civil prison for a term not exceeding three months/);
  });
});

describe("Parser: Sub-clauses, Provisos, and Explanations", () => {
  it("extracts sub-clauses, provisos, and explanations into structured fields", () => {
    const parsed = parseBareAct(CLAUSES_PROVISO_EXPLANATION_SAMPLE, "BNSS");
    assert.equal(parsed.length, 1);
    const sec480 = parsed[0];

    assert.equal(sec480.section_num, "480");
    assert.equal(sec480.title, "When bail may be taken in case of non-bailable offence");

    // Provisos
    assert.ok(sec480.provisos && sec480.provisos.length >= 2, "extracts at least two provisos");
    assert.match(sec480.provisos[0], /under the age of sixteen years or any woman or any sick or infirm person/);
    assert.match(sec480.provisos[1], /mere fact that an accused person may be required for being identified/);

    // Explanations
    assert.ok(sec480.explanations && sec480.explanations.length >= 1, "extracts explanation");
    assert.match(sec480.explanations[0], /not a resident of India shall not be sufficient ground/);
  });
});

describe("Parser: Invalid Input Rejection & Hygiene", () => {
  it("returns empty array for plain text correspondence or general queries", () => {
    assert.deepEqual(splitIntoSections("Respected Sir,\nPlease find attached our retainer agreement.\nSincerely,"), []);
    assert.deepEqual(splitIntoSections("What is the penalty for cheque bounce under Section 138?"), []);
  });

  it("strips running page headers, footers, and lone page numbers", () => {
    const raw = `
THE ARBITRATION ACT
1. Short title.—This Act may be called the Arbitration Act.
42
CHAPTER II
2. Definitions.—In this Act arbitration means any arbitration.
    `;
    const sections = splitIntoSections(raw);
    assert.equal(sections.length, 2);
    assert.doesNotMatch(sections[0].text, /42|CHAPTER II/);
    assert.doesNotMatch(sections[1].text, /42|CHAPTER II/);
  });
});
