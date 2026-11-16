process.env.NODE_ENV = "test";

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config.js";
import { decideRetrieval, hasLegalSignal, type GateInput } from "../src/services/agent/retrieval-gate.js";
import { startMockLlm, type MockLlm } from "./mock-llm.js";
import { createTestUser, type TestUser } from "./helpers.js";

const ask = (text: string, extra: Partial<GateInput> = {}) => decideRetrieval({ text, hasAttachments: false, inMatter: false, ...extra });

describe("retrieval gate: general and casual messages search nothing", () => {
  const general = [
    "What is the capital of France?",
    "Write a short poem about monsoon",
    "What is 15% of 2400?",
    "Explain photosynthesis in simple words",
    "Translate 'good morning' into Tamil",
    "Give me a recipe for dal tadka",
    "Write a Python function to reverse a string",
    "Tell me about the history of the Taj Mahal",
    "How do I forget a Wi-Fi network on my phone?",
    "I forgot my password",
    "Hello what is your name?",
    "thanks",
    "what can you do?",
  ];
  for (const text of general) {
    it(`skips: ${text}`, () => {
      const d = ask(text);
      assert.equal(d.statutes, false, `statutes for "${text}" (${d.reason})`);
      assert.equal(d.documents, false, `documents for "${text}" (${d.reason})`);
    });
  }
});

describe("retrieval gate: anything legal still searches (a wrong skip is worse than a wasted search)", () => {
  const legal = [
    "What is the punishment for cheating under BNS?",
    "Can my client get anticipatory bail?",
    "Explain Section 138 of the Negotiable Instruments Act",
    "My client was arrested last night, what are his rights?",
    "Draft a legal notice for cheque dishonour",
    "What is the limitation period for filing a suit?",
    "Is a confession to the police admissible?",
    "Can a landlord evict a tenant without notice?",
    "what does Order VII Rule 11 say",
    "Article 21 and the right to life",
    "FIR was filed against my brother, what should we do?",
    "What happens if a witness turns hostile?",
    "Summarise the High Court judgment on quashing",
  ];
  for (const text of legal) {
    it(`searches: ${text}`, () => {
      const d = ask(text);
      assert.equal(d.statutes, true, `statutes for "${text}" (${d.reason})`);
      assert.equal(d.documents, true);
      assert.ok(hasLegalSignal(text));
    });
  }

  it("searches when a file is attached, even if the words are plain", () => {
    const d = ask("Please summarise this", { hasAttachments: true });
    assert.deepEqual([d.statutes, d.documents, d.reason], [true, true, "attachments"]);
  });

  it("searches inside a case, where its documents and notes are part of the question", () => {
    const d = ask("Who is the second person named in it?", { inMatter: true });
    assert.deepEqual([d.statutes, d.documents, d.reason], [true, true, "matter"]);
  });

  it("searches for a Hindi question, which has no English legal words to match", () => {
    const d = ask("जमानत के लिए क्या करना होगा");
    assert.deepEqual([d.statutes, d.reason], [true, "non-english"]);
  });

  it("treats a longer follow-up in a legal chat as legal, but not a bare 'why?'", () => {
    const recent = ["My client was arrested for cheating", "Under BNS Section 318 the offence is cognizable."];
    assert.equal(ask("and what if he was a minor then?", { recent }).reason, "follow-up");
    assert.equal(ask("and what if he was a minor then?", { recent }).statutes, true);
    assert.equal(ask("why?", { recent }).statutes, false);
  });

  it("a general question after a legal chat is still general", () => {
    // No legal word in the question and nothing legal in the last few messages.
    assert.equal(ask("What is the capital of France?", { recent: ["Hello", "Hi there"] }).statutes, false);
  });

  it("RETRIEVAL_GATE=off searches everything except small talk", () => {
    process.env.RETRIEVAL_GATE = "off";
    try {
      assert.equal(ask("What is the capital of France?").statutes, true);
      assert.equal(ask("thanks").statutes, false);
    } finally {
      delete process.env.RETRIEVAL_GATE;
    }
  });
});

describe("retrieval gate in a real chat", () => {
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

  async function send(label: string, text: string) {
    const app = await appPromise();
    const user = await createTestUser(label);
    const id = `conv_${label}_${Date.now()}`;
    assert.equal((await app.request("/api/conversations", post(user, { vakilId: "soli_master", id }))).status, 200);
    mock.requests.length = 0;
    const res = await app.request("/api/agent/message", post(user, { vakilId: "soli_master", text, conversationId: id }));
    assert.equal(res.status, 200);
    return { body: await res.json(), request: mock.requests[0] };
  }

  it("a general question gets no statute in the prompt and no source under the answer", async () => {
    // "name" and "person" appear in the statute text, so an ungated search would have attached one.
    const { body, request } = await send("gate_general", "Suggest a good name for my pet puppy and a person to ask about vaccines");
    assert.ok(request, "the model answered it");
    assert.doesNotMatch(request.system, /STATUTORY PROVISIONS/);
    assert.ok(!body.assistantMessage.citations || body.assistantMessage.citations.length === 0, "no source attached");
  });

  it("a legal question still gets the statute library searched", async () => {
    const { request } = await send("gate_legal", "What does the BNSS say about the police report on completion of investigation?");
    assert.match(request.system, /STATUTORY PROVISIONS/, "the matching provision was put in front of the model");
  });
});
