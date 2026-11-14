process.env.NODE_ENV = "test";

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import app from "../src/index.js";
import { createTestUser, type TestUser } from "./helpers.js";
import { deleteConversation, getConversation, listConversations, listMessages } from "../src/services/chats/store.js";
import { getSnapshot } from "../src/services/repo/index.js";
import { eventVisibleTo } from "../src/routes/events.routes.js";

const json = (user: TestUser, body: unknown) => ({ method: "POST", headers: user.headers, body: JSON.stringify(body) });
const patch = (user: TestUser, body: unknown) => ({ method: "PATCH", headers: user.headers, body: JSON.stringify(body) });

describe("chat storage and per-user isolation (PostgreSQL)", () => {
  let alice: TestUser;
  let bob: TestUser;
  const aliceConv = `conv_iso_a_${Date.now()}`;

  before(async () => {
    alice = await createTestUser("alice");
    bob = await createTestUser("bob");
  });

  after(async () => {
    // Remove what these tests created. Deleting a conversation cascades to its messages.
    await deleteConversation(aliceConv, alice.id).catch(() => undefined);
    await deleteConversation(`${aliceConv}_spoof`, alice.id).catch(() => undefined);
  });

  it("rejects every chat endpoint without a valid session", async () => {
    for (const [method, path] of [
      ["GET", "/api/conversations"],
      ["POST", "/api/conversations"],
      ["GET", "/api/conversations/anything"],
      ["DELETE", "/api/conversations/anything"],
      ["POST", "/api/agent/message"],
      ["POST", "/api/agent/abort"],
      ["GET", "/api/events"],
      ["GET", "/api/snapshot"],
    ]) {
      const res = await app.request(path, { method, headers: { "Content-Type": "application/json" }, body: method === "POST" ? "{}" : undefined });
      assert.equal(res.status, 401, `${method} ${path} should require sign-in`);
    }
    const forged = await app.request("/api/conversations", { headers: { Authorization: "Bearer not-a-real-token" } });
    assert.equal(forged.status, 401);
  });

  it("stores a conversation and its messages in PostgreSQL for the signed-in user", async () => {
    const created = await app.request("/api/conversations", json(alice, { vakilId: "soli_master", title: "Alice bail research", id: aliceConv }));
    assert.equal(created.status, 200);
    assert.equal((await created.json()).conversation.userId, alice.id);

    // "Hello" is answered without the model, so this test never depends on the LLM being up.
    const sent = await app.request("/api/agent/message", json(alice, { vakilId: "soli_master", text: "Hello", conversationId: aliceConv }));
    assert.equal(sent.status, 200);

    const fetched = await app.request(`/api/conversations/${aliceConv}`, { headers: alice.headers });
    assert.equal(fetched.status, 200);
    const body = await fetched.json();
    assert.equal(body.messages.length, 2);
    assert.deepEqual(body.messages.map((m: any) => m.role), ["user", "vakil"]);
    assert.equal(body.messages[0].text, "Hello");

    // Read straight from the store (the Postgres tables), not through the HTTP layer.
    const direct = await listMessages(aliceConv, alice.id);
    assert.equal(direct.length, 2);
  });

  it("ignores a userId in the request body: the owner is always the session user", async () => {
    const res = await app.request("/api/conversations", json(alice, { vakilId: "soli_master", id: `${aliceConv}_spoof`, userId: bob.id }));
    assert.equal(res.status, 200);
    assert.equal((await res.json()).conversation.userId, alice.id);
    assert.equal(await getConversation(`${aliceConv}_spoof`, bob.id), null);
  });

  it("hides one user's conversation from another user on every operation", async () => {
    // Read
    assert.equal((await app.request(`/api/conversations/${aliceConv}`, { headers: bob.headers })).status, 404);
    // Rename
    assert.equal((await app.request(`/api/conversations/${aliceConv}`, patch(bob, { title: "hijacked" }))).status, 404);
    // Move to a matter / another agent
    assert.equal((await app.request(`/api/conversations/${aliceConv}/move`, json(bob, { targetVakilId: "nyaya" }))).status, 404);
    // Delete
    assert.equal((await app.request(`/api/conversations/${aliceConv}`, { method: "DELETE", headers: bob.headers })).status, 404);
    // Write a message into it
    const write = await app.request("/api/agent/message", json(bob, { vakilId: "soli_master", text: "Hello", conversationId: aliceConv }));
    assert.equal(write.status, 404);

    // Alice's chat is untouched.
    const still = await getConversation(aliceConv, alice.id);
    assert.ok(still);
    assert.equal(still.title, "Alice bail research");
    assert.equal((await listMessages(aliceConv, alice.id)).length, 2);
  });

  it("does not let another user claim an existing conversation id", async () => {
    const res = await app.request("/api/conversations", json(bob, { vakilId: "soli_master", id: aliceConv }));
    assert.equal(res.status, 409);
    assert.equal((await getConversation(aliceConv, alice.id))?.userId, alice.id);
  });

  it("never lists, snapshots or streams one user's chats to another user", async () => {
    const bobList = await (await app.request("/api/conversations", { headers: bob.headers })).json();
    assert.ok(!bobList.conversations.some((c: any) => c.id === aliceConv));

    const aliceList = await listConversations(alice.id);
    assert.ok(aliceList.some((c) => c.id === aliceConv));

    const bobSnapshot = await getSnapshot(bob.id);
    assert.ok(!bobSnapshot.conversations.some((c: any) => c.id === aliceConv));
    assert.ok(!bobSnapshot.messages.some((m: any) => m.conversationId === aliceConv));

    const aliceSnapshot = await getSnapshot(alice.id);
    assert.ok(aliceSnapshot.messages.some((m: any) => m.conversationId === aliceConv));

    // Live events: only addressed to their owner.
    const aliceMessage = { type: "message", userId: alice.id, data: {} };
    assert.equal(eventVisibleTo(aliceMessage, alice.id), true);
    assert.equal(eventVisibleTo(aliceMessage, bob.id), false);
    assert.equal(eventVisibleTo({ type: "message_delta", userId: alice.id }, bob.id), false);
    // An event with no owner and no shared-agent type is never broadcast.
    assert.equal(eventVisibleTo({ type: "message" }, bob.id), false);
    assert.equal(eventVisibleTo({ type: "vakil", vakilId: "vakil" }, bob.id), true);
  });

  it("only lets the owner delete a conversation, and deleting removes its messages", async () => {
    const id = `${aliceConv}_delete`;
    await app.request("/api/conversations", json(alice, { vakilId: "soli_master", id }));
    await app.request("/api/agent/message", json(alice, { vakilId: "soli_master", text: "Hello", conversationId: id }));

    assert.equal((await app.request(`/api/conversations/${id}`, { method: "DELETE", headers: bob.headers })).status, 404);
    assert.equal((await listMessages(id, alice.id)).length, 2);

    assert.equal((await app.request(`/api/conversations/${id}`, { method: "DELETE", headers: alice.headers })).status, 200);
    assert.equal(await getConversation(id, alice.id), null);
    assert.equal((await listMessages(id, alice.id)).length, 0);
  });
});
