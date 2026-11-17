process.env.NODE_ENV = "test";

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { config } from "../src/config.js";
import { createTestUser, type TestUser } from "./helpers.js";

const NOTICE =
  "LEGAL NOTICE dated 14 March 2026. Under Section 138 of the Negotiable Instruments Act, 1881. My client Mr A. Sharma, the payee, received cheque no. 004821 for Rs. 5,00,000 drawn by M/s Delta Traders. " +
  "The cheque was presented on 2 March 2026 and returned unpaid on 4 March 2026 with the remark funds insufficient. You are called upon to pay within fifteen days of receipt.";

// What a model would plausibly return: mostly right, with one invented party and one invented event.
const EXTRACTION = {
  docType: "notice",
  docDate: "2026-03-14",
  parties: [
    { name: "Mr A. Sharma", role: "payee", quote: "My client Mr A. Sharma, the payee" },
    { name: "Mr Z. Invented", role: "accused", quote: "Mr Z. Invented drew the cheque" },
  ],
  events: [
    { date: "2026-03-04", what: "Cheque returned unpaid", quote: "returned unpaid on 4 March 2026" },
    { date: "2026-03-02", what: "Cheque presented", quote: "The cheque was presented on 2 March 2026" },
    { date: "2026-03-20", what: "Made-up hearing", quote: "the court heard the matter on 20 March" },
  ],
  facts: [{ text: "Cheque of Rs. 5,00,000 drawn by Delta Traders", quote: "cheque no. 004821 for Rs. 5,00,000 drawn by M/s Delta Traders" }],
  claims: [{ text: "Payment demanded within fifteen days", quote: "pay within fifteen days of receipt" }],
};

describe("building a case file from a matter's documents", () => {
  let server: Server;
  let calls = 0;
  let alice: TestUser;
  let bob: TestUser;

  before(async () => {
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        calls++;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify(EXTRACTION) }, finish_reason: "stop" }] }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    config.customLlmBaseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    alice = await createTestUser("casefile_alice");
    bob = await createTestUser("casefile_bob");
  });
  after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  async function matterWithDocument(user: TestUser, text: string | null) {
    const app = (await import("../src/index.js")).default;
    const { createMatter } = await import("../src/services/repo/index.js");
    const { createConversation } = await import("../src/services/chats/store.js");
    const { linkDocuments } = await import("../src/services/documents/index.js");
    const matter = await createMatter({ userId: user.id, title: `Casefile ${Date.now()}` });
    if (text !== null) {
      const chat = await createConversation("soli_master", "Case chat", user.id, `conv_cf_${Date.now()}_${Math.random()}`, matter.id);
      const form = new FormData();
      form.append("file", new File([text], "legal-notice.txt", { type: "text/plain" }));
      const res = await app.request("/api/vakils/soli_master/files", { method: "POST", headers: { Authorization: user.headers.Authorization }, body: form });
      assert.equal(res.status, 200);
      const fileId = (await res.json()).files[0].id as string;
      await linkDocuments(user.id, [fileId], chat.id, matter.id);
    }
    return { app, matter };
  }

  it("keeps facts whose quotes are in the document, drops invented ones, and asks the lawyer to confirm", async () => {
    const { advanceCaseFile } = await import("../src/services/casefile/index.js");
    const { listMatterEvents } = await import("../src/services/repo/index.js");
    const { matter } = await matterWithDocument(alice, NOTICE);

    const view = await advanceCaseFile(alice.id, matter.id);
    assert.equal(view.status, "ready");
    assert.equal(view.progress.total, 1);
    assert.equal(view.progress.failed, 0);

    const content = view.content!;
    assert.deepEqual(content.parties.map((p) => p.name), ["Mr A. Sharma"], "the invented party is dropped");
    assert.deepEqual(content.chronology.map((e) => e.date), ["2026-03-02", "2026-03-04"], "the invented hearing is dropped; dates are in order");
    assert.equal(content.facts.length, 1);
    assert.equal(content.claims.length, 1);
    assert.equal(content.documents[0].docType, "notice");
    assert.equal(content.documents[0].docDate, "2026-03-14");
    assert.equal(content.chronology[0].source.name, "legal-notice.txt");
    assert.equal(content.stats.dropped, 2);

    const events = await listMatterEvents(matter.id, alice.id);
    const checkpoint = events.find((e) => e.type === "checkpoint" && e.title === "Confirm the case facts");
    assert.ok(checkpoint, "a confirm-the-facts checkpoint is on the timeline");
    assert.equal(checkpoint!.status, "open");
    assert.equal(view.checkpointEventId, checkpoint!.id);

    // Asking again returns the finished case file without reading the documents again.
    const before = calls;
    const again = await advanceCaseFile(alice.id, matter.id);
    assert.equal(again.status, "ready");
    assert.equal(calls, before);
  });

  it("can be resumed: a call with no time does nothing but queue, and the next call finishes", async () => {
    const { advanceCaseFile } = await import("../src/services/casefile/index.js");
    const { matter } = await matterWithDocument(alice, NOTICE);

    const first = await advanceCaseFile(alice.id, matter.id, { budgetMs: 0 });
    assert.equal(first.status, "building");
    assert.equal(first.progress.done, 0);
    assert.equal(first.progress.total, 1);

    const second = await advanceCaseFile(alice.id, matter.id);
    assert.equal(second.status, "ready");
    assert.equal(second.progress.done, 1);
    assert.equal(second.content!.parties.length, 1);
  });

  it("says plainly when a matter has nothing to read", async () => {
    const { advanceCaseFile } = await import("../src/services/casefile/index.js");
    const { matter } = await matterWithDocument(alice, null);
    const view = await advanceCaseFile(alice.id, matter.id);
    assert.equal(view.status, "failed");
    assert.match(view.error ?? "", /no readable text/i);
  });

  it("is private to the matter's owner, through the API", async () => {
    const { app, matter } = await matterWithDocument(alice, NOTICE);

    const built = await app.request(`/api/matters/${matter.id}/case-file/build`, { method: "POST", headers: alice.headers, body: "{}" });
    assert.equal(built.status, 200);
    assert.equal((await built.json()).caseFile.status, "ready");

    const mine = await app.request(`/api/matters/${matter.id}/case-file`, { headers: alice.headers });
    assert.equal(mine.status, 200);
    assert.equal((await mine.json()).caseFile.content.parties[0].name, "Mr A. Sharma");

    const theirs = await app.request(`/api/matters/${matter.id}/case-file`, { headers: bob.headers });
    assert.equal(theirs.status, 404);
    const theirsBuild = await app.request(`/api/matters/${matter.id}/case-file/build`, { method: "POST", headers: bob.headers, body: "{}" });
    assert.equal(theirsBuild.status, 404);

    const anon = await app.request(`/api/matters/${matter.id}/case-file`);
    assert.equal(anon.status, 401);
  });
});
