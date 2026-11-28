process.env.NODE_ENV = "test";

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config.js";
import { startMockLlm, type MockLlm } from "./mock-llm.js";
import { createTestUser, type TestUser } from "./helpers.js";
import { ANSWER_FORMAT, answerFormatSection } from "../src/services/agent/answer-format.js";

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
type App = Awaited<ReturnType<typeof appPromise>>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const post = (user: TestUser, body: unknown) => ({ method: "POST", headers: user.headers, body: JSON.stringify(body) });

async function waitForAnswer(app: App, user: TestUser, convId: string, count: number) {
  const end = Date.now() + 30000;
  while (Date.now() < end) {
    const body = await (await app.request(`/api/conversations/${convId}`, { headers: user.headers })).json();
    if (body.messages.length >= count) return;
    await sleep(300);
  }
  throw new Error("the answer did not arrive");
}

describe("the answer format", () => {
  it("is added for an answer to a question and left out for a document or plan", () => {
    assert.equal(answerFormatSection(null), ANSWER_FORMAT);
    assert.equal(answerFormatSection("document"), null);
    assert.equal(answerFormatSection("plan"), null);
  });

  it("names the three labels the web app reads, with an example", () => {
    for (const label of ["Bottom line:", "Gaps:", "Next move:"]) assert.ok(ANSWER_FORMAT.includes(label), `${label} is in the instruction`);
    assert.match(ANSWER_FORMAT, /Example:/);
    assert.match(ANSWER_FORMAT, /greeting/i, "it says not to use the format for a greeting");
  });

  it("reaches the model with a question", { timeout: 120000 }, async () => {
    const app = await appPromise();
    const user = await createTestUser("answer_format");
    const conv = `conv_format_${Date.now()}`;
    const created = await app.request("/api/conversations", post(user, { vakilId: "soli_master", id: conv }));
    assert.equal(created.status, 200);

    mock.requests.length = 0;
    await app.request("/api/agent/message", post(user, { vakilId: "soli_master", text: "What is the limitation for a cheque bounce complaint?", conversationId: conv, background: true }));
    await waitForAnswer(app, user, conv, 2);

    const system = mock.requests.at(-1)!.system;
    assert.match(system, /ANSWER FORMAT/);
    assert.match(system, /Bottom line:/);
    assert.match(system, /Gaps:/);
  });
});
