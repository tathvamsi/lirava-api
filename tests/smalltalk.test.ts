process.env.NODE_ENV = "test";

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config.js";
import { classifySmallTalk, smallTalkReply } from "../src/services/agent/smalltalk.js";
import { startMockLlm, type MockLlm } from "./mock-llm.js";
import { createTestUser, type TestUser } from "./helpers.js";

describe("small talk is recognised, and real questions are not", () => {
  const cases: Array<[string, ReturnType<typeof classifySmallTalk>]> = [
    ["Hello", "greeting"],
    ["hi!", "greeting"],
    ["Good morning", "greeting"],
    ["Hello what is your name?", "identity"],
    ["hi, who are you?", "identity"],
    ["What's your name", "identity"],
    ["what is your name?", "identity"],
    ["Are you a bot?", "identity"],
    ["thanks", "thanks"],
    ["Thank you so much!", "thanks"],
    ["ok thanks", "thanks"],
    ["what can you do?", "capability"],
    ["what are you good at", "capability"],
    ["Hello, what can you do for me?", null], // not an exact small-talk phrase: let the model answer it
    // Real legal questions and look-alikes must reach the model.
    ["What is the name of the accused in a Section 138 complaint?", null],
    ["Hello, I need bail for my client under Section 480 BNSS", null],
    ["Who are you representing in this matter?", null],
    ["thanks, now draft the notice", null],
    ["help me draft a legal notice", null],
    ["", null],
  ];
  for (const [text, expected] of cases) {
    it(`${JSON.stringify(text)} -> ${expected}`, () => assert.equal(classifySmallTalk(text), expected));
  }

  it("has a fixed reply for greetings, name questions and thanks, and none for the rest", () => {
    assert.match(smallTalkReply("greeting")!, /^Hello\. I'm Lirava/);
    assert.match(smallTalkReply("identity")!, /I'm Lirava, an AI research assistant for Indian lawyers/);
    assert.match(smallTalkReply("thanks")!, /welcome/i);
    assert.equal(smallTalkReply("capability"), null);
    assert.equal(smallTalkReply(null), null);
  });
});

describe("small talk in a chat", () => {
  let mock: MockLlm;
  before(async () => {
    mock = await startMockLlm();
    config.customLlmBaseUrl = mock.url;
    config.upstreamTimeoutMs = 3000;
  });
  after(async () => {
    await mock.close();
  });
  const appPromise = () => import("../src/index.js").then((m) => m.default);
  const post = (user: TestUser, body: unknown) => ({ method: "POST", headers: user.headers, body: JSON.stringify(body) });

  async function chat(label: string) {
    const app = await appPromise();
    const user = await createTestUser(label);
    const id = `conv_${label}_${Date.now()}`;
    assert.equal((await app.request("/api/conversations", post(user, { vakilId: "soli_master", id }))).status, 200);
    return { app, user, id };
  }

  it("answers 'Hello what is your name?' with her name, no source and no model call", async () => {
    const { app, user, id } = await chat("st_name");
    mock.requests.length = 0;
    const res = await app.request("/api/agent/message", post(user, { vakilId: "soli_master", text: "Hello what is your name?", conversationId: id }));
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.match(body.assistantMessage.text, /I'm Lirava, an AI research assistant/);
    assert.ok(!body.assistantMessage.citations || body.assistantMessage.citations.length === 0, "no source is attached");
    assert.equal(mock.requests.length, 0, "the model was not called");
  });

  it("answers 'what can you do?' without searching statutes or attaching a source", async () => {
    const { app, user, id } = await chat("st_cap");
    mock.requests.length = 0;
    const res = await app.request("/api/agent/message", post(user, { vakilId: "soli_master", text: "what can you do?", conversationId: id }));
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.ok(body.assistantMessage.text.length > 0);
    assert.ok(!body.assistantMessage.citations || body.assistantMessage.citations.length === 0, "no source is attached");
    assert.equal(mock.requests.length, 1, "the model answered it");
    assert.doesNotMatch(mock.requests[0].system, /STATUTORY PROVISIONS/, "no statutes were put in front of the model");
  });

  it("a real legal question still goes to the model", async () => {
    const { app, user, id } = await chat("st_legal");
    mock.requests.length = 0;
    const res = await app.request("/api/agent/message", post(user, { vakilId: "soli_master", text: "What is the limitation period for a Section 138 complaint?", conversationId: id }));
    assert.equal(res.status, 200);
    assert.equal(mock.requests.length, 1);
  });
});
