process.env.NODE_ENV = "test";

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config.js";
import { startMockLlm, type MockLlm } from "./mock-llm.js";
import { createTestUser, type TestUser } from "./helpers.js";

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
type Cite = { kind: string; label: string; title?: string; nodeId?: string; section?: string };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const post = (user: TestUser, body: unknown) => ({ method: "POST", headers: user.headers, body: JSON.stringify(body) });

async function messages(app: App, user: TestUser, convId: string) {
  const body = await (await app.request(`/api/conversations/${convId}`, { headers: user.headers })).json();
  return body.messages as Array<{ role: string; text: string; citations?: Cite[] | null }>;
}

async function answerTo(app: App, user: TestUser, conv: string, text: string, expectedMessages: number) {
  await app.request("/api/agent/message", post(user, { vakilId: "soli_master", text, conversationId: conv, background: true }));
  const end = Date.now() + 30000;
  while (Date.now() < end) {
    const list = await messages(app, user, conv);
    if (list.length >= expectedMessages) return list;
    await sleep(300);
  }
  throw new Error("the answer did not arrive");
}

describe("the case tree as a source of an answer", () => {
  it("labels confirmed tree entries for the model, and shows only the ones the answer cites", { timeout: 120000 }, async () => {
    const app = await appPromise();
    const user = await createTestUser("tree_cite");
    const made = await app.request("/api/matters", post(user, { title: "Manjunath Gowda v. Yet to Know" }));
    const { matter } = (await made.json()) as { matter: { id: string } };
    const nodes = `/api/matters/${matter.id}/nodes`;
    const tree = (await (await app.request(nodes, { headers: user.headers })).json()) as { nodes: Array<{ id: string; kind: string; title: string }> };
    const parties = tree.nodes.find((n) => n.kind === "section" && n.title === "Parties")!;
    const client = (await (await app.request(nodes, post(user, { kind: "party", title: "Client: Asha Rao", parentId: parties.id }))).json()) as { node: { id: string } };
    await app.request(nodes, post(user, { kind: "party", title: "Opposite party: Yet to know", parentId: parties.id }));

    const conv = `conv_treecite_${Date.now()}`;
    const created = await app.request("/api/conversations", post(user, { vakilId: "soli_master", id: conv, matterId: matter.id }));
    assert.equal(created.status, 200);

    // 1. The model is given labelled entries, and a placeholder is not passed on as a name.
    mock.requests.length = 0;
    const first = await answerTo(app, user, conv, "TREECITE who is the client?", 2);
    const system = mock.requests.at(-1)!.system;
    assert.match(system, /\[T1\] Parties — Client: Asha Rao/);
    assert.match(system, /Opposite party: not recorded/);
    // (The matter's own title, "… v. Yet to Know", is the lawyer's name for the case and stays in the matter block.)
    const treeBlock = system.slice(system.indexOf("CASE KNOWLEDGE TREE"), system.indexOf("CURRENT MATTER CONTEXT"));
    assert.ok(treeBlock.length > 0, "the tree block is in the prompt");
    assert.doesNotMatch(treeBlock, /Yet to know/i, "the placeholder is never shown to the model as a fact");
    assert.match(system, /cite the label in square brackets/i);

    // 2. The answer cited [T1], so exactly that entry is a source; the unused entry is not.
    const cites = first[1].citations ?? [];
    const tree1 = cites.filter((c) => c.kind === "case");
    assert.deepEqual(tree1.map((c) => c.label), ["T1"], "only the cited tree entry is kept");
    assert.equal(tree1[0].title, "Client: Asha Rao");
    assert.equal(tree1[0].section, "Parties");
    assert.equal(tree1[0].nodeId, client.node.id);

    // 3. An answer that cites no tree entry carries none, even though the model was given some.
    const second = await answerTo(app, user, conv, "What happened at the hearing?", 4);
    const later = second[3].citations ?? [];
    assert.equal(later.some((c) => c.kind === "case"), false, "uncited tree entries are not listed as sources");
  });
});
