process.env.NODE_ENV = "test";

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

// An isolated local folder, so the import test never touches real data.
const directory = mkdtempSync(path.join(tmpdir(), "lirava-admin-test-"));
process.env.LEGACY_DATA_DIR = directory;

// Loaded after the folder is set: static imports would run first and use the real ./.data folder.
const { default: app } = await import("../src/index.js");
const { createTestUser } = await import("./helpers.js");
const { pgData, importLegacyData } = await import("../src/services/data/pg.js");
const { logAuditEvent, listAuditLogs } = await import("../src/services/admin/audit-ledger.js");
const { getLegacyDb, getDb } = await import("../src/services/db/index.js");
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

describe("importing the old local admin settings", () => {
  after(async () => {
    const sql = await pgData();
    await sql`DELETE FROM app_models WHERE id = ${`model-old-${RUN}`}`;
    await sql`DELETE FROM app_nodes WHERE id = ${`node-old-${RUN}`}`;
    await sql`DELETE FROM app_api_keys WHERE id = ${`key-old-${RUN}`}`;
    await sql`DELETE FROM app_plugins_installed WHERE user_id = ${`user-old-${RUN}`}`;
    await sql`DELETE FROM app_connector_connections WHERE user_id = ${`user-old-${RUN}`}`;
    getDb().close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("copies models, nodes, API keys, plugins and connector state once, keeping secrets as hashes", async () => {
    const db = getDb();
    const now = new Date().toISOString();
    db.prepare("INSERT INTO admin_models (id, name, provider, gguf_file, quantization, context_window, disk_size_bytes, status, storage_path, temperature, top_p, created_at, updated_at) VALUES (?, 'Old model', 'llama.cpp', 'm.gguf', 'Q4', 4096, 10, 'ready', '/models/m.gguf', 0.2, 0.85, ?, ?)").run(`model-old-${RUN}`, now, now);
    db.prepare("INSERT INTO admin_inference_nodes (id, name, address, last_heartbeat_at, created_at) VALUES (?, 'Old node', '10.0.0.1:8080', ?, ?)").run(`node-old-${RUN}`, now, now);
    db.prepare("INSERT INTO admin_api_keys (id, organization_id, name, key_prefix, key_hash, scopes, created_at) VALUES (?, 'org-old', 'Old key', 'soli_live_ab', 'HASHONLY', 'chat', ?)").run(`key-old-${RUN}`, now);
    db.prepare("INSERT INTO plugins_installed (id, user_id, plugin_id, version, installed_at) VALUES (?, ?, 'hearing-prep', '1.0.0', ?)").run(`plug-old-${RUN}`, `user-old-${RUN}`, Date.now());
    db.prepare("INSERT INTO connector_connections (user_id, toolkit_slug, status, updated_at) VALUES (?, 'gmail', 'active', ?)").run(`user-old-${RUN}`, Date.now());
    assert.ok(getLegacyDb(), "the old file is found");

    await importLegacyData(true);
    const sql = await pgData();
    assert.equal((await sql`SELECT name FROM app_models WHERE id = ${`model-old-${RUN}`}`)[0].name, "Old model");
    assert.equal((await sql`SELECT address FROM app_nodes WHERE id = ${`node-old-${RUN}`}`)[0].address, "10.0.0.1:8080");
    assert.equal((await sql`SELECT key_hash FROM app_api_keys WHERE id = ${`key-old-${RUN}`}`)[0].key_hash, "HASHONLY");
    assert.equal((await sql`SELECT COUNT(*)::int AS n FROM app_plugins_installed WHERE user_id = ${`user-old-${RUN}`}`)[0].n, 1);
    assert.equal((await sql`SELECT status FROM app_connector_connections WHERE user_id = ${`user-old-${RUN}`}`)[0].status, "active");

    // A second run changes nothing (existing rows are never overwritten).
    await sql`UPDATE app_models SET name = 'Renamed in PostgreSQL' WHERE id = ${`model-old-${RUN}`}`;
    await importLegacyData(true);
    assert.equal((await sql`SELECT name FROM app_models WHERE id = ${`model-old-${RUN}`}`)[0].name, "Renamed in PostgreSQL");
  });
});
