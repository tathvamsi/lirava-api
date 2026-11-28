process.env.NODE_ENV = "test";

import test from "node:test";
import assert from "node:assert/strict";
import { buildKnowledgeTreeContext, buildKnowledgeTreeSources, keepCitedTreeSources } from "../src/services/casebrain/context.js";
import { buildOnboardingNodes } from "../src/services/casebrain/onboarding.js";
import type { CaseNode } from "../src/services/casebrain/index.js";

const node = (input: Partial<CaseNode> & Pick<CaseNode, "id" | "kind" | "title">): CaseNode => ({
  matterId: "matter_1",
  parentId: null,
  body: "",
  date: null,
  sources: [],
  links: [],
  status: "confirmed",
  origin: "lawyer",
  position: 0,
  createdAt: 1,
  updatedAt: 1,
  ...input,
});

test("retrieves confirmed knowledge-tree entries relevant to a matter question", () => {
  const context = buildKnowledgeTreeContext(
    "Who is our client and what happened after the notice?",
    [
      node({ id: "parties", kind: "section", title: "Parties" }),
      node({ id: "client", kind: "party", parentId: "parties", title: "Client: Asha Rao", body: "Purchaser" }),
      node({ id: "dates", kind: "section", title: "Chronology" }),
      node({ id: "notice", kind: "event", parentId: "dates", title: "Legal notice served", body: "The seller did not reply.", date: "2026-03-14" }),
      node({ id: "internal", kind: "note", title: "Private draft thought", body: "Do not use this yet.", status: "proposed" }),
    ],
  );

  assert.match(context, /Client: Asha Rao/);
  assert.match(context, /Legal notice served/);
  assert.match(context, /2026-03-14/);
  assert.doesNotMatch(context, /Private draft thought/);
});

test("does not present disputed tree entries as established case facts", () => {
  const context = buildKnowledgeTreeContext("What is the sale consideration?", [
    node({ id: "facts", kind: "section", title: "Facts" }),
    node({ id: "price", kind: "fact", parentId: "facts", title: "Sale consideration: Rs. 18,50,000" }),
    node({ id: "wrong-price", kind: "fact", parentId: "facts", title: "Sale consideration: Rs. 25,00,000", status: "disputed" }),
  ]);

  assert.match(context, /Rs\. 18,50,000/);
  assert.doesNotMatch(context, /Rs\. 25,00,000/);
});

test("turns the handover briefing into confirmed knowledge-tree entries", () => {
  const entries = buildOnboardingNodes({
    title: "Rao v. Builders",
    client: "Asha Rao",
    court: "Karnataka High Court",
    intake: {
      brief: "Asha paid the advance, but the builder did not execute the sale deed.",
      caseType: "Property",
      oppositeParty: "Kapoor Builders",
      keyDates: [{ label: "Agreement signed", date: "2026-03-14" }],
      outcome: "Recover the advance with interest.",
      urgency: "soon",
      deadline: "2026-04-02",
    },
  });

  assert.deepEqual(
    entries.map((entry) => [entry.section, entry.kind, entry.title, entry.status]),
    [
      ["Parties", "party", "Client: Asha Rao", "confirmed"],
      ["Parties", "party", "Opposite party: Kapoor Builders", "confirmed"],
      ["Facts", "fact", "Case summary", "confirmed"],
      ["Facts", "fact", "Case type: Property", "confirmed"],
      ["Facts", "fact", "Court / forum: Karnataka High Court", "confirmed"],
      ["Chronology", "event", "Agreement signed", "confirmed"],
      ["Issues", "issue", "Objective", "confirmed"],
      ["Chronology", "event", "Deadline", "confirmed"],
    ],
  );
});

test("labels each tree entry so an answer can cite it, and returns a citation for every label", () => {
  const { text, citations } = buildKnowledgeTreeSources("Who is the client?", [
    node({ id: "parties", kind: "section", title: "Parties" }),
    node({ id: "client", kind: "party", parentId: "parties", title: "Client: Asha Rao", body: "Purchaser" }),
    node({ id: "dates", kind: "section", title: "Chronology" }),
    node({ id: "notice", kind: "event", parentId: "dates", title: "Legal notice served", date: "2026-03-14" }),
  ]);

  assert.match(text, /\[T1\] Parties — Client: Asha Rao/);
  assert.match(text, /\[T2\] Chronology — Legal notice served \(2026-03-14\)/);
  assert.match(text, /cite the label in square brackets/i);
  assert.deepEqual(
    citations.map((c) => ({ kind: c.kind, label: c.label, title: c.title, section: c.section, date: c.date ?? null })),
    [
      { kind: "case", label: "T1", title: "Client: Asha Rao", section: "Parties", date: null },
      { kind: "case", label: "T2", title: "Legal notice served", section: "Chronology", date: "2026-03-14" },
    ],
  );
  assert.equal(citations[0].nodeId, "client");
});

test("does not present a placeholder such as 'Yet to Know' as a party or a fact", () => {
  const { text, citations } = buildKnowledgeTreeSources("Who is the opposite party?", [
    node({ id: "parties", kind: "section", title: "Parties" }),
    node({ id: "opp", kind: "party", parentId: "parties", title: "Opposite party: Yet to Know" }),
    node({ id: "client", kind: "party", parentId: "parties", title: "Client: Manjunath Gowda" }),
  ]);

  assert.match(text, /Opposite party: not recorded/);
  assert.doesNotMatch(text, /Yet to Know/i);
  assert.match(text, /Client: Manjunath Gowda/);
  assert.equal(citations.find((c) => c.nodeId === "opp")?.title, "Opposite party: not recorded");
});

test("says a bare deadline's purpose is not recorded instead of leaving the model to guess", () => {
  const { text } = buildKnowledgeTreeSources("What is the next deadline?", [
    node({ id: "dates", kind: "section", title: "Chronology" }),
    node({ id: "dl", kind: "event", parentId: "dates", title: "Deadline", date: "2026-11-28" }),
    node({ id: "hearing", kind: "event", parentId: "dates", title: "Reply to notice due", date: "2026-12-02" }),
  ]);

  assert.match(text, /Deadline \(2026-11-28\) — what it is for is not recorded/);
  assert.doesNotMatch(text, /Reply to notice due \(2026-12-02\) — what it is for/);
});

test("keeps only the tree entries the answer actually cites", () => {
  const { citations } = buildKnowledgeTreeSources("Tell me about the matter", [
    node({ id: "parties", kind: "section", title: "Parties" }),
    node({ id: "a", kind: "party", parentId: "parties", title: "Client: Asha Rao" }),
    node({ id: "b", kind: "party", parentId: "parties", title: "Opposite party: Builders Ltd" }),
    node({ id: "c", kind: "fact", parentId: "parties", title: "Advance paid" }),
  ]);
  const docs = [{ kind: "document" as const, label: "D1", fileId: "f", name: "n.pdf", page: 1, unit: "page" as const, excerpt: "x" }];

  const kept = keepCitedTreeSources([...docs, ...citations], "Asha Rao paid the advance [T1][T3] and the builder did not reply [D1].");
  assert.deepEqual(kept.map((c) => c.label), ["D1", "T1", "T3"]);
  assert.deepEqual(keepCitedTreeSources([...docs, ...citations], "No tree facts used [D1].").map((c) => c.label), ["D1"]);
  assert.deepEqual(keepCitedTreeSources(citations, "Listed together [T1, T2].").map((c) => c.label), ["T1", "T2"]);
});

test("the handover does not store a placeholder as the opposite party", () => {
  const entries = buildOnboardingNodes({
    title: "Manjunath Gowda v. Yet to Know",
    client: "Manjunath Gowda",
    court: "LXIV Additional City Civil and Sessions Judge, Bengaluru",
    intake: { brief: "FIR registered.", caseType: "Criminal", oppositeParty: "Yet to know", keyDates: [], outcome: "", urgency: "soon", deadline: "" },
  });
  assert.equal(entries.some((e) => /opposite party/i.test(e.title)), false);
  assert.equal(entries.some((e) => /Manjunath Gowda/.test(e.title)), true);
});
