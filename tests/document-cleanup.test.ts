process.env.NODE_ENV = "test";

import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import app from "../src/index.js";
import { createTestUser, type TestUser } from "./helpers.js";
import { createConversation, deleteConversation } from "../src/services/chats/store.js";
import { createMatter } from "../src/services/repo/index.js";
import { linkDocuments, listMatterDocuments } from "../src/services/documents/index.js";
import { deleteFilesForUser, getFileForUser } from "../src/services/files/index.js";

function upload(user: TestUser, name: string, text: string) {
  const form = new FormData();
  form.append("file", new File([text], name, { type: "text/plain" }));
  return { method: "POST", headers: { Authorization: user.headers.Authorization }, body: form };
}

describe("deleting a chat removes its own documents in one go and keeps the case's documents", () => {
  let alice: TestUser;
  let bob: TestUser;
  before(async () => {
    alice = await createTestUser("cleanup_alice");
    bob = await createTestUser("cleanup_bob");
  });

  async function addFile(user: TestUser, name: string, text: string): Promise<string> {
    const res = await app.request("/api/vakils/soli_master/files", upload(user, name, text));
    assert.equal(res.status, 200);
    return (await res.json()).files[0].id as string;
  }

  it("deletes every chat-only file with the chat and leaves a matter's file and other people's files", async () => {
    const matter = await createMatter({ userId: alice.id, title: "Cleanup matter" });
    const chat = await createConversation("soli_master", "Cleanup", alice.id, `conv_cleanup_${Date.now()}`);
    const matterChat = await createConversation("soli_master", "Cleanup matter chat", alice.id, `conv_cleanup_m_${Date.now()}`, matter.id);

    const own = [await addFile(alice, "a.txt", "first note about bail"), await addFile(alice, "b.txt", "second note about remand"), await addFile(alice, "c.txt", "third note about summons")];
    await linkDocuments(alice.id, own, chat.id, null);
    const kept = await addFile(alice, "matter.txt", "a document that belongs to the case");
    await linkDocuments(alice.id, [kept], matterChat.id, matter.id);
    const bobs = await addFile(bob, "bob.txt", "someone else's file");

    assert.equal(await deleteConversation(chat.id, alice.id), true);

    for (const id of own) assert.equal(await getFileForUser(id, alice.id), null, "the chat's own file is gone");
    assert.ok(await getFileForUser(kept, alice.id), "the case's file stays");
    assert.equal((await listMatterDocuments(alice.id, matter.id)).length, 1);
    assert.ok(await getFileForUser(bobs, bob.id), "another user's file is untouched");

    await deleteConversation(matterChat.id, alice.id).catch(() => undefined);
  });

  it("deleteFilesForUser only removes the caller's own files and handles an empty list", async () => {
    const mine = await addFile(alice, "mine.txt", "mine");
    const theirs = await addFile(bob, "theirs.txt", "theirs");
    assert.equal(await deleteFilesForUser([], alice.id), 0);
    assert.equal(await deleteFilesForUser([mine, theirs], alice.id), 1, "only the caller's file counts");
    assert.equal(await getFileForUser(mine, alice.id), null);
    assert.ok(await getFileForUser(theirs, bob.id), "the other user's file is still there");
  });
});
