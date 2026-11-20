process.env.NODE_ENV = "test";

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { PDFDocument, StandardFonts } from "pdf-lib";
import app from "../src/index.js";
import { createTestUser, type TestUser } from "./helpers.js";
import { createConversation, deleteConversation } from "../src/services/chats/store.js";
import { createMatter } from "../src/services/repo/index.js";
import { searchDocuments } from "../src/services/documents/index.js";
import { linkedKnowledgeIds } from "../src/services/knowledge-bases/index.js";
import { memoryPromptSection } from "../src/services/memories/index.js";
import { config } from "../src/config.js";

// These tests read text PDFs, not scans. A developer's .env may switch OCR on, so it is off here.
config.ocrBaseUrl = "";

async function makePdf(pages: string[]): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.TimesRoman);
  for (const text of pages) pdf.addPage().drawText(text, { x: 50, y: 700, size: 12, font, maxWidth: 480, lineHeight: 15 });
  return Buffer.from(await pdf.save());
}

const json = (user: TestUser, method: string, body?: unknown) => ({ method, headers: user.headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

function upload(user: TestUser, name: string, bytes: Buffer) {
  const form = new FormData();
  form.append("file", new File([new Uint8Array(bytes)], name, { type: "application/pdf" }));
  return { method: "POST", headers: { Authorization: user.headers.Authorization }, body: form };
}

describe("memories over HTTP", () => {
  let alice: TestUser;
  let bob: TestUser;
  before(async () => {
    alice = await createTestUser("mem_alice");
    bob = await createTestUser("mem_bob");
  });

  it("adds, lists, edits and deletes a memory, privately to its owner", async () => {
    const created = await app.request("/api/memories", json(alice, "POST", { content: "  I appear   before the Karnataka High Court " }));
    assert.equal(created.status, 201);
    const memory = (await created.json()).memory;
    assert.equal(memory.content, "I appear before the Karnataka High Court");

    assert.equal((await app.request("/api/memories", json(alice, "POST", { content: "   " }))).status, 400);

    const listed = (await (await app.request("/api/memories", json(alice, "GET"))).json()).memories;
    assert.deepEqual(listed.map((m: { id: string }) => m.id), [memory.id]);
    assert.equal((await (await app.request("/api/memories", json(bob, "GET"))).json()).memories.length, 0);

    // Another user's memory looks like one that does not exist.
    assert.equal((await app.request(`/api/memories/${memory.id}`, json(bob, "PUT", { content: "hijacked" }))).status, 404);
    assert.equal((await app.request(`/api/memories/${memory.id}`, json(bob, "DELETE"))).status, 404);

    const edited = await app.request(`/api/memories/${memory.id}`, json(alice, "PUT", { content: "I prefer short paragraphs" }));
    assert.equal((await edited.json()).memory.content, "I prefer short paragraphs");

    assert.equal((await app.request(`/api/memories/${memory.id}`, json(alice, "DELETE"))).status, 200);
    assert.equal((await (await app.request("/api/memories", json(alice, "GET"))).json()).memories.length, 0);
  });

  it("gives the assistant the notes, and nothing once memory is switched off", async () => {
    await app.request("/api/memories", json(alice, "POST", { content: "Practises criminal law in Bengaluru" }));
    assert.match(await memoryPromptSection(alice.id), /Practises criminal law in Bengaluru/);
    assert.equal(await memoryPromptSection(bob.id), "");

    assert.equal((await app.request("/api/preferences/memoryEnabled", json(alice, "PUT", { value: false }))).status, 200);
    assert.equal(await memoryPromptSection(alice.id), "");
    assert.equal((await app.request("/api/preferences/memoryEnabled", json(alice, "PUT", { value: "off" }))).status, 400);

    await app.request("/api/preferences/memoryEnabled", json(alice, "PUT", { value: true }));
    assert.match(await memoryPromptSection(alice.id), /criminal law/);

    const cleared = await (await app.request("/api/memories", json(alice, "DELETE"))).json();
    assert.equal(cleared.removed, 1);
    assert.equal(await memoryPromptSection(alice.id), "");
  });
});

describe("knowledge bases: upload, attach, search and privacy", () => {
  let alice: TestUser;
  let bob: TestUser;
  const chats: Array<[string, string]> = [];
  const bases: Array<[string, TestUser]> = [];

  before(async () => {
    alice = await createTestUser("kb_alice");
    bob = await createTestUser("kb_bob");
  });
  after(async () => {
    for (const [id, user] of chats) await deleteConversation(id, user).catch(() => undefined);
    for (const [id, user] of bases) await app.request(`/api/knowledge-bases/${id}`, json(user, "DELETE")).catch(() => undefined);
  });

  const newChat = async (user: TestUser, matterId?: string) => {
    const conv = await createConversation("soli_master", "KB", user.id, `conv_kb_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, matterId);
    chats.push([conv.id, user.id]);
    return conv;
  };
  const newBase = async (user: TestUser, name = "My bail precedents") => {
    const res = await app.request("/api/knowledge-bases", json(user, "POST", { name, description: "Orders I rely on" }));
    assert.equal(res.status, 201);
    const base = (await res.json()).knowledgeBase;
    bases.push([base.id, user]);
    return base as { id: string; name: string; fileCount: number };
  };
  const precedent = () =>
    makePdf(["Held: regular bail under Section 483 of the BNSS may be granted where the charge sheet is filed and custody is no longer needed for investigation."]);

  it("needs a name, and keeps bases private to their owner", async () => {
    assert.equal((await app.request("/api/knowledge-bases", json(alice, "POST", { name: "   " }))).status, 400);
    const base = await newBase(alice);
    assert.equal(base.fileCount, 0);

    assert.equal((await (await app.request("/api/knowledge-bases", json(bob, "GET"))).json()).knowledgeBases.length, 0);
    assert.equal((await app.request(`/api/knowledge-bases/${base.id}`, json(bob, "GET"))).status, 404);
    assert.equal((await app.request(`/api/knowledge-bases/${base.id}`, json(bob, "PUT", { name: "mine now" }))).status, 404);
    assert.equal((await app.request(`/api/knowledge-bases/${base.id}`, json(bob, "DELETE"))).status, 404);
    assert.equal((await app.request(`/api/knowledge-bases/${base.id}/files`, upload(bob, "x.pdf", await precedent()))).status, 404);

    const renamed = await app.request(`/api/knowledge-bases/${base.id}`, json(alice, "PUT", { name: "Bail orders" }));
    assert.equal((await renamed.json()).knowledgeBase.name, "Bail orders");
  });

  it("indexes an uploaded file, and searches it only in a chat the base is attached to", async () => {
    const base = await newBase(alice);
    const up = await app.request(`/api/knowledge-bases/${base.id}/files`, upload(alice, "precedent.pdf", await precedent()));
    assert.equal(up.status, 200);
    const file = (await up.json()).files[0];
    assert.equal(file.index.status, "ready");

    const detail = (await (await app.request(`/api/knowledge-bases/${base.id}`, json(alice, "GET"))).json()).knowledgeBase;
    assert.equal(detail.fileCount, 1);
    assert.equal(detail.files[0].name, "precedent.pdf");

    const chat = await newChat(alice);
    const question = "when can regular bail under Section 483 be granted?";

    // Not attached yet: the chat cannot see the base's file.
    assert.deepEqual(await linkedKnowledgeIds(alice.id, chat.id, null), []);
    assert.equal((await searchDocuments(alice.id, { conversationId: chat.id }, question)).length, 0);

    const attach = await app.request("/api/knowledge-bases/links", json(alice, "PUT", { scope: "conversation", id: chat.id, knowledgeIds: [base.id] }));
    assert.equal(attach.status, 200);
    assert.equal((await attach.json()).knowledgeBases[0].id, base.id);

    const ids = await linkedKnowledgeIds(alice.id, chat.id, null);
    assert.deepEqual(ids, [base.id]);
    const hits = await searchDocuments(alice.id, { conversationId: chat.id, knowledgeIds: ids }, question);
    assert.equal(hits[0].name, "precedent.pdf");
    assert.match(hits[0].text, /Section 483/);

    // A different chat is unaffected, and so is another user's search.
    const other = await newChat(alice);
    assert.deepEqual(await linkedKnowledgeIds(alice.id, other.id, null), []);
    assert.equal((await searchDocuments(bob.id, { conversationId: chat.id, knowledgeIds: ids }, question)).length, 0);

    // Detached again: nothing is found.
    await app.request("/api/knowledge-bases/links", json(alice, "PUT", { scope: "conversation", id: chat.id, knowledgeIds: [] }));
    assert.deepEqual(await linkedKnowledgeIds(alice.id, chat.id, null), []);
  });

  it("attached to a matter, a base reaches every chat of that matter", async () => {
    const base = await newBase(alice, "Matter research");
    await app.request(`/api/knowledge-bases/${base.id}/files`, upload(alice, "p.pdf", await precedent()));
    const matter = await createMatter({ userId: alice.id, title: "Rajesh v. State" });
    const first = await newChat(alice, matter.id);
    const second = await newChat(alice, matter.id);

    const res = await app.request("/api/knowledge-bases/links", json(alice, "PUT", { scope: "matter", id: matter.id, knowledgeIds: [base.id] }));
    assert.equal(res.status, 200);
    for (const chat of [first, second]) {
      assert.deepEqual(await linkedKnowledgeIds(alice.id, chat.id, matter.id), [base.id]);
    }
  });

  it("refuses to attach someone else's base, or to a chat that is not yours", async () => {
    const aliceBase = await newBase(alice, "Private");
    const bobChat = await newChat(bob);
    const aliceChat = await newChat(alice);

    const stolen = await app.request("/api/knowledge-bases/links", json(bob, "PUT", { scope: "conversation", id: bobChat.id, knowledgeIds: [aliceBase.id] }));
    assert.equal(stolen.status, 404);
    const foreignChat = await app.request("/api/knowledge-bases/links", json(bob, "PUT", { scope: "conversation", id: aliceChat.id, knowledgeIds: [] }));
    assert.equal(foreignChat.status, 404);
    assert.equal((await app.request(`/api/knowledge-bases/links?scope=conversation&id=${aliceChat.id}`, json(bob, "GET"))).status, 404);
    assert.equal((await app.request("/api/knowledge-bases/links", json(alice, "PUT", { scope: "conversation", id: aliceChat.id, knowledgeIds: "all" }))).status, 404);
    assert.equal((await app.request("/api/knowledge-bases/links", json(alice, "PUT", { scope: "nope", id: aliceChat.id, knowledgeIds: [] }))).status, 400);
  });

  it("removes a file from a base, and deleting a base deletes its files and attachments", async () => {
    const base = await newBase(alice, "To delete");
    const up = await app.request(`/api/knowledge-bases/${base.id}/files`, upload(alice, "a.pdf", await precedent()));
    const fileId = (await up.json()).files[0].id;
    await app.request(`/api/knowledge-bases/${base.id}/files`, upload(alice, "b.pdf", await precedent()));

    assert.equal((await app.request(`/api/knowledge-bases/${base.id}/files/${fileId}`, json(bob, "DELETE"))).status, 404);
    assert.equal((await app.request(`/api/knowledge-bases/${base.id}/files/${fileId}`, json(alice, "DELETE"))).status, 200);
    assert.equal((await app.request(`/api/files/${fileId}`, json(alice, "GET"))).status, 404);
    assert.equal((await (await app.request(`/api/knowledge-bases/${base.id}`, json(alice, "GET"))).json()).knowledgeBase.fileCount, 1);

    const chat = await newChat(alice);
    await app.request("/api/knowledge-bases/links", json(alice, "PUT", { scope: "conversation", id: chat.id, knowledgeIds: [base.id] }));
    assert.equal((await app.request(`/api/knowledge-bases/${base.id}`, json(alice, "DELETE"))).status, 200);
    assert.equal((await app.request(`/api/knowledge-bases/${base.id}`, json(alice, "GET"))).status, 404);
    assert.deepEqual(await linkedKnowledgeIds(alice.id, chat.id, null), []);
  });

  it("limits how many bases can be attached at once", async () => {
    const chat = await newChat(alice);
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) ids.push((await newBase(alice, `Base ${i}`)).id);
    const res = await app.request("/api/knowledge-bases/links", json(alice, "PUT", { scope: "conversation", id: chat.id, knowledgeIds: ids }));
    assert.equal(res.status, 400);
  });
});
