process.env.NODE_ENV = "test";

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { config } from "../src/config.js";
import { createTestUser, type TestUser } from "./helpers.js";

const DRAFT =
  "# IN THE COURT OF THE SESSIONS JUDGE, BIDAR\n\nBail Application No. [____] of 2025\n\nBETWEEN Ramesh Kumar ... Applicant AND State of Karnataka ... Respondent\n\n" +
  "APPLICATION UNDER SECTION 483 OF THE BHARATIYA NAGARIK SURAKSHA SANHITA, 2023\n\nMOST RESPECTFULLY SHEWETH:\n\n" +
  "1. That the applicant, Ramesh Kumar, was arrested on 15 August 2025 in connection with FIR No. 214/2025 of Bidar Town Police Station and has been in custody since.\n\n" +
  "2. That the applicant is innocent and has been falsely implicated.\n\nPRAYER\n\nIt is therefore prayed that this Hon'ble Court may be pleased to release the applicant on bail.\n\nPlace: Bidar\nDate: [____]\nAdvocate for the Applicant";

describe("drafting a bail petition", () => {
  let server: Server;
  let calls = 0;
  let lastUserMessage = "";
  let user: TestUser;

  before(async () => {
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        calls++;
        let stream = false;
        try {
          const body = JSON.parse(raw);
          const msgs = body.messages ?? [];
          lastUserMessage = String(msgs[msgs.length - 1]?.content ?? "");
          stream = body.stream === true;
        } catch {
          /* not JSON */
        }
        if (!stream) {
          res.setHeader("Content-Type", "application/json");
          return void res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: DRAFT }, finish_reason: "stop" }] }));
        }
        // The chat asks for a streamed answer: send the draft in a few chunks, then stop.
        res.setHeader("Content-Type", "text/event-stream");
        const chunk = (delta: object, finish: string | null) => `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
        for (let i = 0; i < DRAFT.length; i += 300) res.write(chunk({ content: DRAFT.slice(i, i + 300) }, null));
        res.write(chunk({}, "stop"));
        res.end("data: [DONE]\n\n");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    config.customLlmBaseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    user = await createTestUser("intake_flow");
  });
  after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it("asks for the name, court, case and custody first, without calling the model; then drafts from the reply", { timeout: 180000 }, async () => {
    const app = (await import("../src/index.js")).default;
    const { createMatter } = await import("../src/services/repo/index.js");
    const { createConversation } = await import("../src/services/chats/store.js");
    const matter = await createMatter({ userId: user.id, title: "State v. Ramesh Kumar" });
    const conv = await createConversation("soli_master", "Bail", user.id, `conv_intake_${Date.now()}`, matter.id);
    const send = async (text: string) => {
      const res = await app.request("/api/agent/message", { method: "POST", headers: user.headers, body: JSON.stringify({ vakilId: "soli_master", text, conversationId: conv.id }) });
      assert.equal(res.status, 200);
      return (await res.json()).assistantMessage.text as string;
    };

    // 1. The request alone: the checklist, and the model is not called.
    const before = calls;
    const first = await send("Draft the bail petition.");
    assert.ok(first.startsWith("Before I draft the bail application"), first.slice(0, 120));
    assert.match(first, /full name of the person/i);
    assert.match(first, /Which court/);
    assert.match(first, /what the case is about/);
    assert.match(first, /date of arrest/i);
    assert.equal(calls, before, "no model call was made to ask");

    // 2. The details: the draft is written at once, from the request and the details together.
    const details = "Ramesh Kumar s/o Mohan Kumar, 34. Sessions Court, Bidar. FIR No. 214/2025 of Bidar Town PS under Section 103 BNS: a quarrel at the bus stand. Arrested on 15 August 2025, still in custody. English.";
    const second = await send(details);
    assert.ok(!second.startsWith("Before I draft"), "no second checklist");
    assert.ok(calls > before, "the model wrote the draft");
    assert.match(lastUserMessage, /Draft the bail petition/);
    assert.match(lastUserMessage, /Ramesh Kumar s\/o Mohan Kumar/);
    assert.match(lastUserMessage, /FIR No\. 214\/2025/);
    assert.match(lastUserMessage, /Do not ask any question first/);

    // 3. The document is saved with a proper name, not a fragment of its first line.
    const list = await (await app.request("/api/artifacts", { headers: user.headers })).json();
    const titles = list.artifacts.map((a: { title: string }) => a.title);
    assert.ok(titles.some((t: string) => t === "IN THE COURT OF THE SESSIONS JUDGE, BIDAR" || /Application for Regular Bail/.test(t)), `titles: ${titles.join(" | ")}`);
    assert.ok(!titles.some((t: string) => /\.\.\.$|\[/.test(t)), "no cut-off or placeholder title");
  });

  it("a repeat of the request is asked about once more, then it is drafted anyway", { timeout: 180000 }, async () => {
    const app = (await import("../src/index.js")).default;
    const { createMatter } = await import("../src/services/repo/index.js");
    const { createConversation } = await import("../src/services/chats/store.js");
    const matter = await createMatter({ userId: user.id, title: "State v. Suresh" });
    const conv = await createConversation("soli_master", "Bail 2", user.id, `conv_intake2_${Date.now()}`, matter.id);
    const send = async (text: string) => {
      const res = await app.request("/api/agent/message", { method: "POST", headers: user.headers, body: JSON.stringify({ vakilId: "soli_master", text, conversationId: conv.id }) });
      return (await res.json()).assistantMessage.text as string;
    };
    const a = await send("Draft the bail petition.");
    assert.ok(a.startsWith("Before I draft"));
    const b = await send("Draft the bail petition.");
    assert.match(b, /I still need these details/);
    const c = await send("Draft the bail petition.");
    assert.ok(!/Please send:/.test(c), "after two asks the draft is written, with placeholders");
  });
});
