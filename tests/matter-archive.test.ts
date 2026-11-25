process.env.NODE_ENV = "test";

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createTestUser } from "./helpers.js";

describe("archiving and deleting a matter", () => {
  it("archives, restores and deletes, and keeps other people's matters out of reach", async () => {
    const app = (await import("../src/index.js")).default;
    const alice = await createTestUser("matter_owner");
    const bob = await createTestUser("matter_other");

    const made = await app.request("/api/matters", { method: "POST", headers: alice.headers, body: JSON.stringify({ title: "Archive me" }) });
    assert.equal(made.status, 201);
    const { matter } = (await made.json()) as { matter: { id: string } };

    // Someone else can neither change nor delete it.
    const theirPatch = await app.request(`/api/matters/${matter.id}`, { method: "PATCH", headers: bob.headers, body: JSON.stringify({ status: "archived" }) });
    assert.equal(theirPatch.status, 404);
    const theirDelete = await app.request(`/api/matters/${matter.id}`, { method: "DELETE", headers: bob.headers });
    assert.equal(theirDelete.status, 404);

    const bad = await app.request(`/api/matters/${matter.id}`, { method: "PATCH", headers: alice.headers, body: JSON.stringify({ status: "nonsense" }) });
    assert.equal(bad.status, 400);

    const archived = await app.request(`/api/matters/${matter.id}`, { method: "PATCH", headers: alice.headers, body: JSON.stringify({ status: "archived" }) });
    assert.equal(archived.status, 200);
    assert.equal(((await archived.json()) as { matter: { status: string } }).matter.status, "archived");

    const restored = await app.request(`/api/matters/${matter.id}`, { method: "PATCH", headers: alice.headers, body: JSON.stringify({ status: "active" }) });
    assert.equal(((await restored.json()) as { matter: { status: string } }).matter.status, "active");

    const deleted = await app.request(`/api/matters/${matter.id}`, { method: "DELETE", headers: alice.headers });
    assert.equal(deleted.status, 200);
    const gone = await app.request(`/api/matters/${matter.id}`, { headers: alice.headers });
    assert.equal(gone.status, 404);
    const again = await app.request(`/api/matters/${matter.id}`, { method: "DELETE", headers: alice.headers });
    assert.equal(again.status, 404);
  });
});
