process.env.NODE_ENV = "test";

import assert from "node:assert/strict";
import test from "node:test";

const RUN = `${Date.now()}`;
const alice = `art_alice_${RUN}`;
const bob = `art_bob_${RUN}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("saved documents and matters are listed per user, and need an owner", async (t) => {
  const { listArtifacts, saveArtifact, listMatters, createMatter } = await import("../src/services/repo/index.js");
  const { pgData } = await import("../src/services/data/pg.js");
  t.after(async () => {
    const sql = await pgData();
    await sql`DELETE FROM app_artifacts WHERE user_id IN (${alice}, ${bob})`;
    await sql`DELETE FROM app_matters WHERE user_id IN (${alice}, ${bob})`;
  });

  const document = { vakilId: "fixture", title: "Test document", content: "Fixture only" };
  const a1 = await saveArtifact({ ...document, userId: alice, conversationId: "chat_alice" });
  await sleep(5);
  const a2 = await saveArtifact({ ...document, userId: alice });
  const b1 = await saveArtifact({ ...document, userId: bob });

  assert.deepEqual((await listArtifacts(alice)).map((x) => x.id), [a2.id, a1.id], "newest first, only Alice's");
  assert.deepEqual((await listArtifacts(alice, { agentOnly: true })).map((x) => x.id), [a1.id], "agent documents are those saved from a chat");
  assert.deepEqual((await listArtifacts(bob)).map((x) => x.id), [b1.id]);
  assert.deepEqual(await listArtifacts("unknown-user"), []);
  assert.deepEqual(await listArtifacts(""), [], "no user, no documents");

  // Nothing is ever stored without an owner.
  await assert.rejects(saveArtifact({ ...document, userId: "" }), /owner/);

  const m = await createMatter({ userId: alice, title: "Alice matter", client: "C", notes: "n" });
  assert.equal(m.userId, alice);
  assert.deepEqual((await listMatters(alice)).map((x) => x.id), [m.id]);
  assert.deepEqual(await listMatters(bob), []);
  await assert.rejects(createMatter({ userId: "", title: "Orphan" }), /owner/);
});

test("the built-in Vakils are present, shared, and listed first", async () => {
  const { listVakils, getVakilForUser, deleteVakil } = await import("../src/services/repo/index.js");
  const vakils = await listVakils(`someone_${RUN}`);
  assert.deepEqual(vakils.slice(0, 5).map((d) => d.id), ["soli_master", "nyaya", "vakil", "pramaan", "docket"]);
  assert.ok(await getVakilForUser("vakil", `someone_${RUN}`), "shared agents are visible to everyone");
  assert.equal(await deleteVakil("vakil", `someone_${RUN}`), false, "and cannot be deleted by a user");
});
