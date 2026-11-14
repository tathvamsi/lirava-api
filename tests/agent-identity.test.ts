import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseVakilId } from "../src/services/agent/vakil-id.js";
import { agentRoutes } from "../src/routes/agent.routes.js";
import { conversationsRoutes } from "../src/routes/conversations.routes.js";
import { createTestUser } from "./helpers.js";

describe("vakil identifiers", () => {
  it("accepts a non-empty string and rejects everything else", () => {
    assert.equal(parseVakilId("vakil_123"), "vakil_123");
    assert.equal(parseVakilId("  soli_master "), "soli_master");
    assert.equal(parseVakilId(undefined), null);
    assert.equal(parseVakilId(" "), null);
    assert.equal(parseVakilId(123), null);
    assert.equal(parseVakilId({ id: "x" }), null);
  });

  it("stops a run at the abort endpoint, and rejects a missing id", async () => {
    const user = await createTestUser("identity");
    const ok = await agentRoutes.request("/abort", { method: "POST", headers: user.headers, body: JSON.stringify({ vakilId: "vakil_test" }) });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { success: true, aborted: false });
    const missing = await agentRoutes.request("/abort", { method: "POST", headers: user.headers, body: JSON.stringify({}) });
    assert.equal(missing.status, 400);
  });

  it("rejects an invalid id before looking up conversations or running anything", async () => {
    const user = await createTestUser("identity2");
    assert.equal((await conversationsRoutes.request("/?vakilId=%20", { headers: user.headers })).status, 400);
    const message = await agentRoutes.request("/message", { method: "POST", headers: user.headers, body: JSON.stringify({ vakilId: 5, text: "Hello" }) });
    assert.equal(message.status, 400);
    // The old names are gone: they are not understood any more.
    const old = await agentRoutes.request("/message", { method: "POST", headers: user.headers, body: JSON.stringify({ agentId: "x", dotId: "x", text: "Hello" }) });
    assert.equal(old.status, 400);
  });
});
