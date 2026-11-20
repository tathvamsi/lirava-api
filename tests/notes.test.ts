process.env.NODE_ENV = "test";

import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import app from "../src/index.js";
import { createTestUser, type TestUser } from "./helpers.js";
import { createMatter } from "../src/services/repo/index.js";

const json = (user: TestUser, method: string, body?: unknown) => ({ method, headers: user.headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

describe("notes", () => {
  let alice: TestUser;
  let bob: TestUser;
  before(async () => {
    alice = await createTestUser("note_alice");
    bob = await createTestUser("note_bob");
  });

  it("creates, lists with a preview, reads, edits and deletes a note", async () => {
    const created = await app.request("/api/notes", json(alice, "POST", { title: "  Hearing   prep ", content: "# Points\n\n**Bail** under Section 483 BNSS" }));
    assert.equal(created.status, 201);
    const note = (await created.json()).note;
    assert.equal(note.title, "Hearing prep");
    assert.equal(note.matterId, null);

    const list = (await (await app.request("/api/notes", json(alice, "GET"))).json()).notes;
    assert.equal(list.length, 1);
    assert.equal(list[0].id, note.id);
    assert.equal(list[0].preview, "Points Bail under Section 483 BNSS");
    assert.equal(list[0].content, undefined, "the list does not carry whole notes");

    assert.equal((await (await app.request(`/api/notes/${note.id}`, json(alice, "GET"))).json()).note.content, "# Points\n\n**Bail** under Section 483 BNSS");

    const edited = await app.request(`/api/notes/${note.id}`, json(alice, "PUT", { content: "Changed" }));
    const after = (await edited.json()).note;
    assert.equal(after.content, "Changed");
    assert.equal(after.title, "Hearing prep", "a field that was not sent is left alone");

    assert.equal((await app.request(`/api/notes/${note.id}`, json(alice, "DELETE"))).status, 200);
    assert.equal((await app.request(`/api/notes/${note.id}`, json(alice, "GET"))).status, 404);
  });

  it("keeps notes private to their owner", async () => {
    const note = (await (await app.request("/api/notes", json(alice, "POST", { title: "Private", content: "secret" }))).json()).note;
    assert.equal((await app.request(`/api/notes/${note.id}`, json(bob, "GET"))).status, 404);
    assert.equal((await app.request(`/api/notes/${note.id}`, json(bob, "PUT", { content: "x" }))).status, 404);
    assert.equal((await app.request(`/api/notes/${note.id}`, json(bob, "DELETE"))).status, 404);
    assert.equal((await (await app.request("/api/notes", json(bob, "GET"))).json()).notes.length, 0);
    assert.equal((await (await app.request(`/api/notes/${note.id}`, json(alice, "GET"))).json()).note.content, "secret", "still there for its owner");
  });

  it("ties a note to the user's own matter only, and filters by matter", async () => {
    const matter = await createMatter({ userId: alice.id, title: "Rajesh v. State" });
    const tied = (await (await app.request("/api/notes", json(alice, "POST", { title: "In matter", content: "a", matterId: matter.id }))).json()).note;
    assert.equal(tied.matterId, matter.id);

    const filtered = (await (await app.request(`/api/notes?matterId=${matter.id}`, json(alice, "GET"))).json()).notes;
    assert.deepEqual(filtered.map((n: { id: string }) => n.id), [tied.id]);

    // Someone else's matter looks like one that does not exist.
    assert.equal((await app.request("/api/notes", json(bob, "POST", { title: "Sneaky", content: "b", matterId: matter.id }))).status, 404);
    assert.equal((await app.request(`/api/notes/${tied.id}`, json(alice, "PUT", { matterId: "no-such-matter" }))).status, 404);
    // And a note can be detached again.
    const detached = (await (await app.request(`/api/notes/${tied.id}`, json(alice, "PUT", { matterId: null }))).json()).note;
    assert.equal(detached.matterId, null);
  });

  it("rejects text that is not text", async () => {
    assert.equal((await app.request("/api/notes", json(alice, "POST", { title: 5, content: "x" }))).status, 400);
    assert.equal((await app.request("/api/notes", json(alice, "POST", { title: "ok", content: { a: 1 } }))).status, 400);
  });
});
