process.env.NODE_ENV = "test";

import assert from "node:assert/strict";
import test from "node:test";
import { getSql } from "../src/services/db/postgres.js";
import { withSchemaLock } from "../src/services/db/schema-lock.js";

test("schema setup run by many callers at once, in opposite orders, completes without deadlocking", async () => {
  const sql = getSql();
  assert.ok(sql, "needs DATABASE_URL");
  const a = `lock_test_a_${Date.now()}`;
  const b = `lock_test_b_${Date.now()}`;
  await sql.unsafe(`CREATE TABLE ${a} (id INT); CREATE TABLE ${b} (id INT)`);
  try {
    // Without the lock, half of these take table locks A-then-B and half B-then-A, and PostgreSQL aborts one
    // of them with "deadlock detected". With it they run one after another.
    const jobs = Array.from({ length: 12 }, (_, i) =>
      withSchemaLock(sql, async (tx) => {
        const [first, second] = i % 2 === 0 ? [a, b] : [b, a];
        await tx.unsafe(`ALTER TABLE ${first} ADD COLUMN IF NOT EXISTS c${i} INT`);
        await new Promise((r) => setTimeout(r, 30)); // hold the first lock while the others try for theirs
        await tx.unsafe(`ALTER TABLE ${second} ADD COLUMN IF NOT EXISTS c${i} INT`);
        return i;
      }),
    );
    const done = await Promise.all(jobs);
    assert.equal(done.length, 12);
    const cols = (await sql`SELECT COUNT(*)::int AS n FROM information_schema.columns WHERE table_name = ${a}`)[0].n;
    assert.equal(cols, 13, "every caller's change was applied exactly once");
  } finally {
    await sql.unsafe(`DROP TABLE IF EXISTS ${a}; DROP TABLE IF EXISTS ${b}`);
  }
});
