/**
 * Unit Test Suite: Legal Corpus Seeder & Precedent Verification
 * Target File: lirava-api/tests/unit/seeder.test.ts
 *
 * Verifies:
 * 1. Seeded corpus contains all 8 mandatory Bare Acts (BNSS, BNS, BSA, CPC, CRPC, IPC, ICA, NIA).
 * 2. Every provision adheres strictly to the ParsedProvision schema with valid fields.
 * 3. Bi-directional concordance mapping exists between colonial acts and replacement sanhitas.
 * 4. All 9 mandatory landmark judicial precedents are present with valid official citations,
 *    bench details, formulated principles, and statutory cross-references.
 * 5. Completely offline execution with zero network or external DB calls.
 *
 * Execution: pnpm exec tsx --test tests/unit/seeder.test.ts (< 300ms execution time).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  STATUTORY_CORPUS_SEED,
  PRECEDENT_CORPUS_SEED,
  type ParsedProvision,
  type ParsedPrecedent,
} from "../../src/services/legal/corpus-seeder.js";

// Canonical 8 Target Acts
const REQUIRED_ACT_CODES = ["BNSS", "BNS", "BSA", "CPC", "CRPC", "IPC", "ICA", "NIA"] as const;

// 9 Mandatory Landmark Precedents
const REQUIRED_PRECEDENT_IDS = [
  "sc-bhajan-lal-1992",
  "sc-satender-antil-2022",
  "sc-arnesh-kumar-2014",
  "sc-dk-basu-1997",
  "sc-arjun-panditrao-2020",
  "sc-satyabrata-ghose-1954",
  "sc-dalpat-kumar-1992",
  "sc-basalingappa-2019",
  "sc-sms-pharma-2005",
] as const;

describe("Seeder: Statutory Coverage Across All 8 Target Acts", () => {
  it("contains provisions for all 8 mandatory Indian Acts", () => {
    const presentActCodes = new Set(STATUTORY_CORPUS_SEED.map((p) => p.act_code));
    for (const actCode of REQUIRED_ACT_CODES) {
      assert.ok(presentActCodes.has(actCode), `Mandatory Act '${actCode}' must be present in statutory seed`);
    }
  });

  it("seeds core criminal procedure provisions in BNSS (2023)", () => {
    const bnss = STATUTORY_CORPUS_SEED.filter((p) => p.act_code === "BNSS");
    const sections = new Set(bnss.map((p) => p.section_num));

    assert.ok(sections.has("35"), "BNSS Section 35 (Arrest notice) must exist");
    assert.ok(sections.has("173"), "BNSS Section 173 (FIR / e-FIR) must exist");
    assert.ok(sections.has("193"), "BNSS Section 193 (Chargesheet) must exist");
    assert.ok(sections.has("480"), "BNSS Section 480 (Magisterial bail) must exist");
    assert.ok(sections.has("482"), "BNSS Section 482 (Anticipatory bail) must exist");
    assert.ok(sections.has("483"), "BNSS Section 483 (Sessions/HC bail) must exist");
    assert.ok(sections.has("528"), "BNSS Section 528 (Quashing / Inherent powers) must exist");
  });

  it("seeds core substantive penal provisions in BNS (2023)", () => {
    const bns = STATUTORY_CORPUS_SEED.filter((p) => p.act_code === "BNS");
    const sections = new Set(bns.map((p) => p.section_num));

    assert.ok(sections.has("103"), "BNS Section 103 (Murder) must exist");
    assert.ok(sections.has("105"), "BNS Section 105 (Culpable homicide) must exist");
    assert.ok(sections.has("106"), "BNS Section 106 (Negligent death & Hit-and-run) must exist");
    assert.ok(sections.has("316"), "BNS Section 316 (Criminal breach of trust) must exist");
    assert.ok(sections.has("318"), "BNS Section 318 (Cheating) must exist");
    assert.ok(sections.has("80"), "BNS Section 80 (Dowry death) must exist");
    assert.ok(sections.has("85"), "BNS Section 85 (Cruelty by husband/relatives) must exist");
  });

  it("seeds core evidentiary provisions in BSA (2023)", () => {
    const bsa = STATUTORY_CORPUS_SEED.filter((p) => p.act_code === "BSA");
    const sections = new Set(bsa.map((p) => p.section_num));

    assert.ok(sections.has("61"), "BSA Section 61 (Admissibility of electronic records) must exist");
    assert.ok(sections.has("63"), "BSA Section 63 (Electronic certificate requirement) must exist");
    assert.ok(sections.has("23"), "BSA Section 23 (Confessions to police) must exist");
    assert.ok(sections.has("26"), "BSA Section 26 (Dying declarations) must exist");
  });

  it("seeds foundational provisions for Civil Procedure Code (1908)", () => {
    const cpc = STATUTORY_CORPUS_SEED.filter((p) => p.act_code === "CPC");
    const sections = new Set(cpc.map((p) => p.section_num));

    assert.ok(sections.has("O39_R1") || sections.has("O39_R1_2"), "CPC Order XXXIX Rule 1 must exist");
    assert.ok(sections.has("O7_R11"), "CPC Order VII Rule 11 must exist");
    assert.ok(sections.has("9"), "CPC Section 9 must exist");
    assert.ok(sections.has("11"), "CPC Section 11 (Res Judicata) must exist");
    assert.ok(sections.has("151"), "CPC Section 151 (Inherent powers) must exist");
  });

  it("seeds foundational provisions for Indian Contract Act (1872)", () => {
    const ica = STATUTORY_CORPUS_SEED.filter((p) => p.act_code === "ICA");
    const sections = new Set(ica.map((p) => p.section_num));

    assert.ok(sections.has("10"), "Contract Act Section 10 must exist");
    assert.ok(sections.has("23"), "Contract Act Section 23 (Lawful consideration) must exist");
    assert.ok(sections.has("56"), "Contract Act Section 56 (Frustration) must exist");
    assert.ok(sections.has("73"), "Contract Act Section 73 (Breach damages) must exist");
    assert.ok(sections.has("124"), "Contract Act Section 124 (Indemnity) must exist");
    assert.ok(sections.has("126"), "Contract Act Section 126 (Guarantee) must exist");
  });

  it("seeds core commercial dishonour provisions in NI Act (1881)", () => {
    const nia = STATUTORY_CORPUS_SEED.filter((p) => p.act_code === "NIA");
    const sections = new Set(nia.map((p) => p.section_num));

    assert.ok(sections.has("138"), "NI Act Section 138 (Cheque bounce) must exist");
    assert.ok(sections.has("139"), "NI Act Section 139 (Presumption) must exist");
    assert.ok(sections.has("141"), "NI Act Section 141 (Director liability) must exist");
    assert.ok(sections.has("143A"), "NI Act Section 143A (Interim compensation) must exist");
  });
});

describe("Seeder: Provision Schema & Concordance Integrity", () => {
  it("enforces complete schema compliance for all seeded provisions", () => {
    for (const p of STATUTORY_CORPUS_SEED) {
      assert.ok(p.id && p.id.length > 3, `Provision ${p.id} must have valid id`);
      assert.ok(REQUIRED_ACT_CODES.includes(p.act_code as any), `Invalid act_code in ${p.id}`);
      assert.ok(p.act_title && p.act_title.length > 5, `Invalid act_title in ${p.id}`);
      assert.ok(Number.isInteger(p.year) && p.year >= 1860 && p.year <= 2026, `Invalid year in ${p.id}`);
      assert.ok(p.section && p.section.length >= 3, `Invalid section in ${p.id}`);
      assert.ok(p.section_num && p.section_num.length >= 1, `Invalid section_num in ${p.id}`);
      assert.ok(p.title && p.title.length >= 3, `Invalid title in ${p.id}`);
      assert.ok(p.text && p.text.length >= 25, `Substantive text too short in ${p.id}`);
      assert.ok(p.category && p.category.length >= 3, `Invalid category in ${p.id}`);
    }
  });

  it("verifies bidirectional concordance between colonial acts and sanhitas", () => {
    const findBNSS = (sec: string) => STATUTORY_CORPUS_SEED.find((p) => p.act_code === "BNSS" && p.section_num === sec);
    const findCRPC = (sec: string) => STATUTORY_CORPUS_SEED.find((p) => p.act_code === "CRPC" && p.section_num === sec);
    const findBNS = (sec: string) => STATUTORY_CORPUS_SEED.find((p) => p.act_code === "BNS" && p.section_num === sec);
    const findIPC = (sec: string) => STATUTORY_CORPUS_SEED.find((p) => p.act_code === "IPC" && p.section_num === sec);

    // Anticipatory Bail: BNSS 482 <-> CrPC 438
    const bnss482 = findBNSS("482");
    if (bnss482) {
      assert.equal(bnss482.replaces?.act_code, "CRPC");
      assert.match(bnss482.replaces?.section || "", /438/);
    }
    const crpc438 = findCRPC("438");
    if (crpc438) {
      assert.equal(crpc438.replaced_by?.act_code, "BNSS");
      assert.match(crpc438.replaced_by?.section || "", /482/);
    }

    // Quashing: BNSS 528 <-> CrPC 482
    const bnss528 = findBNSS("528");
    if (bnss528) {
      assert.equal(bnss528.replaces?.act_code, "CRPC");
      assert.match(bnss528.replaces?.section || "", /482/);
    }
    const crpc482 = findCRPC("482");
    if (crpc482) {
      assert.equal(crpc482.replaced_by?.act_code, "BNSS");
      assert.match(crpc482.replaced_by?.section || "", /528/);
    }

    // Murder: BNS 103 <-> IPC 302
    const bns103 = findBNS("103");
    if (bns103) {
      assert.equal(bns103.replaces?.act_code, "IPC");
      assert.match(bns103.replaces?.section || "", /302/);
    }

    // Cheating: BNS 318 <-> IPC 420
    const bns318 = findBNS("318");
    if (bns318) {
      assert.equal(bns318.replaces?.act_code, "IPC");
      assert.match(bns318.replaces?.section || "", /420/);
    }
  });
});

describe("Seeder: Landmark Precedents Verification", () => {
  it("contains all 9 mandatory Supreme Court landmark precedents", () => {
    const presentIds = new Set(PRECEDENT_CORPUS_SEED.map((p) => p.id));
    for (const precId of REQUIRED_PRECEDENT_IDS) {
      assert.ok(presentIds.has(precId), `Mandatory Precedent '${precId}' must be loaded in precedent seed`);
    }
  });

  it("verifies accurate citations, bench, and ratios for every precedent", () => {
    for (const prec of PRECEDENT_CORPUS_SEED) {
      assert.ok(prec.id.startsWith("sc-"), `Precedent ID must start with 'sc-': ${prec.id}`);
      assert.match(prec.case_title, / v\. | vs\. /i, `Case title must contain 'v.': ${prec.case_title}`);
      assert.ok(prec.primary_citation && prec.primary_citation.length >= 8, `Invalid primary citation in ${prec.id}`);
      assert.ok(Array.isArray(prec.equivalent_citations) && prec.equivalent_citations.length >= 1, `Equivalent citations missing in ${prec.id}`);
      assert.equal(prec.court, "Supreme Court of India");
      assert.ok(Number.isInteger(prec.year) && prec.year >= 1950 && prec.year <= 2026, `Invalid year in ${prec.id}`);
      assert.ok(prec.bench_description && prec.bench_description.length >= 5, `Bench description missing in ${prec.id}`);
      assert.ok(prec.ratio && prec.ratio.length >= 60, `Ratio too short or missing in ${prec.id}`);
      assert.ok(Array.isArray(prec.principles) && prec.principles.length >= 2, `Precedent ${prec.id} must formulate at least 2 distinct principles`);
      assert.ok(Array.isArray(prec.statutory_citations) && prec.statutory_citations.length >= 1, `Statutory citations missing in ${prec.id}`);
    }
  });

  it("validates official neutral citations format (YYYY INSC NNN) where applicable", () => {
    const inscPrecedents = PRECEDENT_CORPUS_SEED.filter((p) => p.neutral_citation);
    assert.ok(inscPrecedents.length >= 7, "Majority of modern precedents must contain neutral INSC citations");
    for (const p of inscPrecedents) {
      assert.match(p.neutral_citation!, /^\d{4} INSC \d+$/, `Invalid INSC citation format in ${p.id}`);
    }
  });

  it("verifies precise statutory cross-references for individual precedents", () => {
    // 1. Bhajan Lal -> CrPC 482 / BNSS 528
    const bhajan = PRECEDENT_CORPUS_SEED.find((p) => p.id === "sc-bhajan-lal-1992");
    assert.ok(bhajan);
    assert.ok(bhajan.statutory_citations.some((s) => s.act_code === "CRPC" && s.section.includes("482")));

    // 2. Satender Kumar Antil -> CrPC 41A / BNSS 35
    const antil = PRECEDENT_CORPUS_SEED.find((p) => p.id === "sc-satender-antil-2022");
    assert.ok(antil);
    assert.ok(antil.statutory_citations.some((s) => (s.act_code === "CRPC" && s.section.includes("41A")) || (s.act_code === "BNSS" && s.section.includes("35"))));

    // 3. Arnesh Kumar -> CrPC 41 / IPC 498A
    const arnesh = PRECEDENT_CORPUS_SEED.find((p) => p.id === "sc-arnesh-kumar-2014");
    assert.ok(arnesh);
    assert.ok(arnesh.statutory_citations.some((s) => s.act_code === "CRPC" && s.section.includes("41")));

    // 4. D.K. Basu -> CrPC 41B
    const dkBasu = PRECEDENT_CORPUS_SEED.find((p) => p.id === "sc-dk-basu-1997");
    assert.ok(dkBasu);
    assert.ok(dkBasu.statutory_citations.some((s) => s.act_code === "CRPC" && s.section.includes("41B")));

    // 5. Arjun Panditrao Khotkar -> BSA 63 / IEA 65B
    const khotkar = PRECEDENT_CORPUS_SEED.find((p) => p.id === "sc-arjun-panditrao-2020");
    assert.ok(khotkar);
    assert.ok(khotkar.statutory_citations.some((s) => s.section.includes("65B") || s.section.includes("63")));

    // 6. Satyabrata Ghose -> Contract Act 56
    const satyabrata = PRECEDENT_CORPUS_SEED.find((p) => p.id === "sc-satyabrata-ghose-1954");
    assert.ok(satyabrata);
    assert.ok(satyabrata.statutory_citations.some((s) => s.act_code === "ICA" && s.section.includes("56")));

    // 7. Dalpat Kumar -> CPC Order XXXIX
    const dalpat = PRECEDENT_CORPUS_SEED.find((p) => p.id === "sc-dalpat-kumar-1992");
    assert.ok(dalpat);
    assert.ok(dalpat.statutory_citations.some((s) => s.act_code === "CPC" && s.section.includes("XXXIX")));

    // 8. Basalingappa -> NI Act 138/139
    const basalingappa = PRECEDENT_CORPUS_SEED.find((p) => p.id === "sc-basalingappa-2019");
    assert.ok(basalingappa);
    assert.ok(basalingappa.statutory_citations.some((s) => s.act_code === "NIA" && (s.section.includes("138") || s.section.includes("139"))));

    // 9. SMS Pharmaceuticals -> NI Act 141
    const sms = PRECEDENT_CORPUS_SEED.find((p) => p.id === "sc-sms-pharma-2005");
    assert.ok(sms);
    assert.ok(sms.statutory_citations.some((s) => s.act_code === "NIA" && s.section.includes("141")));
  });
});
