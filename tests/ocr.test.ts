process.env.NODE_ENV = "test";

import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { config } from "../src/config.js";
import { createTestUser, type TestUser } from "./helpers.js";

const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

async function blankPdf(pages: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage();
  return Buffer.from(await doc.save());
}

async function textPdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage().drawText("This is a typed legal notice with a real text layer under Section 138 of the NI Act.", { x: 40, y: 700, size: 11, font });
  return Buffer.from(await doc.save());
}

describe("reading scanned documents with OCR", () => {
  let server: Server;
  let alice: TestUser;
  let calls: Array<{ auth: string | undefined; query: string; bytes: number }> = [];
  let reply: { status: number; body: unknown } = { status: 200, body: {} };

  before(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        calls.push({ auth: req.headers.authorization, query: req.url ?? "", bytes: Buffer.concat(chunks).length });
        res.statusCode = reply.status;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(reply.body));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    alice = await createTestUser("ocr_alice");
  });
  after(async () => {
    config.ocrBaseUrl = "";
    config.ocrApiKey = "";
    await new Promise((resolve) => server.close(resolve));
  });
  beforeEach(() => {
    calls = [];
    config.ocrBaseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    config.ocrApiKey = "test-ocr-key-0123456789abcdef";
    config.ocrLang = "auto";
    reply = { status: 200, body: {} };
  });

  async function upload(name: string, data: Buffer, type: string) {
    const app = (await import("../src/index.js")).default;
    const form = new FormData();
    form.append("file", new File([new Uint8Array(data)], name, { type }));
    const res = await app.request("/api/vakils/soli_master/files", { method: "POST", headers: { Authorization: alice.headers.Authorization }, body: form });
    assert.equal(res.status, 200);
    return (await res.json()).files[0].index as { status: string; pages: number; chunks: number; note?: string };
  }

  it("reads a scanned PDF, keeps the text per page and tells the lawyer it came from a scan", async () => {
    reply.body = {
      pages: [
        { page: 1, text: "LEGAL NOTICE dated 14 March 2026. Cheque no. 004821 for Rs. 5,00,000 returned unpaid.", confidence: 92 },
        { page: 2, text: "You are called upon to pay within fifteen days of receipt of this notice.", confidence: 88 },
      ],
      truncated: false,
      lang: "eng+hin+mar",
    };
    const index = await upload("scanned-notice.pdf", await blankPdf(2), "application/pdf");
    assert.equal(index.status, "ready");
    assert.equal(index.pages, 2);
    assert.ok(index.chunks >= 2);
    assert.match(index.note ?? "", /scan.*OCR.*2 pages.*90%/i);
    assert.match(index.note ?? "", /check names, dates and amounts/i);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].auth, "Bearer test-ocr-key-0123456789abcdef", "the service key is sent");
    assert.match(calls[0].query, /lang=auto/);
    assert.ok(calls[0].bytes > 100, "the file itself is sent");
  });

  it("leaves out a page that is too unclear to trust, and says so", async () => {
    reply.body = {
      pages: [
        { page: 1, text: "A clear page about the cheque that was dishonoured on presentation.", confidence: 90 },
        { page: 2, text: "xx ;; ~~ ii jj noise noise noise noise noise", confidence: 20 },
      ],
      truncated: false,
      lang: "eng+hin+mar",
    };
    const index = await upload("blurry.pdf", await blankPdf(2), "application/pdf");
    assert.equal(index.status, "ready");
    assert.match(index.note ?? "", /1 page was too unclear/i);
    assert.match(index.note ?? "", /1 page,/i);
  });

  it("reads a photo of a document", async () => {
    reply.body = { pages: [{ page: 1, text: "LEGAL NOTICE dated 14 March 2026 under Section 138 of the Negotiable Instruments Act.", confidence: 94 }], truncated: false, lang: "eng+hin+mar" };
    const index = await upload("photo.png", PNG_HEADER, "image/png");
    assert.equal(index.status, "ready");
    assert.equal(index.pages, 1);
    assert.match(index.note ?? "", /OCR/);
  });

  it("warns when only the first pages of a long scan were read", async () => {
    reply.body = { pages: [{ page: 1, text: "First page of a long judgment with enough readable words in it.", confidence: 85 }], truncated: true, lang: "eng+hin+mar" };
    const index = await upload("long.pdf", await blankPdf(2), "application/pdf");
    assert.match(index.note ?? "", /first 40 pages/i);
  });

  it("falls back to 'no readable text' when the OCR service is down or refuses", async () => {
    reply = { status: 500, body: { error: "boom" } };
    const index = await upload("down.pdf", await blankPdf(2), "application/pdf");
    assert.equal(index.status, "no_text");
    assert.match(index.note ?? "", /scanned document needs OCR/i);
    reply = { status: 401, body: { error: "Unauthorised" } };
    assert.equal((await upload("denied.pdf", await blankPdf(2), "application/pdf")).status, "no_text");
  });

  it("is switched off cleanly when no OCR service is configured", async () => {
    config.ocrBaseUrl = "";
    assert.equal((await upload("off.pdf", await blankPdf(2), "application/pdf")).status, "no_text");
    assert.equal((await upload("off.png", PNG_HEADER, "image/png")).status, "unsupported", "photos are stored but not searchable, as before");
    assert.equal(calls.length, 0);
  });

  it("does not send a normal typed PDF to OCR", async () => {
    const index = await upload("typed.pdf", await textPdf(), "application/pdf");
    assert.equal(index.status, "ready");
    assert.equal(index.note, undefined);
    assert.equal(calls.length, 0);
  });
});
