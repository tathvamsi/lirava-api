process.env.NODE_ENV = "test";

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

const { default: app } = await import("../src/index.js");
const { createTestUser } = await import("./helpers.js");
const { pgData } = await import("../src/services/data/pg.js");
const { logAuditEvent, listAuditLogs } = await import("../src/services/admin/audit-ledger.js");
import type { TestUser } from "./helpers.js";

const RUN = Date.now();

describe("plugin settings (PostgreSQL)", () => {
  let alice: TestUser;
  let bob: TestUser;
  before(async () => {
    alice = await createTestUser("plug_alice");
    bob = await createTestUser("plug_bob");
  });

  it("installs a plugin once per user, lists it, and lets only its owner switch it off", async () => {
    const post = (u: TestUser, body: unknown) => app.request("/api/plugins", { method: "POST", headers: u.headers, body: JSON.stringify(body) });

    const first = await post(alice, { pluginId: "hearing-prep" });
    assert.equal(first.status, 201);
    const installed = (await first.json()).installed;
    assert.equal(installed.enabled, 1);

    const again = await post(alice, { pluginId: "hearing-prep" });
    assert.equal(again.status, 200, "installing it again is not an error");
    assert.equal((await again.json()).installed.id, installed.id, "and does not create a second copy");
    assert.equal((await post(alice, { pluginId: "no-such-plugin" })).status, 400);

    const list = await (await app.request("/api/plugins", { headers: alice.headers })).json();
    assert.equal(list.installed.length, 1);
    assert.deepEqual((await (await app.request("/api/plugins", { headers: bob.headers })).json()).installed, [], "Bob has none");

    const patch = (u: TestUser) => app.request(`/api/plugins/${installed.id}`, { method: "PATCH", headers: u.headers, body: JSON.stringify({ enabled: false }) });
    assert.equal((await patch(bob)).status, 404, "another user cannot change it");
    assert.equal((await patch(alice)).status, 200);
    assert.equal((await (await app.request("/api/plugins", { headers: alice.headers })).json()).installed[0].enabled, 0);
    assert.equal((await app.request("/api/plugins")).status, 401);
  });
});

describe("audit log", () => {
  it("keeps secrets out of the ledger", async () => {
    const org = `org-test-${RUN}`;
    await logAuditEvent({
      actor_id: "a", actor_email: "a@example.com", actor_role: "admin", organization_id: org, action: "api_key.create",
      target_type: "api_key", target_id: "k1", status: "SUCCESS", ip_address: "1.2.3.4", user_agent: "test",
      details: JSON.stringify({ name: "key", secret: "soli_live_abc", password: "hunter2" }),
    });
    const [event] = await listAuditLogs(org);
    assert.ok(event);
    assert.doesNotMatch(event.details, /soli_live_abc|hunter2/);
    assert.match(event.details, /\[REDACTED\]/);
    const sql = await pgData();
    await sql`DELETE FROM app_audit_events WHERE organization_id = ${org}`;
  });
});
