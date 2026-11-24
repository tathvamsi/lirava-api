process.env.NODE_ENV = "test";

import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { config } from "../src/config.js";
import { createTestUser, type TestUser } from "./helpers.js";
import { markdownSections, wantsMarkitdown } from "../src/services/documents/markitdown.js";
import { indexDocument } from "../src/services/documents/index.js";
import { generateDocumentDocx } from "../src/services/legal/documents.js";
import { getSql } from "../src/services/db/postgres.js";

// These tests are about conversion, not scans: a developer's .env may switch OCR on, so it is off here.
config.ocrBaseUrl = "";

const KEY = "test-markitdown-key-0123456789abcdef";
const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const TABLE_MD = [
  "# Particulars of the cheque",
  "",
  "| Item | Date | Amount |",
  "| --- | --- | --- |",
  "| Cheque presented | 2 March 2026 | Rs. 5,00,000 |",
  "| Returned unpaid | 4 March 2026 | Rs. 5,00,000 |",
  "",
  "## Demand",
  "",
  "You are called upon to pay within fifteen days of receipt of this notice.",
].join("\n");

describe("splitting converted Markdown into sections", () => {
  it("keeps a heading with the text under it and a table in one piece", () => {
    const sections = markdownSections(TABLE_MD, 1400, 100);
    const joined = sections.join("\n\n");
    assert.ok(joined.includes("| Cheque presented | 2 March 2026 | Rs. 5,00,000 |"));
    const withTable = sections.find((s) => s.includes("| Item | Date | Amount |"))!;
    assert.ok(withTable.includes("| Returned unpaid |"), "no row of the table was cut away from its table");
    assert.ok(withTable.startsWith("# Particulars of the cheque"), "the heading stays with its table");
  });

  it("joins tiny blocks so a short paragraph is not a section of its own", () => {
    const sections = markdownSections("# A\n\nOne.\n\n# B\n\nTwo.\n\n# C\n\nThree.", 3000, 900);
    assert.equal(sections.length, 1);
  });

  it("cuts a long table by rows and repeats the header, losing no row", () => {
    const rows = Array.from({ length: 80 }, (_, i) => `| Item ${i} | 2026-03-${String((i % 28) + 1).padStart(2, "0")} | Rs. ${i}00 |`);
    const md = ["| Item | Date | Amount |", "| --- | --- | --- |", ...rows].join("\n");
    const sections = markdownSections(md, 600, 300);
    assert.ok(sections.length > 1);
    for (const s of sections) {
      assert.ok(s.startsWith("| Item | Date | Amount |\n| --- | --- | --- |"), "every piece starts with the header");
      assert.ok(s.length <= 700);
    }
    const all = sections.join("\n");
    for (let i = 0; i < 80; i++) assert.ok(all.includes(`| Item ${i} |`), `row ${i} is still there`);
  });

  it("does not lose any words from ordinary text", () => {
    const text = Array.from({ length: 120 }, (_, i) => `Paragraph ${i} of a long judgment, with several words in it.`).join("\n\n");
    const words = (s: string) => s.split(/\s+/).filter(Boolean).join(" ");
    assert.equal(words(markdownSections(text, 800, 400).join("\n\n")), words(text));
  });
});

describe("converting documents with the MarkItDown service", () => {
  let server: Server;
  let alice: TestUser;
  let calls: Array<{ auth: string | undefined; filename: string; bytes: number }> = [];
  let reply: { status: number; body: unknown } = { status: 200, body: {} };

  before(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        calls.push({ auth: req.headers.authorization, filename: decodeURIComponent(String(req.headers["x-filename"] ?? "")), bytes: Buffer.concat(chunks).length });
        res.statusCode = reply.status;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(reply.body));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    alice = await createTestUser("markitdown_alice");
  });
  after(async () => {
    config.markitdownBaseUrl = "";
    config.markitdownApiKey = "";
    await new Promise((resolve) => server.close(resolve));
  });
  beforeEach(() => {
    calls = [];
    config.markitdownBaseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    config.markitdownApiKey = KEY;
    reply = { status: 200, body: { markdown: TABLE_MD, warnings: [] } };
  });

  const index = (name: string, mime: string, bytes: Buffer) => indexDocument({ userId: alice.id, fileId: `file_md_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, name, mime, buffer: bytes });

  it("is used for Word, PowerPoint, Excel and HTML, and never for PDFs or images", () => {
    for (const n of ["a.docx", "A.PPTX", "b.xlsx", "c.html", "d.csv", "e.epub", "f.json", "g.xml"]) assert.equal(wantsMarkitdown(n), true, n);
    for (const n of ["a.pdf", "scan.png", "photo.jpg", "voice.mp3", "notes.txt"]) assert.equal(wantsMarkitdown(n), false, n);
    config.markitdownBaseUrl = "";
    assert.equal(wantsMarkitdown("a.docx"), false, "off when no service is set");
  });

  it("reads a PowerPoint through the service and keeps the table's line breaks", async () => {
    const result = await index("hearing-slides.pptx", PPTX_MIME, Buffer.from("PK-fake-pptx-bytes"));
    assert.equal(result.status, "ready");
    assert.equal(result.converter, "markitdown");
    assert.equal(result.unit, "section");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].auth, `Bearer ${KEY}`, "the service key is sent");
    assert.equal(calls[0].filename, "hearing-slides.pptx");
    assert.ok(calls[0].bytes > 0, "the file itself is sent");

    const sql = getSql()!;
    const rows = await sql`SELECT text FROM document_chunks WHERE user_id = ${alice.id} ORDER BY id DESC LIMIT 1`;
    assert.ok(String(rows[0].text).includes("\n| Cheque presented | 2 March 2026 | Rs. 5,00,000 |\n"), "the table is stored as a table, not flattened");
    const doc = await sql`SELECT converted_by FROM matter_documents WHERE user_id = ${alice.id} ORDER BY created_at DESC LIMIT 1`;
    assert.equal(doc[0].converted_by, "markitdown");
  });

  it("reads a Word file through the service when it is up", async () => {
    const docx = await generateDocumentDocx({ title: "Notice", content: "The drawer issued cheque number 004512 for Rs. 5,00,000." });
    const result = await index("notice.docx", DOCX_MIME, docx);
    assert.equal(result.converter, "markitdown");
    assert.equal(calls.length, 1);
  });

  it("falls back to the built-in Word reader when the service is down or refuses", async () => {
    const docx = await generateDocumentDocx({ title: "Notice", content: "The drawer issued cheque number 004512 for Rs. 5,00,000 which was dishonoured." });
    reply = { status: 500, body: { error: "boom" } };
    const down = await index("notice-down.docx", DOCX_MIME, docx);
    assert.equal(down.status, "ready", "the upload still works");
    assert.equal(down.converter, "builtin");
    reply = { status: 401, body: { error: "Unauthorised" } };
    assert.equal((await index("notice-denied.docx", DOCX_MIME, docx)).converter, "builtin");
    reply = { status: 200, body: { markdown: "   ", warnings: [] } };
    assert.equal((await index("notice-empty.docx", DOCX_MIME, docx)).converter, "builtin", "an empty conversion is not trusted");
  });

  it("reports a PowerPoint as unsupported when the service is down, as before", async () => {
    reply = { status: 503, body: { error: "busy" } };
    const result = await index("slides-down.pptx", PPTX_MIME, Buffer.from("PK-fake"));
    assert.equal(result.status, "unsupported");
    assert.equal(result.converter, undefined);
  });

  it("is switched off cleanly when no service is configured", async () => {
    config.markitdownBaseUrl = "";
    const docx = await generateDocumentDocx({ title: "Notice", content: "The drawer issued cheque number 004512 for Rs. 5,00,000." });
    assert.equal((await index("off.docx", DOCX_MIME, docx)).converter, "builtin");
    assert.equal((await index("off.pptx", PPTX_MIME, Buffer.from("PK-fake"))).status, "unsupported");
    assert.equal(calls.length, 0, "nothing was sent anywhere");
  });
});
