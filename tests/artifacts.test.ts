import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

test("personal artifact lists exclude other users and unowned legacy documents", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "lirava-artifacts-test-"));
  process.env.DOTS_DATA_DIR = directory;
  const { getDb } = await import("../src/services/db/index.js");
  const { listArtifacts, saveArtifact } = await import("../src/services/repo/index.js");
  try {
    const document = { dotId: "fixture", title: "Test document", content: "Fixture only" };
    const alice = saveArtifact({ ...document, userId: "alice", conversationId: "chat_alice" });
    const aliceStandalone = saveArtifact({ ...document, userId: "alice" });
    const bob = saveArtifact({ ...document, userId: "bob" });
    saveArtifact(document);
    assert.deepEqual(listArtifacts("alice").map((artifact) => artifact.id), [aliceStandalone.id, alice.id]);
    assert.deepEqual(listArtifacts("alice", { agentOnly: true }).map((artifact) => artifact.id), [alice.id]);
    assert.notEqual(aliceStandalone.id, alice.id);
    assert.deepEqual(listArtifacts("bob").map((artifact) => artifact.id), [bob.id]);
    assert.deepEqual(listArtifacts("unknown"), []);
  } finally {
    getDb().close();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith("lirava-artifacts-test-"));
    rmSync(directory, { recursive: true });
  }
});
