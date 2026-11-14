process.env.NODE_ENV = "test";

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

// An isolated local (SQLite) folder, so the import test never touches real data.
const directory = mkdtempSync(path.join(tmpdir(), "lirava-artifacts-test-"));
process.env.LEGACY_DATA_DIR = directory;

const RUN = `${Date.now()}`;
const alice = `art_alice_${RUN}`;
const bob = `art_bob_${RUN}`;
const legacyOwner = `art_legacy_${RUN}`;
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

test("existing local data is imported once, owned rows only, and the local file is left alone", async (t) => {
  const { getDb } = await import("../src/services/db/index.js");
  const { importLegacyData, pgData } = await import("../src/services/data/pg.js");
  const sql = await pgData();
  const db = getDb();
  t.after(async () => {
    await sql`DELETE FROM app_files WHERE user_id = ${legacyOwner}`;
    await sql`DELETE FROM app_artifacts WHERE user_id = ${legacyOwner}`;
    await sql`DELETE FROM app_matters WHERE user_id = ${legacyOwner}`;
    await sql`DELETE FROM app_vakils WHERE user_id = ${legacyOwner}`;
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const now = Date.now();
  // Owned rows
  db.prepare("INSERT INTO dots (id, name, purpose, instructions, look, status, user_id, created_at) VALUES (?, ?, '', '', ?, 'idle', ?, ?)").run(`dot_${RUN}`, "My agent", '{"color":"#111"}', legacyOwner, now);
  db.prepare("INSERT INTO matters (id, user_id, title, client, court, status, notes, created_at, updated_at) VALUES (?, ?, ?, '', '', 'active', '', ?, ?)").run(`matter_${RUN}`, legacyOwner, "Old matter", now, now);
  db.prepare("INSERT INTO artifacts (id, dot_id, conversation_id, title, kind, content, user_id, created_at, updated_at, filename) VALUES (?, 'x', NULL, ?, 'document', ?, ?, ?, ?, 'old.pdf')").run(`art_${RUN}`, "Old draft", "Old content", legacyOwner, now, now);
  mkdirSync(path.join(directory, "files"), { recursive: true });
  writeFileSync(path.join(directory, "files", `file_${RUN}`), Buffer.from("%PDF-1.4 old file"));
  db.prepare("INSERT INTO files (id, dot_id, name, size, type, mime, user_id, created_at) VALUES (?, 'x', 'old.pdf', 17, 'application/pdf', 'application/pdf', ?, ?)").run(`file_${RUN}`, legacyOwner, now);
  // Unowned rows: nobody can be said to own them
  db.prepare("INSERT INTO matters (id, user_id, title, client, court, status, notes, created_at, updated_at) VALUES (?, '', ?, '', '', 'active', '', ?, ?)").run(`matter_orphan_${RUN}`, "Orphan matter", now, now);

  const first = await importLegacyData(true);
  assert.deepEqual(first, { vakils: 1, matters: 1, artifacts: 1, files: 1 });
  assert.equal((await sql`SELECT title FROM app_matters WHERE id = ${`matter_${RUN}`}`)[0].title, "Old matter");
  assert.equal((await sql`SELECT COUNT(*)::int AS n FROM app_matters WHERE id = ${`matter_orphan_${RUN}`}`)[0].n, 0, "an unowned matter is not imported");
  const [file] = await sql`SELECT size, data FROM app_files WHERE id = ${`file_${RUN}`}`;
  assert.equal(Buffer.from(file.data as Uint8Array).toString(), "%PDF-1.4 old file", "the file's bytes came across");

  // Running it again adds nothing, and the local rows are still there.
  assert.deepEqual(await importLegacyData(true), { vakils: 0, matters: 0, artifacts: 0, files: 0 });
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM matters WHERE user_id = ?").get(legacyOwner) as { n: number }).n, 1);
  // And without force, the import has already been recorded as done.
  assert.equal(await importLegacyData(), null);
});

test("the built-in Vakils are present, shared, and listed first", async () => {
  const { listVakils, getVakilForUser, deleteVakil } = await import("../src/services/repo/index.js");
  const vakils = await listVakils(`someone_${RUN}`);
  assert.deepEqual(vakils.slice(0, 5).map((d) => d.id), ["soli_master", "nyaya", "vakil", "pramaan", "docket"]);
  assert.ok(await getVakilForUser("vakil", `someone_${RUN}`), "shared agents are visible to everyone");
  assert.equal(await deleteVakil("vakil", `someone_${RUN}`), false, "and cannot be deleted by a user");
});
