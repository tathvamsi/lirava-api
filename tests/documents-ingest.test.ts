process.env.NODE_ENV = "test";

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { config } from "../src/config.js";
import { createTestUser, type TestUser } from "./helpers.js";

const FIR =
  "FIRST INFORMATION REPORT (Under Section 173 BNSS). FIR No. 214/2025, Police Station Bidar Town, dated 15 August 2025. " +
  "The complainant Lakshmi Gowda states that on the night of 14 August 2025 her son Shivakumar was assaulted near the bus stand by Ravi Shankar Naik and others, " +
  "who fled on a motorcycle. She asks that a case be registered and the accused be arrested without delay. Signed at the police station in the presence of two witnesses.";

const NOTES = "Meeting note with the client about fees and the next steps for the file, written on a Sunday afternoon in the office at the usual time with tea.";

describe("uploading documents to a case", () => {
  let server: Server;
  let alice: TestUser;
  let bob: TestUser;

  before(async () => {
    server = createServer((req, res) => {
      req.on("data", () => {});
      req.on("end", () => {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify({ docType: "other", parties: [], events: [], facts: [], claims: [] }) }, finish_reason: "stop" }] }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    config.customLlmBaseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    alice = await createTestUser("ingest_alice");
    bob = await createTestUser("ingest_bob");
  });
  after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  async function upload(user: TestUser, matterId: string, name: string, text: string) {
    const app = (await import("../src/index.js")).default;
    const { createConversation } = await import("../src/services/chats/store.js");
    const { linkDocuments } = await import("../src/services/documents/index.js");
    const chat = await createConversation("soli_master", "Case chat", user.id, `conv_ing_${Date.now()}_${Math.random()}`, matterId);
    const form = new FormData();
    form.append("file", new File([text], name, { type: "text/plain" }));
    const res = await app.request("/api/vakils/soli_master/files", { method: "POST", headers: { Authorization: user.headers.Authorization }, body: form });
    assert.equal(res.status, 200);
    const id = (await res.json()).files[0].id as string;
    await linkDocuments(user.id, [id], chat.id, matterId);
    return id;
  }

  it("tells what each document is, notices a second copy, and lets the lawyer correct the type", async () => {
    const app = (await import("../src/index.js")).default;
    const { createMatter } = await import("../src/services/repo/index.js");
    const { advanceCaseFile } = await import("../src/services/casefile/index.js");
    const matter = await createMatter({ userId: alice.id, title: `Ingest ${Date.now()}` });

    const notesId = await upload(alice, matter.id, "client-note.txt", NOTES);
    const firId = await upload(alice, matter.id, "scan001.txt", FIR);
    const copyId = await upload(alice, matter.id, "scan001 (copy).txt", FIR.toUpperCase());

    const list = await app.request(`/api/documents?matterId=${matter.id}`, { headers: alice.headers });
    assert.equal(list.status, 200);
    const body = await list.json();
    const byId = new Map<string, any>(body.documents.map((d: any) => [d.id, d]));
    assert.equal(byId.get(firId).kind, "fir");
    assert.equal(byId.get(firId).kindBy, "auto");
    assert.equal(byId.get(notesId).kind, "other");
    assert.equal(byId.get(copyId).duplicateOf, firId, "the later upload points to the original");
    assert.equal(byId.get(firId).duplicateOf, undefined, "the original is not marked");
    assert.ok(body.kinds.fir, "the list of types is sent so the app can show a picker");

    // The case file reads the FIR once and says why the copy was skipped.
    const view = await advanceCaseFile(alice.id, matter.id);
    assert.equal(view.progress.total, 2, "the note and the FIR are read; the copy is not");
    assert.ok(view.skipped.some((s) => s.name === "scan001 (copy).txt" && /same text/i.test(s.reason)));

    // The lawyer corrects a wrong guess.
    const fix = await app.request(`/api/documents/${notesId}`, { method: "PATCH", headers: { ...alice.headers, "Content-Type": "application/json" }, body: JSON.stringify({ kind: "statement_161" }) });
    assert.equal(fix.status, 200);
    const after = await (await app.request(`/api/documents?matterId=${matter.id}`, { headers: alice.headers })).json();
    const fixed = after.documents.find((d: any) => d.id === notesId);
    assert.equal(fixed.kind, "statement_161");
    assert.equal(fixed.kindBy, "user");

    const bad = await app.request(`/api/documents/${notesId}`, { method: "PATCH", headers: { ...alice.headers, "Content-Type": "application/json" }, body: JSON.stringify({ kind: "nonsense" }) });
    assert.equal(bad.status, 400);
  });

  it("does not let someone else correct a document that is not theirs", async () => {
    const app = (await import("../src/index.js")).default;
    const { createMatter } = await import("../src/services/repo/index.js");
    const matter = await createMatter({ userId: alice.id, title: `Ingest private ${Date.now()}` });
    const id = await upload(alice, matter.id, "fir.txt", FIR);
    const res = await app.request(`/api/documents/${id}`, { method: "PATCH", headers: { ...bob.headers, "Content-Type": "application/json" }, body: JSON.stringify({ kind: "order" }) });
    assert.equal(res.status, 404);
    const still = await (await app.request(`/api/documents?matterId=${matter.id}`, { headers: alice.headers })).json();
    assert.equal(still.documents[0].kind, "fir");
  });
});
