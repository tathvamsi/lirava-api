process.env.NODE_ENV = "test";

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import app from "../src/index.js";
import { createTestUser, type TestUser } from "./helpers.js";
import { deleteConversation, getConversation } from "../src/services/chats/store.js";
import { getSnapshot } from "../src/services/repo/index.js";

const send = (user: TestUser, method: string, path: string, body?: unknown) =>
  app.request(path, { method, headers: user.headers, body: body === undefined ? undefined : JSON.stringify(body) });

describe("pinned and archived chats are stored with the chat", () => {
  let alice: TestUser;
  let bob: TestUser;
  const conv = `conv_flags_${Date.now()}`;

  before(async () => {
    alice = await createTestUser("flags_alice");
    bob = await createTestUser("flags_bob");
    assert.equal((await send(alice, "POST", "/api/conversations", { vakilId: "soli_master", id: conv, title: "Flags" })).status, 200);
  });
  after(async () => {
    await deleteConversation(conv, alice.id).catch(() => undefined);
  });

  it("starts unpinned and unarchived, and each flag can be switched on and off", async () => {
    const before = await getConversation(conv, alice.id);
    assert.equal(before?.pinned, false);
    assert.equal(before?.archived, false);

    const pinned = await (await send(alice, "PATCH", `/api/conversations/${conv}`, { pinned: true })).json();
    assert.equal(pinned.conversation.pinned, true);
    assert.equal(pinned.conversation.archived, false, "the other flag is untouched");

    const both = await (await send(alice, "PATCH", `/api/conversations/${conv}`, { archived: true })).json();
    assert.equal(both.conversation.pinned, true);
    assert.equal(both.conversation.archived, true);

    const off = await (await send(alice, "PATCH", `/api/conversations/${conv}`, { pinned: false, archived: false })).json();
    assert.equal(off.conversation.pinned, false);
    assert.equal(off.conversation.archived, false);
  });

  it("does not count as activity, so a pin never reorders the list by recency", async () => {
    const first = await getConversation(conv, alice.id);
    await new Promise((r) => setTimeout(r, 20));
    await send(alice, "PATCH", `/api/conversations/${conv}`, { pinned: true });
    assert.equal((await getConversation(conv, alice.id))?.updatedAt, first?.updatedAt);
  });

  it("belongs to the chat's owner, and comes with the snapshot", async () => {
    assert.equal((await send(bob, "PATCH", `/api/conversations/${conv}`, { pinned: false })).status, 404);
    assert.equal((await getConversation(conv, alice.id))?.pinned, true, "Bob changed nothing");
    const snapshot = await getSnapshot(alice.id);
    assert.equal(snapshot.conversations.find((c) => c.id === conv)?.pinned, true);
    assert.equal((await getSnapshot(bob.id)).conversations.some((c) => c.id === conv), false);
  });
});

describe("per-user preferences (read marks, preview width)", () => {
  let alice: TestUser;
  let bob: TestUser;
  before(async () => {
    alice = await createTestUser("pref_alice");
    bob = await createTestUser("pref_bob");
  });

  it("starts empty, saves valid values, and returns them with the snapshot", async () => {
    assert.deepEqual((await (await send(alice, "GET", "/api/preferences")).json()).preferences, {});
    assert.equal((await send(alice, "PUT", "/api/preferences/lastRead", { value: { soli_master: 1700000000000, nyaya: 1700000000500 } })).status, 200);
    assert.equal((await send(alice, "PUT", "/api/preferences/artifactBoardWidth", { value: 640 })).status, 200);

    const prefs = (await (await send(alice, "GET", "/api/preferences")).json()).preferences;
    assert.deepEqual(prefs.lastRead, { soli_master: 1700000000000, nyaya: 1700000000500 });
    assert.equal(prefs.artifactBoardWidth, 640);
    assert.deepEqual((await getSnapshot(alice.id)).preferences, prefs);

    // Saving again replaces, it does not add a second copy.
    await send(alice, "PUT", "/api/preferences/artifactBoardWidth", { value: 700 });
    assert.equal((await (await send(alice, "GET", "/api/preferences")).json()).preferences.artifactBoardWidth, 700);
  });

  it("never shows one person's preferences to another", async () => {
    assert.deepEqual((await (await send(bob, "GET", "/api/preferences")).json()).preferences, {});
    assert.deepEqual((await getSnapshot(bob.id)).preferences, {});
  });

  it("saves the document language, returns it with the snapshot, and clears it with null", async () => {
    assert.equal((await send(alice, "PUT", "/api/preferences/documentLanguage", { value: "kn" })).status, 200);
    assert.equal((await (await send(alice, "GET", "/api/preferences")).json()).preferences.documentLanguage, "kn");
    assert.equal((await getSnapshot(alice.id)).preferences?.documentLanguage, "kn");
    assert.equal((await getSnapshot(bob.id)).preferences?.documentLanguage, undefined, "Bob never sees Alice's choice");

    assert.equal((await send(alice, "PUT", "/api/preferences/documentLanguage", { value: "klingon" })).status, 400, "not one of the six");
    assert.equal((await send(alice, "PUT", "/api/preferences/documentLanguage", { value: null })).status, 200, "null puts it back to not chosen");
    assert.equal((await (await send(alice, "GET", "/api/preferences")).json()).preferences.documentLanguage, undefined);
    assert.equal((await send(alice, "PUT", "/api/preferences/documentLanguage", { value: null })).status, 200, "clearing twice is harmless");
  });

  it("lets only the document language be cleared with null", async () => {
    assert.equal((await send(alice, "PUT", "/api/preferences/artifactBoardWidth", { value: null })).status, 400);
    assert.equal((await send(alice, "PUT", "/api/preferences/lastRead", { value: null })).status, 400);
  });

  it("refuses unknown keys and values that do not fit", async () => {
    assert.equal((await send(alice, "PUT", "/api/preferences/somethingElse", { value: 1 })).status, 404);
    assert.equal((await send(alice, "PUT", "/api/preferences/artifactBoardWidth", { value: 5 })).status, 400, "too narrow");
    assert.equal((await send(alice, "PUT", "/api/preferences/artifactBoardWidth", { value: "wide" })).status, 400);
    assert.equal((await send(alice, "PUT", "/api/preferences/lastRead", { value: { a: "yesterday" } })).status, 400);
    assert.equal((await send(alice, "PUT", "/api/preferences/lastRead", { value: [1, 2] })).status, 400);
    const tooMany = Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`v${i}`, i]));
    assert.equal((await send(alice, "PUT", "/api/preferences/lastRead", { value: tooMany })).status, 400);
    assert.equal((await app.request("/api/preferences")).status, 401);
    assert.equal((await app.request("/api/preferences/lastRead", { method: "PUT", body: "{}" })).status, 401);
  });
});
