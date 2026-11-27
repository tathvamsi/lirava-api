process.env.NODE_ENV = "test";

import test from "node:test";
import assert from "node:assert/strict";
import { buildKnowledgeTreeContext } from "../src/services/casebrain/context.js";
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
