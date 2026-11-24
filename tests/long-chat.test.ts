process.env.NODE_ENV = "test";

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config.js";
import { startMockLlm, type MockLlm } from "./mock-llm.js";
import { createTestUser, type TestUser } from "./helpers.js";
import { estimateTokens, safetyTokens, CUT_OFF_NOTICE } from "../src/services/agent/context-budget.js";

let mock: MockLlm;
before(async () => {
  mock = await startMockLlm();
  config.customLlmBaseUrl = mock.url;
  config.upstreamTimeoutMs = 3000;
});
after(async () => {
  mock.setServerWindow(null);
  await mock.close();
});

const appPromise = () => import("../src/index.js").then((m) => m.default);
const post = (user: TestUser, body: unknown) => ({ method: "POST", headers: user.headers, body: JSON.stringify(body) });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const words = (n: number, w = "bail") => Array.from({ length: n }, () => w).join(" ");
const promptTokens = (messages: Array<{ content: string }>) => messages.reduce((n, m) => n + estimateTokens(m.content) + 8, 4);

async function newChat(app: Awaited<ReturnType<typeof appPromise>>, user: TestUser, id: string) {
  const res = await app.request("/api/conversations", post(user, { vakilId: "soli_master", id }));
  assert.equal(res.status, 200);
  return id;
}

/** Sends a message and waits for the answer (the route returns it when it is not a background run). */
async function ask(app: Awaited<ReturnType<typeof appPromise>>, user: TestUser, conversationId: string, text: string) {
  const res = await app.request("/api/agent/message", post(user, { vakilId: "soli_master", text, conversationId }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.assistantMessage, "an answer came back");
  return body.assistantMessage.text as string;
}

describe("answers are not cut off", () => {
  it("carries on from where the model stopped when it hits its length limit", async () => {
    const app = await appPromise();
    const user = await createTestUser("cut_continue");
    const conv = await newChat(app, user, `conv_cut_${Date.now()}`);
    mock.requests.length = 0;

    const text = await ask(app, user, conv, "CUTOFF explain section 138 in detail");
    assert.match(text, /part0 .* part11 and the rest of the answer\./, "the two parts are joined into one answer");
    assert.doesNotMatch(text, /length limit/, "no apology, because the answer was finished");

    assert.equal(mock.requests.length, 2, "one call plus one continuation");
    const second = mock.requests[1];
    assert.match(second.user, /^Continue exactly where you stopped/);
    const partial = second.messages.at(-2)!;
    assert.equal(partial.role, "assistant");
    assert.match(partial.content, /part0/, "the model is shown what it already wrote");
    assert.equal(second.messages[0].content, mock.requests[0].messages[0].content, "same prompt prefix, so the server can reuse its cache");
  });

  it("ends at a full sentence and says how to get the rest when there is never enough room", async () => {
    const app = await appPromise();
    const user = await createTestUser("cut_forever");
    const conv = await newChat(app, user, `conv_cutf_${Date.now()}`);
    mock.requests.length = 0;

    const text = await ask(app, user, conv, "CUTOFF_FOREVER explain everything");
    assert.ok(text.endsWith(CUT_OFF_NOTICE.trim()), `ends with the notice: ...${text.slice(-120)}`);
    assert.equal(mock.requests.length, 3, "the first call plus two continuations (the limit for a question), then it stops asking");
    for (const r of mock.requests) assert.ok((r.maxTokens ?? 0) > 0 && (r.maxTokens ?? 0) <= config.answerMaxTokens, `max_tokens ${r.maxTokens} stays within the answer allowance`);

    // The saved message is the same text the user saw.
    const saved = await (await app.request(`/api/conversations/${conv}`, { headers: user.headers })).json();
    assert.equal(saved.messages.at(-1).text, text);
  });

  it("an answer that finishes normally is never marked or continued", async () => {
    const app = await appPromise();
    const user = await createTestUser("cut_none");
    const conv = await newChat(app, user, `conv_cutn_${Date.now()}`);
    mock.requests.length = 0;
    const text = await ask(app, user, conv, "What is bail?");
    assert.doesNotMatch(text, /length limit/);
    assert.equal(mock.requests.length, 1);
  });
});

describe("long chats stay inside the window", () => {
  it("trims old messages so every request fits, then summarises them and uses the summary", async () => {
    const app = await appPromise();
    const user = await createTestUser("long_chat");
    const conv = await newChat(app, user, `conv_long_${Date.now()}`);
    const { getChatSummary } = await import("../src/services/chats/store.js");
    mock.requests.length = 0;

    const limit = config.contextWindowTokens - config.answerMaxTokens - safetyTokens(config.contextWindowTokens);
    const sent: string[] = [];
    for (let i = 0; i < 16; i++) {
      const text = `Question ${i}: ${words(450, "facts")} (the client is Ram Kumar)`;
      sent.push(text);
      await ask(app, user, conv, text);
    }

    // Every request, including the last, fits the window with room for the whole answer.
    for (const [i, r] of mock.requests.filter((m) => !m.system.includes("running summary")).entries()) {
      assert.ok(promptTokens(r.messages) <= limit + 20, `request ${i}: ${promptTokens(r.messages)} tokens, limit ${limit}`);
    }
    const lastChat = mock.requests.filter((m) => !m.system.includes("running summary")).at(-1)!;
    const sentTurns = lastChat.messages.filter((m) => m.role === "user").length;
    assert.ok(sentTurns < 16, `old messages were left out (${sentTurns} of 16 user messages sent)`);
    assert.equal(lastChat.user, sent[15], "the newest question is always sent whole");
    assert.ok(lastChat.messages.some((m) => m.content.startsWith("Question 14")), "the newest earlier messages are kept");

    // Older messages were folded into the chat's saved summary (done after the answer, so wait for it).
    let summary = { summary: "", upto: 0 };
    for (let i = 0; i < 60 && !summary.summary; i++) {
      summary = await getChatSummary(conv, user.id);
      if (!summary.summary) await sleep(100);
    }
    assert.match(summary.summary, /SUMMARY-MARK/, "a summary was saved");
    assert.ok(summary.upto > 0);

    // And from the next message on, the model is given it.
    mock.requests.length = 0;
    await ask(app, user, conv, "Remind me who the client is.");
    const next = mock.requests.find((m) => !m.system.includes("running summary"))!;
    assert.match(next.system, /SUMMARY OF THE EARLIER PART OF THIS CHAT/);
    assert.match(next.system, /SUMMARY-MARK/);
    assert.ok(!next.messages.some((m) => m.content.startsWith("Question 0:")), "messages already in the summary are not sent a second time");
  });

  it("shortens a huge pasted message instead of failing", async () => {
    const app = await appPromise();
    const user = await createTestUser("long_paste");
    const conv = await newChat(app, user, `conv_paste_${Date.now()}`);
    mock.requests.length = 0;

    const paste = `BEGIN-PASTE ${words(30000, "clause")} END-PASTE what is the limitation period?`;
    const text = await ask(app, user, conv, paste);
    assert.ok(text.length > 0 && !/couldn't complete/i.test(text));
    const r = mock.requests[0];
    assert.ok(r.user.startsWith("BEGIN-PASTE") && r.user.endsWith("what is the limitation period?"), "start and end are kept");
    assert.ok(r.user.length < paste.length / 2, "the middle was left out");
    assert.match(r.system, /latest message was longer than the model can read/);
    assert.ok(promptTokens(r.messages) + config.answerMaxTokens <= config.contextWindowTokens);
  });

  it("learns the real window from the server's error and retries with a smaller prompt", async () => {
    const app = await appPromise();
    const user = await createTestUser("window_learn");
    const conv = await newChat(app, user, `conv_win_${Date.now()}`);
    mock.requests.length = 0;
    // The server's real window is smaller than the platform assumes (as if the server were configured differently).
    mock.setServerWindow(2600);
    try {
      const text = await ask(app, user, conv, `A fairly long question ${words(300)}`);
      assert.ok(mock.requests.length >= 2, "the first request was refused and a smaller one was sent");
      assert.ok(mock.requests[0].messages.length >= 2);
      assert.match(text, /bail was sought|part0/, `the user got an answer, not the offline notice: ${text.slice(0, 120)}`);
      assert.doesNotMatch(text, /offline|Knowledge Engine/i);

      // Later questions already use the learned window: accepted at once, no refusal first.
      mock.requests.length = 0;
      const again = await ask(app, user, conv, "And what about the notice period?");
      assert.equal(mock.requests.length, 1, "no second try needed");
      assert.doesNotMatch(again, /offline|Knowledge Engine/i);
    } finally {
      mock.setServerWindow(null);
    }
  });
});
