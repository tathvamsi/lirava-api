import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { INTAKE_HEADER, intakeKindOf, intakeMessage, intakeReplyTo, intakeTask, isThinReply, matterFactsBrief, planIntake, type IntakeMatter } from "../src/services/agent/intake.js";
import type { CaseFileContent } from "../src/services/casefile/extract.js";

const REQUEST = "Draft the bail petition.";
const ids = (p: ReturnType<typeof planIntake>) => p?.missing.map((m) => m.id);

const emptyMatter: IntakeMatter = { title: "State v. Rajesh", client: "", court: "", notes: "", intake: null };
const fullMatter: IntakeMatter = {
  title: "State v. Rajesh Naik",
  client: "Rajesh Naik",
  court: "Sessions Court, Bidar",
  notes: "",
  intake: { brief: "Accused of murder under Section 103 BNS after a quarrel at the bus stand; arrested on 15 August 2025 and in custody since.", keyDates: [{ label: "Date of arrest", date: "2025-08-15" }] },
};

const caseFile = (over: Partial<CaseFileContent> = {}): CaseFileContent => ({
  documents: [],
  parties: [],
  chronology: [],
  facts: [],
  claims: [],
  stats: { kept: 0, dropped: 0 },
  ...over,
});
const src = { docId: "d1", name: "fir.pdf", page: 1 };

describe("which requests get the bail checklist", () => {
  it("bail and anticipatory bail petitions do, and nothing else does", () => {
    assert.equal(intakeKindOf(REQUEST), "bail");
    assert.equal(intakeKindOf("Draft an anticipatory bail application"), "anticipatory_bail");
    assert.equal(intakeKindOf("Prepare a petition for regular bail"), "bail");
    assert.equal(intakeKindOf("Draft a legal notice for recovery of money"), null);
    assert.equal(intakeKindOf("What is the test for bail under BNSS?"), null);
  });
});

describe("what is asked", () => {
  it("with nothing on file, asks for the accused, the court, the case, custody and the language", () => {
    const plan = planIntake({ request: REQUEST, history: [], matter: null, caseFile: null });
    assert.deepEqual(ids(plan), ["accused", "court", "case", "custody", "language"]);
    const text = intakeMessage(plan!);
    assert.ok(text.startsWith(INTAKE_HEADER));
    assert.match(text, /full name of the person/i);
    assert.match(text, /Which court/);
    assert.match(text, /what the case is about/);
    assert.match(text, /date of arrest/i);
    assert.match(text, /\[PLACEHOLDER\]/);
  });

  it("does not ask for what the matter already holds", () => {
    const plan = planIntake({ request: REQUEST, history: [], matter: fullMatter, caseFile: null, savedLanguage: "kn" });
    assert.deepEqual(ids(plan), []);
    assert.ok(plan!.known.some((k) => k.includes("Rajesh Naik")));
    assert.ok(plan!.known.some((k) => k.includes("Sessions Court, Bidar")));
    assert.ok(plan!.known.some((k) => /Kannada/.test(k)));
  });

  it("takes the accused, the dates and the facts from the case file", () => {
    const cf = caseFile({
      parties: [{ name: "Ravi Shankar Naik", role: "accused", source: src, quote: "q" }],
      chronology: [
        { date: "2025-08-15", what: "Arrested by Bidar Town police", source: src, quote: "q" },
        { date: "2025-08-14", what: "Assault near the bus stand", source: src, quote: "q" },
      ],
    });
    const plan = planIntake({ request: REQUEST, history: [], matter: emptyMatter, caseFile: cf, savedLanguage: "en" });
    assert.deepEqual(ids(plan), ["court"], "only the court is still unknown");
  });

  it("counts what the lawyer wrote in the request and earlier in the chat", () => {
    const text = "Draft a bail petition in English for my client Ramesh Kumar before the Sessions Court Bidar. FIR No. 214/2025 under Section 103 BNS, arrested on 15 August 2025.";
    assert.deepEqual(ids(planIntake({ request: text, history: [], matter: null, caseFile: null })), []);
    const earlier = [{ role: "user", content: "My client Ramesh Kumar was arrested on 15 August 2025." }];
    assert.deepEqual(ids(planIntake({ request: REQUEST, history: earlier, matter: null, caseFile: null })), ["court", "case", "language"]);
  });

  it("a matter with a title but no client still asks for the name", () => {
    assert.ok(ids(planIntake({ request: REQUEST, history: [], matter: emptyMatter, caseFile: null }))!.includes("accused"));
  });
});

describe("the reply", () => {
  const plan = planIntake({ request: REQUEST, history: [], matter: null, caseFile: null })!;
  const checklist = intakeMessage(plan);

  it("is tied back to the original request", () => {
    const r = intakeReplyTo([{ role: "user", content: REQUEST }, { role: "assistant", content: checklist }]);
    assert.equal(r?.original, REQUEST);
    assert.equal(r?.kind, "bail");
    assert.equal(r?.asked, 1);
  });

  it("is not found when the last assistant message was an ordinary answer", () => {
    assert.equal(intakeReplyTo([{ role: "user", content: REQUEST }, { role: "assistant", content: "Here is a general note on bail." }]), null);
    assert.equal(intakeReplyTo([]), null);
  });

  it("a repeat of the request, or a few words, is not the details", () => {
    assert.equal(isThinReply("Draft the bail petition.", REQUEST), true);
    assert.equal(isThinReply("draft bail petition", REQUEST), true);
    assert.equal(isThinReply("Ramesh Kumar, Sessions Court Bidar, FIR 214/2025 under section 103 BNS, arrested 15 Aug 2025, in custody", REQUEST), false);
  });

  it("counts how often it was asked, so it is never asked a third time", () => {
    const again = intakeMessage(plan, { again: true });
    const history = [
      { role: "user", content: REQUEST },
      { role: "assistant", content: checklist },
      { role: "user", content: REQUEST },
      { role: "assistant", content: again },
    ];
    assert.equal(intakeReplyTo(history)?.asked, 2);
    assert.match(again, /still need/i);
  });
});

describe("the task the model gets", () => {
  it("carries the request, the file's facts, the lawyer's details and an order to write now", () => {
    const task = intakeTask({ original: REQUEST, known: ["Court: Sessions Court, Bidar"], details: "Ramesh Kumar, FIR 214/2025, arrested 15 Aug 2025", language: "kn" });
    assert.match(task, /Draft the bail petition/);
    assert.match(task, /Sessions Court, Bidar/);
    assert.match(task, /Ramesh Kumar/);
    assert.match(task, /Write it in Kannada/);
    assert.match(task, /Do not ask any question first/);
    assert.match(task, /\[PLACEHOLDER\]/);
  });

  it("the file's facts are listed for the model, with the matter form and the documents both used", () => {
    const brief = matterFactsBrief(fullMatter, caseFile({ parties: [{ name: "Lakshmi Gowda", role: "complainant", source: src, quote: "q" }] }));
    assert.match(brief, /Brief: Accused of murder/);
    assert.match(brief, /Date: Date of arrest: 2025-08-15/);
    assert.match(brief, /Party: Lakshmi Gowda \(complainant\)/);
    assert.equal(matterFactsBrief(null, null), "");
  });
});
