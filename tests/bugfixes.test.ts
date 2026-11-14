process.env.NODE_ENV = "test";

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { getRunState, abortRun } from "../src/services/agent/runtime.js";
import { createConversation, deleteConversation, insertMessage, listMessages } from "../src/services/chats/store.js";
import { AuthError, loginUser, registerUser } from "../src/services/auth/index.js";
import { getSql } from "../src/services/db/postgres.js";
import { drawableLine, generateDocumentDocx, generateDocumentPdf, parseBlocks } from "../src/services/legal/documents.js";
import { generateCourtPdf } from "../src/services/legal/court-engine.js";
import { createTestUser, type TestUser } from "./helpers.js";

describe("answers are tracked per chat", () => {
  it("sending or stopping in one chat leaves another chat's answer running", () => {
    const user = "user-runs";
    const chatA = getRunState("conv-a", user, "agent-1");
    const chatB = getRunState("conv-b", user, "agent-1");
    const abortA = new AbortController();
    const abortB = new AbortController();
    Object.assign(chatA, { running: true, abortController: abortA });
    Object.assign(chatB, { running: true, abortController: abortB });

    assert.equal(abortRun("agent-1", user, "conv-a"), true);
    assert.equal(abortA.signal.aborted, true, "the chat being stopped is stopped");
    assert.equal(abortB.signal.aborted, false, "the other chat keeps going");
    assert.equal(chatB.running, true);

    // Without a chat, every running answer of that agent for this user stops, and nobody else's.
    const other = getRunState("conv-c", "someone-else", "agent-1");
    const abortC = new AbortController();
    Object.assign(other, { running: true, abortController: abortC });
    assert.equal(abortRun("agent-1", user), true);
    assert.equal(abortB.signal.aborted, true);
    assert.equal(abortC.signal.aborted, false, "another user's run is never touched");
    abortRun("agent-1", "someone-else");
  });
});

describe("retrying a message does not store it twice", () => {
  let alice: TestUser;
  let bob: TestUser;
  const ids: Array<[string, string]> = [];

  before(async () => {
    alice = await createTestUser("retry_alice");
    bob = await createTestUser("retry_bob");
  });
  after(async () => {
    for (const [id, user] of ids) await deleteConversation(id, user).catch(() => undefined);
  });

  it("returns the original message when the same id is sent again", async () => {
    const conv = await createConversation("agent-1", "Retry", alice.id, `conv_retry_${Date.now()}`);
    ids.push([conv.id, alice.id]);
    const messageId = `msg-client-${Date.now()}`;
    const first = await insertMessage({ id: messageId, conversationId: conv.id, userId: alice.id, vakilId: "agent-1", role: "user", text: "Section 483?" });
    const again = await insertMessage({ id: messageId, conversationId: conv.id, userId: alice.id, vakilId: "agent-1", role: "user", text: "Section 483?" });
    assert.equal(again.id, first.id);
    assert.equal((await listMessages(conv.id, alice.id)).length, 1, "one saved question, not two");
  });

  it("never reuses or overwrites another user's message id", async () => {
    const mine = await createConversation("agent-1", "Mine", alice.id, `conv_mine_${Date.now()}`);
    const theirs = await createConversation("agent-1", "Theirs", bob.id, `conv_theirs_${Date.now()}`);
    ids.push([mine.id, alice.id], [theirs.id, bob.id]);
    const sharedId = `msg-shared-${Date.now()}`;
    await insertMessage({ id: sharedId, conversationId: theirs.id, userId: bob.id, vakilId: "agent-1", role: "user", text: "Bob's private question" });
    const stored = await insertMessage({ id: sharedId, conversationId: mine.id, userId: alice.id, vakilId: "agent-1", role: "user", text: "Alice's question" });
    assert.notEqual(stored.id, sharedId, "gets a fresh id");
    assert.equal((await listMessages(theirs.id, bob.id))[0].text, "Bob's private question", "Bob's message is untouched");
  });
});

describe("sign-in lock", () => {
  const strong = "Password123!Secure";

  it("blocks the address that keeps guessing but not the real owner on another address", async () => {
    const email = `lockpair_${Date.now()}@example.com`;
    await registerUser({ name: "Lock Pair", email, password: strong });

    for (let i = 0; i < 8; i++) {
      await assert.rejects(loginUser({ email, password: "Wrong-password-1", ip: "203.0.113.9" }), (e: unknown) => e instanceof AuthError && e.status === 401);
    }
    await assert.rejects(loginUser({ email, password: strong, ip: "203.0.113.9" }), (e: unknown) => e instanceof AuthError && e.status === 429, "the guessing address is held back");

    const owner = await loginUser({ email, password: strong, ip: "198.51.100.7" });
    assert.ok(owner.token, "the owner, from their own address, can still sign in");
  });

  it("keeps the failures in PostgreSQL so a restart does not forget them", async () => {
    const email = `lockstore_${Date.now()}@example.com`;
    await registerUser({ name: "Lock Store", email, password: strong });
    await loginUser({ email, password: "Wrong-password-1", ip: "203.0.113.50" }).catch(() => undefined);
    const sql = getSql();
    assert.ok(sql);
    const [row] = await sql`SELECT COUNT(*)::int AS n FROM login_failures WHERE email = ${email} AND ip = ${"203.0.113.50"}`;
    assert.equal(Number(row.n), 1);
  });
});

describe("exported documents", () => {
  it("turns Markdown tables into real tables in PDF and Word", async () => {
    const content = "Schedule of dates\n\n| Date | Event |\n| --- | --- |\n| 3 Oct 2026 | Arrest |\n| 4 Dec 2026 | Next hearing |\n\nAfter the table.";
    const blocks = parseBlocks(content);
    const table = blocks.find((b) => b.type === "table");
    assert.ok(table && table.type === "table");
    assert.deepEqual(table.rows, [["Date", "Event"], ["3 Oct 2026", "Arrest"], ["4 Dec 2026", "Next hearing"]]);

    const pdf = await PDFDocument.load(await generateDocumentPdf({ title: "Dates", content }));
    assert.ok(pdf.getPageCount() >= 1);
    assert.ok((await generateDocumentDocx({ title: "Dates", content })).length > 2000);
  });

  it("keeps a very tall table together across pages without throwing", async () => {
    const rows = Array.from({ length: 80 }, (_, i) => `| ${i + 1} | A long description for row ${i + 1} that needs to wrap inside its cell across more than one line of text |`);
    const pdf = await PDFDocument.load(await generateDocumentPdf({ title: "Long table", content: ["| No | Description |", "| --- | --- |", ...rows].join("\n") }));
    assert.ok(pdf.getPageCount() >= 3);
  });

  it("does not damage the letter s when preparing text for the PDF", async () => {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.TimesRoman);
    assert.equal(drawableLine(font, "Respondents   assess\nsuccess"), "Respondents assess success");
    // And the pleading generator accepts such text end to end.
    const bytes = await generateCourtPdf({
      courtName: "In the High Court of Karnataka",
      caseType: "Writ Petition",
      petitioner: "Sessions Bank Ltd.",
      respondent: "State & Others",
      grounds: ["That the Respondents'  assessments were passed\nwithout a hearing."],
      prayers: ["Quash the assessment."],
    });
    assert.ok(bytes.length > 800);
  });
});
