import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { badTitle, documentTitle, tidyDocument } from "../src/services/agent/document-layout.js";

// The draft from the screenshot: a court heading with a placeholder first, and every section run into one line.
const SHOT =
  "IN THE COURT OF [Court Name], [Case Number], [Parties' Names], Synopsis: The defendant, [Defendant's Name], has been arrested on the charge of [Criminal Charge].\n" +
  "Grounds: 1. The defendant has reason to believe that he may be arrested on accusation of having committed a non-bailable offence under Section 438 of the Code of Criminal Procedure, 1973 (Anticipatory Bail). " +
  "2. The defendant has reason to believe that he may be arrested on accusation of having committed a non-bailable offence under Section 482 of the Bharatiya Nagarik Suraksha Sanhita, 2023 (Anticipatory Bail). " +
  "3. The defendant has reason to believe that he may be arrested on accusation of having committed a non-bailable offence under Section 66 of the Information Technology Act, 2000 (Cybercrime). " +
  "Prayers: 1. That the Court grant a direction releasing the defendant on bail in the event of arrest. 2. That the Court take into consideration the nature and gravity of the accusation and the antecedents of the applicant. " +
  "3. That the Court release the defendant on bail immediately upon arrest.\n[Signature Block]\n[Attorney's Name]\n[Date]";

describe("the name of a document", () => {
  it("is never the opening words of its text", () => {
    const title = documentTitle({ content: SHOT, mode: "document", request: "Draft the bail petition.", matterTitle: "Sharma Traders v. Kapoor" });
    assert.equal(title, "Application for Regular Bail: Sharma Traders v. Kapoor");
    assert.ok(!/IN THE COURT|\[|\.\.\./.test(title));
  });

  it("names the paper from the request when there is no matter", () => {
    assert.equal(documentTitle({ content: SHOT, mode: "document", request: "draft an anticipatory bail application" }), "Application for Anticipatory Bail");
    assert.equal(documentTitle({ content: "x".repeat(500), mode: "document", request: "Draft a reply to the legal notice from Delta Traders" }), "Reply to Legal Notice");
    assert.equal(documentTitle({ content: "x".repeat(500), mode: "document", request: "write a legal notice for recovery of money" }), "Legal Notice");
  });

  it("keeps a good heading the model wrote", () => {
    assert.equal(documentTitle({ content: "# Legal Notice for Recovery of Money\n\nBody", mode: "document", request: "draft a notice" }), "Legal Notice for Recovery of Money");
  });

  it("rejects a court heading, a placeholder or a cut-off line as a heading", () => {
    assert.equal(badTitle("IN THE COURT OF THE SESSIONS JUDGE, BIDAR"), true);
    assert.equal(badTitle("Bail Application [Court Name]"), true);
    assert.equal(badTitle("The defendant has reason to believe that he may be arrested on accusation..."), true);
    assert.equal(badTitle("Application for Regular Bail"), false);
    const title = documentTitle({ content: "# IN THE COURT OF [Court Name]\n\n" + "x".repeat(500), mode: "document", request: "draft a bail petition" });
    assert.equal(title, "Application for Regular Bail");
  });

  it("names a plan by what it is for", () => {
    assert.equal(documentTitle({ content: "Objective ...", mode: "plan", request: "Prepare a bail strategy for my client", matterTitle: "State v. Rajesh" }), "Bail Strategy: State v. Rajesh");
    assert.equal(documentTitle({ content: "Objective ...", mode: "plan", request: "give me a plan" }), "Case Plan");
  });

  it("falls back to a plain name, never to a fragment", () => {
    assert.equal(documentTitle({ content: "BY REGISTERED POST\nTo, Mr X", mode: "document", request: "" }), "Legal document");
  });
});

describe("the layout of a document", () => {
  const tidy = tidyDocument(SHOT);
  const lines = tidy.split("\n").filter(Boolean);

  it("puts each section label and each numbered paragraph on its own line, with a blank line between", () => {
    assert.ok(tidy.includes("\n\n"), "paragraphs are separated by blank lines");
    assert.ok(lines.some((l) => l.startsWith("**Grounds:**")));
    assert.ok(lines.some((l) => l.startsWith("**Prayers:**")));
    assert.ok(lines.some((l) => l.startsWith("2. The defendant")));
    assert.ok(lines.some((l) => l.startsWith("3. That the Court release")));
    assert.ok(lines.every((l) => l.length < 330), "no run-on block is left");
  });

  it("does not change the words", () => {
    const words = (s: string) => s.replace(/\*\*/g, "").split(/\s+/).filter(Boolean).join(" ");
    assert.equal(words(tidy), words(SHOT));
  });

  it("separates lines that were written one per line, which Markdown would otherwise merge", () => {
    const out = tidyDocument("IN THE COURT OF THE SESSIONS JUDGE\nCrl.Misc. No. ____\nBETWEEN\nRajesh ... Applicant");
    assert.equal(out, "IN THE COURT OF THE SESSIONS JUDGE\n\nCrl.Misc. No. ____\n\nBETWEEN\n\nRajesh ... Applicant");
  });

  it("keeps headings, bullet lists and tables together", () => {
    const out = tidyDocument("# Title\n- one\n- two\n| a | b |\n| - | - |\n| 1 | 2 |\nText");
    assert.equal(out, "# Title\n\n- one\n- two\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\nText");
  });

  it("leaves a document that is already well laid out alone", () => {
    const good = "# Application for Regular Bail\n\nIN THE COURT OF THE SESSIONS JUDGE\n\n1. First paragraph.\n\n2. Second paragraph.\n\nPRAYER\n\nAdvocate";
    assert.equal(tidyDocument(good), good);
  });

  it("does not split numbers that do not run 1, 2, 3", () => {
    const text = "The amount is Rs. 5,00,000 and the cheque numbered 4 was returned. " + "Further text ".repeat(40) + "See Section 138 and 2. Another matter. " + "More text ".repeat(30);
    assert.equal(tidyDocument(text).split("\n").filter(Boolean).length, 1);
  });
});
