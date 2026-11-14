process.env.NODE_ENV = "test";

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { PDFDocument, StandardFonts } from "pdf-lib";
import app from "../src/index.js";
import { createTestUser, type TestUser } from "./helpers.js";
import { createConversation, deleteConversation } from "../src/services/chats/store.js";
import { createMatter } from "../src/services/repo/index.js";
import { chunkText, indexDocument, linkDocuments, listMatterDocuments, searchDocuments, searchTerms } from "../src/services/documents/index.js";
import { buildDocumentContext } from "../src/services/documents/context.js";
import { generateDocumentDocx } from "../src/services/legal/documents.js";

async function makePdf(pages: string[]): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.TimesRoman);
  for (const text of pages) {
    const page = pdf.addPage();
    if (text) page.drawText(text, { x: 50, y: 700, size: 12, font, maxWidth: 480, lineHeight: 15 });
  }
  return Buffer.from(await pdf.save());
}

function upload(user: TestUser, name: string, bytes: Buffer, type: string) {
  const form = new FormData();
  form.append("file", new File([new Uint8Array(bytes)], name, { type }));
  return { method: "POST", headers: { Authorization: user.headers.Authorization }, body: form };
}

describe("matter documents: indexing, page-level search and privacy", () => {
  let alice: TestUser;
  let bob: TestUser;
  const chats: Array<[string, string]> = [];
  const fileIds: string[] = [];

  before(async () => {
    alice = await createTestUser("docs_alice");
    bob = await createTestUser("docs_bob");
  });
  after(async () => {
    for (const [id, user] of chats) await deleteConversation(id, user).catch(() => undefined);
  });

  const newChat = async (user: TestUser, matterId?: string) => {
    const conv = await createConversation("soli_master", "Docs", user.id, `conv_docs_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, matterId);
    chats.push([conv.id, user.id]);
    return conv;
  };

  const orderPdf = () =>
    makePdf([
      "Order dated 3 October 2026. The applicant seeks regular bail under Section 483 of the BNSS and relies on parity with the co-accused.",
      "The charge sheet was filed on 18 November 2026 and names four accused. The investigating officer has recorded the statements of eleven witnesses.",
      "",
    ]);

  it("reads a PDF page by page and reports a scanned (blank) page honestly", async () => {
    const res = await app.request("/api/vakils/soli_master/files", upload(alice, "order.pdf", await orderPdf(), "application/pdf"));
    assert.equal(res.status, 200);
    const file = (await res.json()).files[0];
    fileIds.push(file.id);
    assert.equal(file.index.status, "ready");
    assert.equal(file.index.pages, 3);
    assert.ok(file.index.chunks >= 2);

    const scanned = await app.request("/api/vakils/soli_master/files", upload(alice, "scan.pdf", await makePdf(["", ""]), "application/pdf"));
    const scan = (await scanned.json()).files[0];
    assert.equal(scan.index.status, "no_text");
    assert.match(scan.index.note, /OCR/);
  });

  it("finds the right page for a question, and only in the chat the document belongs to", async () => {
    const chat = await newChat(alice);
    const upRes = await app.request("/api/vakils/soli_master/files", upload(alice, "order2.pdf", await orderPdf(), "application/pdf"));
    const file = (await upRes.json()).files[0];
    await linkDocuments(alice.id, [file.id], chat.id, null);

    const bail = await searchDocuments(alice.id, { conversationId: chat.id }, "What does the applicant argue about bail under Section 483?");
    assert.equal(bail[0].page, 1);
    assert.equal(bail[0].name, "order2.pdf");
    assert.match(bail[0].text, /Section 483/);

    const chargeSheet = await searchDocuments(alice.id, { conversationId: chat.id }, "when was the charge sheet filed and how many witnesses?");
    assert.equal(chargeSheet[0].page, 2);

    // A different chat, with no matter, cannot see it.
    const other = await newChat(alice);
    assert.equal((await searchDocuments(alice.id, { conversationId: other.id }, "bail Section 483")).length, 0);
    // Another user cannot see it, even naming the very same chat.
    assert.equal((await searchDocuments(bob.id, { conversationId: chat.id }, "bail Section 483")).length, 0);
  });

  it("makes a matter's documents searchable from every chat of that matter", async () => {
    const matter = await createMatter({ userId: alice.id, title: "Rajesh v. State" });
    const first = await newChat(alice, matter.id);
    const second = await newChat(alice, matter.id);
    const upRes = await app.request("/api/vakils/soli_master/files", upload(alice, "matter-order.pdf", await orderPdf(), "application/pdf"));
    const file = (await upRes.json()).files[0];
    await linkDocuments(alice.id, [file.id], first.id, matter.id);

    const fromSecond = await searchDocuments(alice.id, { conversationId: second.id, matterId: matter.id }, "co-accused parity");
    assert.equal(fromSecond.length > 0, true, "a later chat of the same matter finds the earlier document");
    assert.equal(fromSecond[0].name, "matter-order.pdf");

    const listed = await listMatterDocuments(alice.id, matter.id);
    assert.deepEqual(listed.map((d) => d.name), ["matter-order.pdf"]);
    assert.equal(listed[0].pages, 3);

    // The list endpoint: owner sees it, anyone else gets "not found".
    const mine = await app.request(`/api/documents?matterId=${matter.id}`, { headers: alice.headers });
    assert.equal(mine.status, 200);
    assert.equal((await mine.json()).documents.length, 1);
    assert.equal((await app.request(`/api/documents?matterId=${matter.id}`, { headers: bob.headers })).status, 404);
    assert.equal((await app.request("/api/documents", { headers: alice.headers })).status, 400);
    assert.equal((await app.request(`/api/documents?matterId=${matter.id}`)).status, 401);

    // Bob's own chat in a matter of his own never reaches Alice's documents.
    const bobMatter = await createMatter({ userId: bob.id, title: "Bob's matter" });
    const bobChat = await newChat(bob, bobMatter.id);
    assert.equal((await searchDocuments(bob.id, { conversationId: bobChat.id, matterId: matter.id }, "co-accused parity")).length, 0);
  });

  it("falls back to the opening of each document when the question shares no words with it", async () => {
    const chat = await newChat(alice);
    const upRes = await app.request("/api/vakils/soli_master/files", upload(alice, "summary.pdf", await orderPdf(), "application/pdf"));
    await linkDocuments(alice.id, [(await upRes.json()).files[0].id], chat.id, null);
    const hits = await searchDocuments(alice.id, { conversationId: chat.id }, "summarise this please");
    assert.equal(hits.length, 1);
    assert.equal(hits[0].page, 1);
  });

  it("indexes Word and text files by section", async () => {
    const docx = await generateDocumentDocx({ title: "Notice", content: "The drawer issued cheque number 004512 for Rs. 5,00,000 which was dishonoured on presentation.\n\nA demand notice followed within thirty days." });
    const word = await indexDocument({ userId: alice.id, fileId: `file_docx_${Date.now()}`, name: "notice.docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", buffer: docx });
    assert.equal(word.status, "ready");
    assert.equal(word.unit, "section");

    const text = await indexDocument({ userId: alice.id, fileId: `file_txt_${Date.now()}`, name: "notes.txt", mime: "text/plain", buffer: Buffer.from("Client called on Monday.\nHearing adjourned to December.") });
    assert.equal(text.status, "ready");

    const image = await indexDocument({ userId: alice.id, fileId: `file_img_${Date.now()}`, name: "photo.png", mime: "image/png", buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]) });
    assert.equal(image.status, "unsupported");
  });

  it("deletes a chat's own documents with the chat, but keeps a matter's documents", async () => {
    const matter = await createMatter({ userId: alice.id, title: "Keep my documents" });
    const matterChat = await newChat(alice, matter.id);
    const plainChat = await newChat(alice);
    const a = (await (await app.request("/api/vakils/soli_master/files", upload(alice, "keep.pdf", await orderPdf(), "application/pdf"))).json()).files[0];
    const b = (await (await app.request("/api/vakils/soli_master/files", upload(alice, "drop.pdf", await orderPdf(), "application/pdf"))).json()).files[0];
    await linkDocuments(alice.id, [a.id], matterChat.id, matter.id);
    await linkDocuments(alice.id, [b.id], plainChat.id, null);

    assert.equal((await app.request(`/api/conversations/${plainChat.id}`, { method: "DELETE", headers: alice.headers })).status, 200);
    assert.equal((await app.request(`/api/files/${b.id}`, { headers: alice.headers })).status, 404, "the chat's own file is gone");

    assert.equal((await app.request(`/api/conversations/${matterChat.id}`, { method: "DELETE", headers: alice.headers })).status, 200);
    assert.equal((await listMatterDocuments(alice.id, matter.id)).length, 1, "the matter still has its document");
    assert.equal((await app.request(`/api/files/${a.id}`, { headers: alice.headers })).status, 200);
  });
});

describe("document helpers", () => {
  it("chunks long text with overlap, on word boundaries, and keeps short text whole", () => {
    assert.deepEqual(chunkText("Short text."), ["Short text."]);
    const long = Array.from({ length: 400 }, (_, i) => `word${i}`).join(" ");
    const chunks = chunkText(long, 500, 80);
    assert.ok(chunks.length > 4);
    assert.ok(chunks.every((c) => c.length <= 500));
    assert.ok(chunks.every((c) => c.trim().length > 0), "no empty chunks");
    // Overlap: each chunk starts with words the previous one ended with.
    const lastWord = chunks[0].split(" ").pop()!;
    assert.ok(chunks[1].includes(lastWord));
  });

  it("keeps legal numbers and drops filler words in a search", () => {
    assert.deepEqual(searchTerms("What is the effect of Section 483 on the bail?"), ["effect", "section", "483", "bail"]);
    assert.deepEqual(searchTerms("is it in the"), []);
  });

  it("labels each passage and shows the user exactly the passages the model was given", () => {
    const hits = [
      { documentId: "f1", name: "order.pdf", page: 3, unit: "page" as const, text: "Bail under Section 483.", rank: 1 },
      { documentId: "f2", name: "notes.txt", page: 1, unit: "section" as const, text: "Hearing adjourned.", rank: 0.5 },
    ];
    const { text, citations } = buildDocumentContext(hits);
    assert.match(text, /\[D1\] order\.pdf, page 3/);
    assert.match(text, /\[D2\] notes\.txt, section 1/);
    assert.match(text, /Do not cite a label that is not listed/);
    assert.deepEqual(citations.map((c) => (c.kind === "document" ? [c.label, c.name, c.page] : null)), [["D1", "order.pdf", 3], ["D2", "notes.txt", 1]]);
    assert.deepEqual(buildDocumentContext([]), { text: "", citations: [] });
  });

  it("stays inside the character budget", () => {
    const big = { documentId: "f", name: "big.pdf", page: 1, unit: "page" as const, text: "x".repeat(5000), rank: 1 };
    const { text } = buildDocumentContext([big, { ...big, page: 2 }, { ...big, page: 3 }], 1500);
    assert.ok(text.length < 2600, `prompt block was ${text.length} characters`);
  });
});
