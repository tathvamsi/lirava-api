process.env.NODE_ENV = "test";

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createTestUser, type TestUser } from "./helpers.js";

const KEY = "sk_test_sarvam_secret_123";

describe("choosing the AI provider", () => {
  let server: Server;
  const seen: Array<{ model: string; auth: string | undefined; sub: string | undefined; effort: unknown }> = [];
  let failStreams = 0; // how many streamed requests the mock refuses with a 503 before it answers
  let loopNext = false; // when true the mock writes the same clause over and over, like a small model that got stuck
  let user: TestUser;

  before(async () => {
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        let body: { model?: string; stream?: boolean; reasoning_effort?: unknown } = {};
        try {
          body = JSON.parse(raw);
        } catch {
          /* not JSON */
        }
        seen.push({ model: String(body.model), auth: req.headers.authorization, sub: req.headers["api-subscription-key"] as string | undefined, effort: body.reasoning_effort });
        if (!body.stream) {
          res.setHeader("Content-Type", "application/json");
          return void res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "Answer from the hosted model." }, finish_reason: "stop" }] }));
        }
        if (failStreams > 0) {
          failStreams--;
          res.statusCode = 503;
          return void res.end(JSON.stringify({ error: { message: "server busy" } }));
        }
        if (loopNext) {
          res.setHeader("Content-Type", "text/event-stream");
          const clause = "or if the proceedings are manifestly frivolous in nature and the court is satisfied that the proceedings are not in the public interest, ";
          const piece = (c: string) => `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: c }, finish_reason: null }] })}\n\n`;
          res.write(piece("Section 248 provides that a court may quash a proceeding "));
          for (let i = 0; i < 60; i++) res.write(piece(clause));
          res.write(`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "length" }] })}\n\n`);
          return void res.end("data: [DONE]\n\n");
        }
        res.setHeader("Content-Type", "text/event-stream");
        // A reasoning model with reasoning on spends its whole budget thinking: no text, and the length limit.
        if (typeof body.reasoning_effort === "string") {
          res.write(`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "length" }] })}\n\n`);
          return void res.end("data: [DONE]\n\n");
        }
        const chunk = (delta: object, finish: string | null) => `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
        res.write(chunk({ content: "Answer from the hosted model." }, null));
        res.write(chunk({}, "stop"));
        res.end("data: [DONE]\n\n");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    user = await createTestUser("providers");
  });
  after(async () => {
    delete process.env.SARVAM_API_KEY;
    delete process.env.SARVAM_BASE_URL;
    await new Promise((resolve) => server.close(resolve));
  });

  it("lists the three providers, says which are set up, and never shows a key or an address", async () => {
    delete process.env.SARVAM_API_KEY;
    const app = (await import("../src/index.js")).default;
    const res = await app.request("/api/agent/providers", { headers: user.headers });
    assert.equal(res.status, 200);
    const raw = await res.text();
    const list = JSON.parse(raw).providers as Array<{ id: string; available: boolean; hosted: boolean; note: string }>;
    assert.deepEqual(list.map((p) => p.id), ["custom", "nvidia", "sarvam"]);
    const sarvam = list.find((p) => p.id === "sarvam")!;
    assert.equal(sarvam.available, false);
    assert.match(sarvam.note, /SARVAM_API_KEY/);
    assert.equal(sarvam.hosted, true);
    assert.ok(!/api\.sarvam\.ai|127\.0\.0\.1|sk_|Bearer/.test(raw), "no address or key in the list");
  });

  it("needs a signed-in user", async () => {
    const app = (await import("../src/index.js")).default;
    assert.equal((await app.request("/api/agent/providers")).status, 401);
  });

  it("refuses a provider that is not set up, or does not exist, with the reason", async () => {
    delete process.env.SARVAM_API_KEY;
    const app = (await import("../src/index.js")).default;
    const send = (provider: string) => app.request("/api/agent/message", { method: "POST", headers: user.headers, body: JSON.stringify({ vakilId: "soli_master", text: "What is bail?", provider }) });
    const notSetUp = await send("sarvam");
    assert.equal(notSetUp.status, 400);
    const body = await notSetUp.json();
    assert.equal(body.code, "provider_unavailable");
    assert.match(body.error, /Sarvam is not available.*SARVAM_API_KEY/);
    const unknown = await send("gpt-nine");
    assert.equal(unknown.status, 400);
    assert.match((await unknown.json()).error, /Unknown model/);
  });

  it("sends a Sarvam chat to Sarvam, with its model name and its key header", { timeout: 120000 }, async () => {
    process.env.SARVAM_API_KEY = KEY;
    process.env.SARVAM_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    const app = (await import("../src/index.js")).default;
    const { createConversation } = await import("../src/services/chats/store.js");
    const conv = await createConversation("soli_master", "Provider", user.id, `conv_prov_${Date.now()}`, null);

    seen.length = 0;
    const res = await app.request("/api/agent/message", {
      method: "POST",
      headers: user.headers,
      body: JSON.stringify({ vakilId: "soli_master", text: "What is anticipatory bail?", conversationId: conv.id, provider: "sarvam" }),
    });
    assert.equal(res.status, 200);
    const text = (await res.json()).assistantMessage.text as string;
    assert.match(text, /Answer from the hosted model/);
    assert.ok(seen.length > 0, "the hosted server received the request");
    assert.ok(seen.every((s) => s.model === "sarvam-105b"), `models: ${seen.map((s) => s.model).join(",")}`);
    assert.ok(seen.every((s) => s.sub === KEY), "the Sarvam key header was sent");
    assert.ok(seen.every((s) => s.auth === `Bearer ${KEY}`), "the standard bearer header was sent too");
    });

  it("keeps Sarvam's reasoning off unless asked for, so its thinking cannot use the whole answer budget", async () => {
    process.env.SARVAM_API_KEY = KEY;
    delete process.env.SARVAM_REASONING_EFFORT;
    const { resolveProvider } = await import("../src/services/agent/providers.js");
    assert.deepEqual(resolveProvider("sarvam").body, { reasoning_effort: null });
    process.env.SARVAM_REASONING_EFFORT = "low";
    assert.deepEqual(resolveProvider("sarvam").body, { reasoning_effort: "low" });
    delete process.env.SARVAM_REASONING_EFFORT;
  });

  it("when a model thinks for its whole budget and writes nothing, asks again with reasoning off", { timeout: 120000 }, async () => {
    process.env.SARVAM_API_KEY = KEY;
    process.env.SARVAM_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    process.env.SARVAM_REASONING_EFFORT = "high";
    try {
      const app = (await import("../src/index.js")).default;
      const { createConversation } = await import("../src/services/chats/store.js");
      const conv = await createConversation("soli_master", "Reasoning", user.id, `conv_reason_${Date.now()}`, null);
      seen.length = 0;
      const res = await app.request("/api/agent/message", {
        method: "POST",
        headers: user.headers,
        body: JSON.stringify({ vakilId: "soli_master", text: "What is anticipatory bail?", conversationId: conv.id, provider: "sarvam" }),
      });
      const text = (await res.json()).assistantMessage.text as string;
      assert.match(text, /Answer from the hosted model/, "the user gets an answer, not the unavailable message");
      assert.ok(seen.some((x) => x.effort === "high"), "the first try had reasoning on");
      assert.ok(seen.some((x) => x.effort === null), "the second try had reasoning off");
    } finally {
      delete process.env.SARVAM_REASONING_EFFORT;
    }
    });

  it("tries a hosted provider once more when it fails for a moment", { timeout: 120000 }, async () => {
    process.env.SARVAM_API_KEY = KEY;
    process.env.SARVAM_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    const app = (await import("../src/index.js")).default;
    const { createConversation } = await import("../src/services/chats/store.js");
    const conv = await createConversation("soli_master", "Busy", user.id, `conv_busy_${Date.now()}`, null);
    failStreams = 1;
    const res = await app.request("/api/agent/message", {
      method: "POST",
      headers: user.headers,
      body: JSON.stringify({ vakilId: "soli_master", text: "What is anticipatory bail?", conversationId: conv.id, provider: "sarvam" }),
    });
    const text = (await res.json()).assistantMessage.text as string;
    assert.match(text, /Answer from the hosted model/, "the second try answered");
    assert.equal(failStreams, 0, "the first try was refused");
  });

  it("gives up with the unavailable message when a hosted provider keeps failing", { timeout: 120000 }, async () => {
    process.env.SARVAM_API_KEY = KEY;
    process.env.SARVAM_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    const app = (await import("../src/index.js")).default;
    const { createConversation } = await import("../src/services/chats/store.js");
    const conv = await createConversation("soli_master", "Down", user.id, `conv_down_${Date.now()}`, null);
    failStreams = 5;
    const res = await app.request("/api/agent/message", {
      method: "POST",
      headers: user.headers,
      body: JSON.stringify({ vakilId: "soli_master", text: "What is anticipatory bail?", conversationId: conv.id, provider: "sarvam" }),
    });
    assert.match((await res.json()).assistantMessage.text, /AI model is not available right now/);
    failStreams = 0;
  });

  it("stops an answer that repeats itself and keeps the first copy", { timeout: 120000 }, async () => {
    process.env.SARVAM_API_KEY = KEY;
    process.env.SARVAM_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    const app = (await import("../src/index.js")).default;
    const { createConversation } = await import("../src/services/chats/store.js");
    const conv = await createConversation("soli_master", "Loop", user.id, `conv_loop_${Date.now()}`, null);
    loopNext = true;
    try {
      const res = await app.request("/api/agent/message", {
        method: "POST",
        headers: user.headers,
        body: JSON.stringify({ vakilId: "soli_master", text: "What does BNS 248 say?", conversationId: conv.id, provider: "sarvam" }),
      });
      const text = (await res.json()).assistantMessage.text as string;
      assert.match(text, /Section 248 provides/);
      const copies = text.split("manifestly frivolous in nature").length - 1;
      assert.ok(copies >= 1 && copies <= 2, `the clause appears ${copies} times, not dozens`);
      assert.ok(text.length < 1500, `the answer is ${text.length} characters, not thousands`);
    } finally {
      loopNext = false;
    }
  });
});
