process.env.NODE_ENV = "test";

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createTestUser } from "./helpers.js";

type Node = { id: string; kind: string; title: string; parentId: string | null; status: string; links: Array<{ to: string; relation: string }> };

describe("the case knowledge tree", () => {
  it("lets a lawyer build, link, edit and delete nodes, scoped to their own matter", async () => {
    const app = (await import("../src/index.js")).default;
    const alice = await createTestUser("tree_owner");
    const bob = await createTestUser("tree_other");
    const made = await app.request("/api/matters", { method: "POST", headers: alice.headers, body: JSON.stringify({ title: "State v. Rao" }) });
    const { matter } = (await made.json()) as { matter: { id: string } };
    const base = `/api/matters/${matter.id}/nodes`;
    const send = (path: string, user: typeof alice, method: string, body?: unknown) =>
      app.request(`${base}${path}`, { method, headers: user.headers, ...(body ? { body: JSON.stringify(body) } : {}) });

    // The starting sections appear on first use.
    const first = (await (await send("", alice, "GET")).json()) as { nodes: Node[] };
    const sections = first.nodes.filter((n) => n.kind === "section");
    assert.equal(sections.length, 8);
    const facts = sections.find((s) => s.title === "Facts")!;
    const issues = sections.find((s) => s.title === "Issues")!;

    const fact = (await (await send("", alice, "POST", { kind: "fact", title: "Client was at the office at 6 pm", parentId: facts.id })).json()) as { node: Node };
    const issue = (await (await send("", alice, "POST", { kind: "issue", title: "Is the arrest legal?", parentId: issues.id })).json()) as { node: Node };
    assert.equal(fact.node.status, "confirmed");

    // Link the fact to the issue; a link to itself is dropped.
    const linked = await send(`/${fact.node.id}`, alice, "PATCH", { links: [{ to: issue.node.id, relation: "supports" }, { to: fact.node.id, relation: "cites" }] });
    assert.equal(linked.status, 200);
    assert.deepEqual(((await linked.json()) as { node: Node }).node.links, [{ to: issue.node.id, relation: "supports" }]);

    // Bad input is refused.
    assert.equal((await send("", alice, "POST", { kind: "nonsense", title: "x" })).status, 400);
    assert.equal((await send("", alice, "POST", { kind: "fact", title: "x", parentId: "node_does_not_exist" })).status, 400);
    // A node cannot be moved under itself.
    assert.equal((await send(`/${issues.id}`, alice, "PATCH", { parentId: issue.node.id })).status, 404);

    // Someone else sees and changes nothing.
    assert.equal((await send("", bob, "GET")).status, 404);
    assert.equal((await send(`/${fact.node.id}`, bob, "PATCH", { title: "hijack" })).status, 404);
    assert.equal((await send(`/${fact.node.id}`, bob, "DELETE")).status, 404);

    // Deleting the issue removes it and the link that pointed at it, and keeps the fact.
    const del = await send(`/${issue.node.id}`, alice, "DELETE");
    assert.equal(del.status, 200);
    const after = ((await del.json()) as { nodes: Node[] }).nodes;
    assert.ok(!after.some((n) => n.id === issue.node.id));
    assert.deepEqual(after.find((n) => n.id === fact.node.id)!.links, []);

    // Importing from the papers is safe when nothing has been read yet.
    const imported = (await (await send("/import", alice, "POST")).json()) as { added: number };
    assert.equal(imported.added, 0);

    // Deleting the matter removes its tree.
    assert.equal((await app.request(`/api/matters/${matter.id}`, { method: "DELETE", headers: alice.headers })).status, 200);
  });
});
