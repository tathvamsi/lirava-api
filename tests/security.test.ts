process.env.NODE_ENV = "test";

import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { PDFDocument } from "pdf-lib";
import app from "../src/index.js";
import { config } from "../src/config.js";
import { corsOrigin } from "../src/middleware/security.js";
import { AuthError, loginUser, registerUser } from "../src/services/auth/index.js";
import { createTestAdmin, createTestUser, type TestUser } from "./helpers.js";

const post = (user: TestUser, body: unknown) => ({ method: "POST", headers: user.headers, body: JSON.stringify(body) });

function upload(user: TestUser, name: string, bytes: Uint8Array | string, type = "application/octet-stream") {
  const form = new FormData();
  form.append("file", new File([bytes as BlobPart], name, { type }));
  return { method: "POST", headers: { Authorization: user.headers.Authorization }, body: form };
}

const PDF_BYTES = new TextEncoder().encode("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF");

describe("access control on every route", () => {
  let alice: TestUser;
  let bob: TestUser;
  let admin: TestUser;

  before(async () => {
    alice = await createTestUser("sec_alice");
    bob = await createTestUser("sec_bob");
    admin = await createTestAdmin("sec_admin");
  });

  it("requires sign-in for matters, artifacts, files, agents, legal tools and the admin console", async () => {
    for (const [method, path] of [
      ["GET", "/api/matters"],
      ["POST", "/api/matters"],
      ["GET", "/api/artifacts"],
      ["POST", "/api/artifacts"],
      ["GET", "/api/artifacts/x"],
      ["GET", "/api/artifacts/x/export"],
      ["GET", "/api/files/x"],
      ["GET", "/api/vakils"],
      ["POST", "/api/vakils"],
      ["POST", "/api/vakils/soli_master/files"],
      ["GET", "/api/legal/search?q=bail"],
      ["POST", "/api/legal/answer"],
      ["POST", "/api/legal/generate-pdf"],
      ["GET", "/api/admin/overview"],
      ["GET", "/api/admin/api-keys"],
      ["POST", "/api/admin/documents"],
    ]) {
      const res = await app.request(path, { method, headers: { "Content-Type": "application/json" }, body: method === "POST" ? "{}" : undefined });
      assert.equal(res.status, 401, `${method} ${path} should require sign-in`);
    }
  });

  it("keeps the admin console and corpus tools for administrators only", async () => {
    for (const [method, path] of [
      ["GET", "/api/admin/models"],
      ["GET", "/api/admin/api-keys"],
      ["GET", "/api/admin/audit-logs"],
      ["POST", "/api/legal/seed"],
      ["GET", "/api/legal/rag-context?q=bail"],
    ]) {
      const res = await app.request(path, { method, headers: alice.headers });
      assert.equal(res.status, 403, `${method} ${path} must be admin-only`);
    }
    assert.equal((await app.request("/api/admin/models", { headers: admin.headers })).status, 200);
  });

  it("rejects an organisation id that would write outside the document vault", async () => {
    const form = new FormData();
    form.append("file", new File([PDF_BYTES], "x.pdf", { type: "application/pdf" }));
    form.append("orgId", "../../escape");
    const res = await app.request("/api/admin/documents", { method: "POST", headers: { Authorization: admin.headers.Authorization }, body: form });
    assert.equal(res.status, 400);
    assert.equal((await app.request("/api/admin/documents?orgId=..%2Fx", { headers: admin.headers })).status, 400);
  });

  it("isolates matters between users and ignores a userId in the body", async () => {
    const created = await app.request("/api/matters", post(alice, { title: "Alice v. State", userId: bob.id }));
    assert.equal(created.status, 201);
    const matter = (await created.json()).matter;
    assert.equal(matter.userId, alice.id);

    const bobMatters = (await (await app.request("/api/matters", { headers: bob.headers })).json()).matters;
    assert.ok(!bobMatters.some((m: any) => m.id === matter.id));

    // Bob cannot file a chat under Alice's matter.
    const attach = await app.request("/api/conversations", post(bob, { vakilId: "soli_master", matterId: matter.id }));
    assert.equal(attach.status, 404);
  });

  it("isolates saved documents, saves each only once, and exports them in full", async () => {
    const paragraph = "The petitioner submits that the impugned order is contrary to the settled position of law. ";
    const content = `# Grounds\n\n${Array.from({ length: 120 }, (_, i) => `${i + 1}. ${paragraph}`).join("\n")}\n\n- first point\n- second point\n\n**Prayer**\nIt is prayed that this Hon'ble Court may be pleased to allow the petition.`;

    const first = await app.request("/api/artifacts", post(alice, { title: "Bail application", content, vakilId: "soli_master" }));
    assert.equal(first.status, 200);
    const artifact = (await first.json()).artifact;
    assert.equal(artifact.content, content, "content is stored in full");

    const again = await app.request("/api/artifacts", post(alice, { title: "Bail application", content, vakilId: "soli_master" }));
    assert.equal((await again.json()).artifact.id, artifact.id, "saving the same document twice does not create a duplicate");

    for (const request of [
      app.request(`/api/artifacts/${artifact.id}`, { headers: bob.headers }),
      app.request(`/api/artifacts/${artifact.id}/export?format=pdf`, { headers: bob.headers }),
      app.request(`/api/artifacts/${artifact.id}`, { method: "DELETE", headers: bob.headers }),
    ]) {
      assert.equal((await request).status, 404);
    }
    assert.ok(!(await (await app.request("/api/artifacts", { headers: bob.headers })).json()).artifacts.some((a: any) => a.id === artifact.id));

    // The PDF carries the whole document, not the first few hundred characters.
    const pdf = await app.request(`/api/artifacts/${artifact.id}/export?format=pdf`, { headers: alice.headers });
    assert.equal(pdf.status, 200);
    assert.equal(pdf.headers.get("content-type"), "application/pdf");
    const pages = (await PDFDocument.load(new Uint8Array(await pdf.arrayBuffer()))).getPageCount();
    assert.ok(pages >= 4, `a 120-paragraph document should span several pages (got ${pages})`);

    const docx = await app.request(`/api/artifacts/${artifact.id}/export?format=docx`, { headers: alice.headers });
    assert.equal(docx.status, 200);
    assert.ok((await docx.arrayBuffer()).byteLength > 2000);

    // The owner can delete; afterwards it is gone.
    assert.equal((await app.request(`/api/artifacts/${artifact.id}`, { method: "DELETE", headers: alice.headers })).status, 200);
    assert.equal((await app.request(`/api/artifacts/${artifact.id}`, { headers: alice.headers })).status, 404);
  });

  it("exports text with line breaks and typographic marks, and tells the user when PDF can't show Hindi", async () => {
    const tricky = "Line one\nLine two with “curly quotes”, an em dash — and ₹5,00,000.\n\nSecond paragraph.";
    const saved = await app.request("/api/artifacts", post(alice, { title: "Notice", content: tricky, vakilId: "soli_master" }));
    const art = (await saved.json()).artifact;
    assert.equal((await app.request(`/api/artifacts/${art.id}/export?format=pdf`, { headers: alice.headers })).status, 200);

    const hindi = await app.request("/api/artifacts", post(alice, { title: "हिंदी नोटिस", content: "यह एक सूचना है।", vakilId: "soli_master" }));
    assert.equal(hindi.status, 200, "a document the PDF engine can't draw is still saved");
    const hindiArt = (await hindi.json()).artifact;
    const pdf = await app.request(`/api/artifacts/${hindiArt.id}/export?format=pdf`, { headers: alice.headers });
    assert.equal(pdf.status, 422);
    assert.equal((await pdf.json()).alternative, "docx");
    assert.equal((await app.request(`/api/artifacts/${hindiArt.id}/export?format=docx`, { headers: alice.headers })).status, 200);
  });

  it("accepts only real, supported uploads and serves files only to their owner", async () => {
    // Rejected: wrong type, disguised content, empty
    assert.equal((await app.request("/api/vakils/soli_master/files", upload(alice, "page.html", "<script>alert(1)</script>", "text/html"))).status, 415);
    assert.equal((await app.request("/api/vakils/soli_master/files", upload(alice, "image.svg", "<svg onload=alert(1)/>", "image/svg+xml"))).status, 415);
    assert.equal((await app.request("/api/vakils/soli_master/files", upload(alice, "run.exe", "MZ", "application/x-msdownload"))).status, 415);
    assert.equal((await app.request("/api/vakils/soli_master/files", upload(alice, "fake.pdf", "this is not a pdf", "application/pdf"))).status, 415);
    assert.equal((await app.request("/api/vakils/soli_master/files", upload(alice, "empty.txt", "", "text/plain"))).status, 415);

    // Accepted
    const ok = await app.request("/api/vakils/soli_master/files", upload(alice, "order.pdf", PDF_BYTES, "application/pdf"));
    assert.equal(ok.status, 200);
    const file = (await ok.json()).files[0];
    assert.equal(file.mime, "application/pdf");

    // Only the owner can fetch it, and it is served defensively.
    assert.equal((await app.request(`/api/files/${file.id}`, { headers: bob.headers })).status, 404);
    const mine = await app.request(`/api/files/${file.id}`, { headers: alice.headers });
    assert.equal(mine.status, 200);
    assert.equal(mine.headers.get("x-content-type-options"), "nosniff");
    assert.match(mine.headers.get("content-security-policy") || "", /sandbox/);
    assert.match(mine.headers.get("cache-control") || "", /no-store/);
  });

  it("limits agents to their owner, and shared agents cannot be deleted", async () => {
    const created = await app.request("/api/vakils", post(alice, { name: "Alice research", purpose: "mine", userId: bob.id }));
    assert.equal(created.status, 200);
    const vakil = (await created.json()).vakil;

    assert.equal((await app.request(`/api/vakils/${vakil.id}`, { headers: bob.headers })).status, 404);
    assert.equal((await app.request(`/api/vakils/${vakil.id}`, { method: "DELETE", headers: bob.headers })).status, 404);
    assert.equal((await app.request("/api/vakils/soli_master", { method: "DELETE", headers: alice.headers })).status, 404, "built-in agents are protected");
    assert.equal((await app.request("/api/vakils/soli_master", { headers: bob.headers })).status, 200, "built-in agents are shared");
    // Bob cannot attach files to Alice's agent
    assert.equal((await app.request(`/api/vakils/${vakil.id}/files`, upload(bob, "order.pdf", PDF_BYTES, "application/pdf"))).status, 404);

    assert.equal((await app.request(`/api/vakils/${vakil.id}`, { method: "DELETE", headers: alice.headers })).status, 200);
  });

  it("answers unknown routes and errors without internal details", async () => {
    const res = await app.request("/api/does-not-exist");
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: "Not found" });

    const ping = await (await app.request("/api/ping")).json();
    assert.equal(JSON.stringify(ping).includes(config.customLlmBaseUrl), false, "the model server address is never exposed");
    assert.ok((await app.request("/health")).ok);
  });

  it("sets defensive response headers", async () => {
    const res = await app.request("/health");
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.equal(res.headers.get("x-frame-options"), "DENY");
    assert.equal(res.headers.get("referrer-policy"), "no-referrer");
  });

  it("only allows configured browser origins", () => {
    assert.equal(corsOrigin("https://evil.example"), null);
    assert.equal(corsOrigin(undefined), null);
    assert.equal(corsOrigin("http://localhost:3100"), "http://localhost:3100"); // development only
    const original = [...config.corsOrigins];
    config.corsOrigins.push("https://app.example.com");
    assert.equal(corsOrigin("https://app.example.com/"), "https://app.example.com/");
    config.corsOrigins.splice(0, config.corsOrigins.length, ...original);
  });
});

describe("sign-up and sign-in protections", () => {
  const strong = "Password123!Secure";

  it("enforces the password policy on the backend itself", async () => {
    for (const password of ["short1", "alllettersnodigit", "12345678901"]) {
      await assert.rejects(
        registerUser({ name: "Weak Password", email: `weak_${Date.now()}@example.com`, password }),
        (err: unknown) => err instanceof AuthError && err.status === 400,
      );
    }
  });

  it("applies the invite-code and domain gate even when the web app is bypassed", async () => {
    const codes = [...config.signupInviteCodes];
    const domains = [...config.signupAllowedDomains];
    try {
      config.signupInviteCodes.splice(0, config.signupInviteCodes.length, "pilot-2026");
      await assert.rejects(
        registerUser({ name: "No Code", email: `nocode_${Date.now()}@example.com`, password: strong }),
        (err: unknown) => err instanceof AuthError && err.status === 403,
      );
      await assert.rejects(
        registerUser({ name: "Bad Code", email: `badcode_${Date.now()}@example.com`, password: strong, inviteCode: "pilot-2025" }),
        (err: unknown) => err instanceof AuthError && err.status === 403,
      );
      const ok = await registerUser({ name: "Good Code", email: `goodcode_${Date.now()}@example.com`, password: strong, inviteCode: "pilot-2026" });
      assert.ok(ok.token);

      config.signupInviteCodes.splice(0);
      config.signupAllowedDomains.splice(0, config.signupAllowedDomains.length, "firm.example");
      await assert.rejects(
        registerUser({ name: "Outsider", email: `outsider_${Date.now()}@example.com`, password: strong }),
        (err: unknown) => err instanceof AuthError && err.status === 403,
      );
    } finally {
      config.signupInviteCodes.splice(0, config.signupInviteCodes.length, ...codes);
      config.signupAllowedDomains.splice(0, config.signupAllowedDomains.length, ...domains);
    }
  });

  it("locks an account after repeated wrong passwords, even for the right password", async () => {
    const email = `lock_${Date.now()}@example.com`;
    await registerUser({ name: "Lock Test", email, password: strong });
    for (let i = 0; i < 8; i++) {
      await assert.rejects(loginUser({ email, password: "Wrong-password-1" }), (err: unknown) => err instanceof AuthError && err.status === 401);
    }
    await assert.rejects(loginUser({ email, password: strong }), (err: unknown) => err instanceof AuthError && err.status === 429);
  });

  it("gives the same answer for an unknown email and a wrong password", async () => {
    const email = `known_${Date.now()}@example.com`;
    await registerUser({ name: "Known User", email, password: strong });
    const unknown = await loginUser({ email: `nobody_${Date.now()}@example.com`, password: strong }).catch((e) => e);
    const wrong = await loginUser({ email, password: "Wrong-password-1" }).catch((e) => e);
    assert.equal(unknown.message, wrong.message);
    assert.equal(unknown.status, wrong.status);
  });
});
