process.env.NODE_ENV = "test";

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import app from "../src/index.js";
import { createTestAdmin, createTestUser, type TestUser } from "./helpers.js";
import { getSql } from "../src/services/db/postgres.js";
import { searchProvisions, seedBuiltInProvisions, splitIntoSections } from "../src/services/legal/provisions.js";
import { retrieveLegalContext } from "../src/services/legal/rag.js";

const RUN = Date.now();
const ACT = `Quillwort Procedure Act ${RUN}`;

// Laid out like an Indian Act: chapters, numbered sections with headings, sub-clauses, a lettered insertion.
const ACT_TEXT = `THE QUILLWORT PROCEDURE ACT
CHAPTER I
PRELIMINARY
1. Short title and commencement.—(1) This Act may be called the Quillwort Procedure Act.
(2) It shall come into force on such date as the Government may notify.
2. Definitions.—In this Act, unless the context otherwise requires,—
1. "bailable offence" means an offence shown as bailable in the First Schedule;
2. "court" means a court of competent jurisdiction.
CHAPTER II
RELEASE OF ACCUSED
3. Grant of zyxbail in bailable offences.—When any person other than a person accused of a non-bailable offence is arrested without warrant, he shall be released on zyxbail.
3A. Zyxbail pending appeal.—A court may release a convicted person on zyxbail pending the hearing of an appeal.
4. Cancellation of zyxbail.—A court which has released a person on zyxbail may direct that he be arrested and committed to custody.
17
5. Savings.—Nothing in this Act affects any other law for the time being in force.`;

describe("splitting an Act into sections", () => {
  it("finds each numbered section with its heading, ignores chapters and numbered sub-lists", () => {
    const sections = splitIntoSections(ACT_TEXT);
    assert.deepEqual(sections.map((s) => s.section), ["1", "2", "3", "3A", "4", "5"]);
    assert.equal(sections[0].title, "Short title and commencement");
    assert.equal(sections[2].title, "Grant of zyxbail in bailable offences");
    assert.match(sections[1].text, /"court" means a court of competent jurisdiction/, "sub-clauses stay inside their section");
    assert.doesNotMatch(sections[4].text, /CHAPTER|^\s*17\s*$/, "page numbers and chapter headings are dropped");
    assert.match(sections[3].text, /pending the hearing of an appeal/);
  });

  it("returns nothing for text that is not an Act", () => {
    assert.deepEqual(splitIntoSections("Dear Sir,\nPlease find enclosed the documents.\nRegards"), []);
  });
});

describe("loading an Act through the admin console", () => {
  let admin: TestUser;
  let user: TestUser;
  let documentId = "";

  before(async () => {
    admin = await createTestAdmin("prov_admin");
    user = await createTestUser("prov_user");
  });
  after(async () => {
    const sql = getSql();
    if (sql) await sql`DELETE FROM legal_provisions WHERE act = ${ACT} OR id LIKE ${`builtin-test-${RUN}%`}`;
  });

  const send = (who: TestUser, fields: Record<string, string>, file: { name: string; body: string | Uint8Array; type: string }) => {
    const form = new FormData();
    form.append("file", new File([file.body as BlobPart], file.name, { type: file.type }));
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    return app.request("/api/admin/documents", { method: "POST", headers: { Authorization: who.headers.Authorization }, body: form });
  };

  it("is for administrators, and needs the Act's name", async () => {
    assert.equal((await send(user, { act: ACT }, { name: "act.txt", body: ACT_TEXT, type: "text/plain" })).status, 403);
    assert.equal((await send(admin, {}, { name: "act.txt", body: ACT_TEXT, type: "text/plain" })).status, 400);
  });

  it("reads the Act, stores each section, and reports ready only when it really is", async () => {
    const res = await send(admin, { act: ACT, year: "2023", source: "Test copy" }, { name: "act.txt", body: ACT_TEXT, type: "text/plain" });
    assert.equal(res.status, 200);
    const doc = (await res.json()).document;
    documentId = doc.id;
    assert.equal(doc.status, "ready");
    assert.equal(doc.chunk_count, 6, "one provision per section");
    assert.equal(doc.job_stage, "COMPLETED");
  });

  it("makes the sections searchable at once, without any embedding server", async () => {
    const hits = await searchProvisions("when can a court cancel zyxbail?");
    const hit = hits.find((h) => h.act === ACT);
    assert.ok(hit, "the loaded Act is found");
    assert.equal(hit.section, "Section 4");
    assert.equal(hit.source, "Test copy");
    assert.equal(hit.year, 2023);
  });

  it("feeds the answer's context and citations from the loaded Act", async () => {
    const context = await retrieveLegalContext("zyxbail pending appeal");
    assert.ok(context);
    assert.match(context.contextText, new RegExp(ACT));
    assert.match(context.contextText, /verify against the official text/i, "the source is described honestly");
    assert.doesNotMatch(context.contextText, /VERBATIM/);
    assert.ok(context.sources.some((s) => s.act === ACT && s.section === "Section 3A"));
  });

  it("is honest when a file cannot be used", async () => {
    const letter = await (await send(admin, { act: `${ACT} letter` }, { name: "letter.txt", body: "Dear Sir, please find the enclosed documents. Regards, Counsel. ".repeat(3), type: "text/plain" })).json();
    assert.equal(letter.document.status, "failed");
    assert.equal(letter.document.job_stage, "NO_SECTIONS");
    assert.match(letter.document.error_message, /numbered sections/);
    await app.request(`/api/admin/documents/${letter.document.id}`, { method: "DELETE", headers: admin.headers });

    const image = await (await send(admin, { act: `${ACT} image` }, { name: "scan.txt", body: "  ", type: "text/plain" })).json();
    assert.equal(image.document.status, "failed");
    assert.equal(image.document.requires_ocr, 1);
    await app.request(`/api/admin/documents/${image.document.id}`, { method: "DELETE", headers: admin.headers });
  });

  it("removes an Act's provisions when its document is deleted", async () => {
    const del = await app.request(`/api/admin/documents/${documentId}`, { method: "DELETE", headers: admin.headers });
    assert.equal(del.status, 200);
    assert.equal((await searchProvisions("zyxbail")).filter((h) => h.act === ACT).length, 0);
  });

  it("stores the built-in starter provisions once and never overwrites an edited one", async () => {
    const item = { id: `test-${RUN}`, act: ACT, section: "Section 9", title: "Starter", statutoryText: "Starter text about quillwort.", source: "Built in", category: "test" };
    assert.equal(await seedBuiltInProvisions([item]), 1);
    assert.equal(await seedBuiltInProvisions([{ ...item, statutoryText: "Changed later" }]), 0);
    const [hit] = (await searchProvisions("quillwort starter")).filter((h) => h.id === `builtin-test-${RUN}`);
    assert.match(hit.text, /Starter text about quillwort/);
  });
});
