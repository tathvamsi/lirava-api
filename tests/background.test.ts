process.env.NODE_ENV = "test";

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { config } from "../src/config.js";
import { startMockLlm, type MockLlm } from "./mock-llm.js";
import { createTestUser, type TestUser } from "./helpers.js";
import { RunQueue } from "../src/services/agent/queue.js";

let mock: MockLlm;
// Point the service at the mock BEFORE the app (and its model client) is first used.
before(async () => {
  mock = await startMockLlm();
  config.customLlmBaseUrl = mock.url;
  config.upstreamTimeoutMs = 3000;
});
after(async () => {
  await mock.close();
});

const appPromise = () => import("../src/index.js").then((m) => m.default);
const busBus = () => import("../src/services/bus/index.js");

const post = (user: TestUser, body: unknown) => ({ method: "POST", headers: user.headers, body: JSON.stringify(body) });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(read: () => Promise<T | undefined | false>, ms = 20000, label = "condition"): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await read();
    if (value) return value;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function messages(app: Awaited<ReturnType<typeof appPromise>>, user: TestUser, convId: string) {
  const body = await (await app.request(`/api/conversations/${convId}`, { headers: user.headers })).json();
  return body.messages as Array<{ role: string; text: string; citations?: Array<Record<string, unknown>> | null }>;
}

async function newChat(app: Awaited<ReturnType<typeof appPromise>>, user: TestUser, id: string) {
  const res = await app.request("/api/conversations", post(user, { vakilId: "soli_master", id }));
  assert.equal(res.status, 200);
  return id;
}

describe("answers are written in the background", () => {
  it("saves the question and returns at once; the answer arrives later and is stored", async () => {
    const app = await appPromise();
    const { onEvent } = await busBus();
    const user = await createTestUser("bg_basic");
    const conv = await newChat(app, user, `conv_bg_${Date.now()}`);

    const statuses: string[] = [];
    const off = onEvent((e) => {
      if (e.type === "run_status" && e.userId === user.id) statuses.push((e.data as { status: string }).status);
    });

    const started = Date.now();
    const res = await app.request("/api/agent/message", post(user, { vakilId: "soli_master", text: "What is bail?", conversationId: conv, background: true }));
    const elapsed = Date.now() - started;
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.userMessage.text, "What is bail?");
    assert.equal(body.assistantMessage, undefined, "the answer is not part of this reply");
    assert.ok(elapsed < 3000, `returned in ${elapsed} ms, before the answer`);

    const saved = await waitFor(async () => {
      const list = await messages(app, user, conv);
      return list.length === 2 ? list : undefined;
    }, 20000, "the saved answer");
    assert.deepEqual(saved.map((m) => m.role), ["user", "vakil"]);
    assert.match(saved[1].text, /bail was sought/);
    await waitFor(async () => statuses.includes("idle"), 5000, "run_status idle");
    off();
    assert.ok(statuses.includes("running"), `statuses were ${statuses.join(",")}`);
  });

  it("gives the model the matching passage of the user's own document, and saves its page as a citation", async () => {
    const app = await appPromise();
    const user = await createTestUser("bg_docs");
    const conv = await newChat(app, user, `conv_bgdoc_${Date.now()}`);

    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.TimesRoman);
    pdf.addPage().drawText("Cover page of the file.", { x: 50, y: 700, size: 12, font });
    pdf.addPage().drawText("The applicant claims parity with the co-accused who were granted bail on 12 November.", { x: 50, y: 700, size: 12, font, maxWidth: 480 });
    const form = new FormData();
    form.append("file", new File([new Uint8Array(await pdf.save())], "order.pdf", { type: "application/pdf" }));
    const up = await app.request("/api/vakils/soli_master/files", { method: "POST", headers: { Authorization: user.headers.Authorization }, body: form });
    const file = (await up.json()).files[0];
    assert.equal(file.index.status, "ready");

    mock.requests.length = 0;
    await app.request(
      "/api/agent/message",
      post(user, { vakilId: "soli_master", text: "What does the applicant say about parity with the co-accused?", conversationId: conv, attachments: [file], background: true }),
    );
    const list = await waitFor(async () => {
      const m = await messages(app, user, conv);
      return m.length === 2 ? m : undefined;
    }, 20000, "the answer");

    // The model was handed the passage, labelled, with its page.
    const prompt = mock.requests.at(-1)!;
    assert.match(prompt.system, /\[D1\] order\.pdf, page 2/);
    assert.match(prompt.system, /parity with the co-accused who were granted bail/);
    assert.doesNotMatch(prompt.system, /USER UPLOADED ATTACHMENT CONTEXT/, "an indexed file is searched, not pasted whole");

    // And the user is shown exactly that source, with the page.
    const citation = list[1].citations?.find((c) => c.kind === "document");
    assert.ok(citation, "the answer carries a document citation");
    assert.equal(citation.name, "order.pdf");
    assert.equal(citation.page, 2);
    assert.equal(citation.fileId, file.id);
  });

  it("keeps what was written when the user presses Stop", async () => {
    const app = await appPromise();
    const user = await createTestUser("bg_stop");
    const conv = await newChat(app, user, `conv_bgstop_${Date.now()}`);
    await app.request("/api/agent/message", post(user, { vakilId: "soli_master", text: "SLOW answer please", conversationId: conv, background: true }));

    // Wait until a few words are being written, then stop.
    const { runningFor } = await import("../src/services/agent/runtime.js");
    await waitFor(async () => runningFor(user.id)[conv] === "running", 8000, "the run to start");
    await sleep(700);
    const stop = await app.request("/api/agent/abort", post(user, { vakilId: "soli_master", conversationId: conv }));
    assert.equal((await stop.json()).aborted, true);

    const list = await waitFor(async () => {
      const m = await messages(app, user, conv);
      return m.length === 2 ? m : undefined;
    }, 8000, "the partial answer to be saved");
    assert.match(list[1].text, /word0/);
    assert.doesNotMatch(list[1].text, /word39/, "it stopped before the end");
    await waitFor(async () => runningFor(user.id)[conv] === undefined, 5000, "the run to be idle");
  });

  it("lets two chats answer at the same time, and only the chat being stopped is stopped", async () => {
    const app = await appPromise();
    const { runningFor } = await import("../src/services/agent/runtime.js");
    const user = await createTestUser("bg_two");
    const a = await newChat(app, user, `conv_bga_${Date.now()}`);
    const b = await newChat(app, user, `conv_bgb_${Date.now()}`);
    await app.request("/api/agent/message", post(user, { vakilId: "soli_master", text: "SLOW first", conversationId: a, background: true }));
    await app.request("/api/agent/message", post(user, { vakilId: "soli_master", text: "SLOW second", conversationId: b, background: true }));
    await waitFor(async () => Object.keys(runningFor(user.id)).length === 2, 8000, "both runs");

    await app.request("/api/agent/abort", post(user, { vakilId: "soli_master", conversationId: a }));
    const finished = await waitFor(async () => {
      const m = await messages(app, user, b);
      return m.length === 2 && /word39/.test(m[1].text) ? m : undefined;
    }, 20000, "the other chat to finish its full answer");
    assert.match(finished[1].text, /word39/, "chat B was not cancelled by stopping chat A");
  });

  it("makes a third simultaneous answer wait its turn, then runs it", async () => {
    const app = await appPromise();
    const { runningFor } = await import("../src/services/agent/runtime.js");
    const user = await createTestUser("bg_queue");
    const chats = await Promise.all([1, 2, 3].map((n) => newChat(app, user, `conv_bgq${n}_${Date.now()}`)));
    for (const [i, id] of chats.entries()) {
      await app.request("/api/agent/message", post(user, { vakilId: "soli_master", text: `SLOW number ${i}`, conversationId: id, background: true }));
    }
    const phases = Object.values(runningFor(user.id));
    assert.equal(phases.filter((p) => p === "running").length, 2, "two run at once (the per-user limit)");
    assert.equal(phases.filter((p) => p === "queued").length, 1, "the third waits");

    for (const id of chats) {
      await waitFor(async () => {
        const m = await messages(app, user, id);
        return m.length === 2 && /word39/.test(m[1].text) ? true : undefined;
      }, 40000, `chat ${id} to finish`);
    }
  });
});

describe("the run queue", () => {
  it("respects the total and per-user limits and starts waiting work in order", async () => {
    const queue = new RunQueue(2, 1);
    const started: string[] = [];
    const gates = new Map<string, () => void>();
    const task = (name: string) => () =>
      new Promise<void>((resolve) => {
        started.push(name);
        gates.set(name, resolve);
      });

    const a1 = queue.run("a", task("a1"));
    const a2 = queue.run("a", task("a2")); // same user: waits for a1
    const b1 = queue.run("b", task("b1"));
    const c1 = queue.run("c", task("c1")); // total limit (2) reached: waits
    await sleep(20);
    assert.deepEqual(started, ["a1", "b1"]);
    assert.equal(queue.wouldWait("d"), true);

    gates.get("a1")!();
    await sleep(20);
    assert.deepEqual(started, ["a1", "b1", "a2"], "a's next task starts first (oldest waiting)");
    gates.get("b1")!();
    await sleep(20);
    assert.deepEqual(started, ["a1", "b1", "a2", "c1"]);
    gates.get("a2")!();
    gates.get("c1")!();
    await Promise.all([a1, a2, b1, c1]);
    assert.equal(queue.wouldWait("a"), false);
  });
});
