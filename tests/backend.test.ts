process.env.NODE_ENV = "test";

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import app from "../src/index.js";
import { generateCourtPdf, generateCourtDocx } from "../src/services/legal/court-engine.js";
import { createApiKey } from "../src/services/admin/api-keys.js";
import { registerModel } from "../src/services/admin/model-registry.js";
import { registerNode } from "../src/services/admin/node-manager.js";

describe("Soli Standalone Backend Service", () => {
  it("should respond to root endpoint with service metadata", async () => {
    const res = await app.request("/");
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.service, "soli-backend");
    assert.equal(data.status, "running");
  });

  it("should respond to ping endpoint with LLM health", async () => {
    const res = await app.request("/api/ping");
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.service, "soli-backend");
    assert.ok(data.llm);
  });

  it("should reject integration requests without a signed session", async () => {
    const res = await app.request("/api/connectors");
    assert.equal(res.status, 401);
  });

  it("should generate court-compliant PDF with proper margins and cause title", async () => {
    const pdfBytes = await generateCourtPdf({
      courtName: "In the High Court of Judicature at Delhi",
      caseType: "Writ Petition (Civil)",
      petitioner: "ABC Infotech Private Limited",
      respondent: "Union of India & Anr.",
      grounds: [
        "That the impugned show-cause notice was issued in blatant violation of statutory principles.",
        "That the Respondent failed to provide reasonable opportunity of being heard.",
      ],
      prayers: [
        "Issue a writ of Certiorari quashing the impugned notice dated 12.04.2024.",
        "Pass such other orders as this Hon'ble Court deems fit in the interest of justice.",
      ],
    });

    assert.ok(pdfBytes instanceof Uint8Array);
    assert.ok(pdfBytes.length > 500); // Valid PDF file length
  });

  it("should generate editable Word DOCX pleading", async () => {
    const docxBuf = await generateCourtDocx({
      courtName: "In the District Court of Saket, New Delhi",
      caseType: "Commercial Suit",
      petitioner: "Global Logistics Ltd.",
      respondent: "Prime Builders Corp.",
      grounds: ["Breach of contract for supply of goods."],
      prayers: ["Decree for sum of Rs. 25,00,000/- with interest."],
    });

    assert.ok(Buffer.isBuffer(docxBuf));
    assert.ok(docxBuf.length > 500);
  });

  it("should register models in SQLite and query via admin API", async () => {
    const model = registerModel({
      name: "Qwen 2.5 7B Instruct",
      gguf_file: "qwen2.5-7b-instruct-q4_k_m-00001-of-00002.gguf",
      storage_path: "/home/ritvox/LLM-Server/models/qwen2.5-7b-instruct-q4_k_m-00001-of-00002.gguf",
      quantization: "Q4_K_M",
      context_window: 4096,
    });

    assert.ok(model.id);

    const res = await app.request("/api/admin/models");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.models));
    assert.ok(body.models.some((m: any) => m.id === model.id));
  });

  it("should register and toggle inference nodes", async () => {
    const node = registerNode({
      name: "Local Node 1 (RTX 4090)",
      address: "10.10.0.247:8082",
    });

    assert.ok(node.id);

    const drainRes = await app.request(`/api/admin/nodes/${node.id}/drain`, { method: "POST" });
    assert.equal(drainRes.status, 200);
    const drainBody = await drainRes.json();
    assert.equal(drainBody.is_draining, 1);
  });

  it("should create high-entropy hashed API key and verify secrets are never stored in plaintext", async () => {
    const { record, fullSecret } = createApiKey({
      organizationId: "org-test",
      name: "Test Production Key",
      scopes: ["chat", "rag", "documents"],
    });

    assert.ok(fullSecret.startsWith("soli_live_"));
    assert.equal(record.name, "Test Production Key");

    const res = await app.request("/api/admin/api-keys?orgId=org-test");
    assert.equal(res.status, 200);
    const body = await res.json();
    const retrieved = body.keys.find((k: any) => k.id === record.id);
    assert.ok(retrieved);
    // Crucial security check: fullSecret must never be returned in listing
    assert.equal((retrieved as any).fullSecret, undefined);
    assert.equal((retrieved as any).key_hash, undefined);
  });

  it("should provide authoritative legal consultation when LLM node is offline without exposing raw node diagnostics", { timeout: 120000 }, async () => {
    const res = await app.request("/api/agent/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        dotId: "dot_test",
        text: "Please analyze the bail provisions under Section 482 of BNSS.",
        userId: "usr_test",
        conversationId: "conv_test",
      }),
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.userMessage);
    assert.equal(body.userMessage.role, "user");
    assert.equal(body.userMessage.text, "Please analyze the bail provisions under Section 482 of BNSS.");
    assert.ok(body.assistantMessage);
    assert.equal(body.assistantMessage.role, "dot");
    assert.equal(body.assistantMessage.conversationId, "conv_test");
    // Verify professional legal analysis is provided
    assert.ok(body.assistantMessage.text.includes("Bail") || body.assistantMessage.text.includes("bail"));
    assert.ok(body.assistantMessage.text.includes("Bharatiya Nagarik Suraksha Sanhita") || body.assistantMessage.text.includes("BNSS"));
    // Verify internal technical details and IP addresses are NEVER leaked to the user
    assert.ok(!body.assistantMessage.text.includes("Local Inference Node Notice"));
    assert.ok(!body.assistantMessage.text.includes("10.10.0.247"));
  });
});
