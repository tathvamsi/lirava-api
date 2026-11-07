import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveAgentId } from "../src/services/agent/identity.js";
import { agentRoutes } from "../src/routes/agent.routes.js";
import { conversationsRoutes } from "../src/routes/conversations.routes.js";

describe("agent identifier compatibility", () => {
  it("accepts new and legacy identifiers without changing their values", () => {
    assert.equal(resolveAgentId("vakil_123", undefined), "vakil_123");
    assert.equal(resolveAgentId(undefined, "dot_123"), "dot_123");
    assert.equal(resolveAgentId("dot_123", "dot_123"), "dot_123");
  });

  it("rejects missing, invalid, or conflicting identifiers", () => {
    assert.equal(resolveAgentId(undefined, undefined), null);
    assert.equal(resolveAgentId(" ", undefined), null);
    assert.equal(resolveAgentId(123, undefined), null);
    assert.equal(resolveAgentId("vakil_1", "dot_1"), null);
  });

  it("accepts both agent and legacy names at the abort endpoint", async () => {
    for (const body of [{ agentId: "agent_test" }, { dotId: "dot_test" }]) {
      const response = await agentRoutes.request("/abort", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { success: true, aborted: false });
    }
  });

  it("rejects conflicting names before looking up conversations or running an agent", async () => {
    const response = await conversationsRoutes.request("/?agentId=agent_a&dotId=dot_b");
    assert.equal(response.status, 400);
    const message = await agentRoutes.request("/message", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: "agent_a", dotId: "dot_b", text: "Hello" }),
    });
    assert.equal(message.status, 400);
  });
});
