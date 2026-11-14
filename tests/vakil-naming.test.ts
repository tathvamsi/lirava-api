process.env.NODE_ENV = "test";

import assert from "node:assert/strict";
import test from "node:test";
import { getSql } from "../src/services/db/postgres.js";
import { migrateVakilNaming } from "../src/services/db/migrate-naming.js";

test("data stored under the old dot/agent names is renamed to vakil, and running it again is harmless", async () => {
  const sql = getSql();
  assert.ok(sql, "needs DATABASE_URL");
  const schema = `naming_test_${Date.now()}`;

  // Everything happens in a throwaway schema inside a transaction that is rolled back at the end.
  class Rollback extends Error {}
  await assert.rejects(
    sql.begin(async (tx) => {
      await tx.unsafe(`CREATE SCHEMA ${schema}`);
      await tx.unsafe(`SET LOCAL search_path TO ${schema}`);
      await tx.unsafe(`
        CREATE TABLE app_agents (id TEXT PRIMARY KEY, name TEXT);
        CREATE INDEX app_agents_user_idx ON app_agents (name);
        CREATE TABLE chat_conversations (id TEXT PRIMARY KEY, dot_id TEXT NOT NULL);
        CREATE INDEX chat_conversations_user_dot_idx ON chat_conversations (dot_id);
        CREATE TABLE chat_messages (id TEXT PRIMARY KEY, dot_id TEXT NOT NULL, role TEXT NOT NULL);
        CREATE TABLE app_artifacts (id TEXT PRIMARY KEY, dot_id TEXT NOT NULL);
        CREATE TABLE app_files (id TEXT PRIMARY KEY, dot_id TEXT);
        INSERT INTO app_agents VALUES ('a1', 'My agent');
        INSERT INTO chat_conversations VALUES ('c1', 'a1');
        INSERT INTO chat_messages VALUES ('m1', 'a1', 'user'), ('m2', 'a1', 'dot');
        INSERT INTO app_artifacts VALUES ('x1', 'a1');
        INSERT INTO app_files VALUES ('f1', 'a1');`);

      await migrateVakilNaming(tx as unknown as typeof sql);
      await migrateVakilNaming(tx as unknown as typeof sql); // a second run changes nothing and does not fail

      const cols = async (t: string) => (await tx`SELECT column_name FROM information_schema.columns WHERE table_schema = ${schema} AND table_name = ${t}`).map((r) => r.column_name);
      assert.deepEqual((await cols("chat_conversations")).sort(), ["id", "vakil_id"]);
      assert.deepEqual((await cols("chat_messages")).sort(), ["id", "role", "vakil_id"]);
      assert.deepEqual((await cols("app_artifacts")).sort(), ["id", "vakil_id"]);
      assert.deepEqual((await cols("app_files")).sort(), ["id", "vakil_id"]);
      assert.deepEqual((await tx`SELECT name FROM app_vakils`).map((r) => r.name), ["My agent"], "the table was renamed with its rows");
      assert.equal((await tx`SELECT COUNT(*)::int AS n FROM information_schema.tables WHERE table_schema = ${schema} AND table_name = 'app_agents'`)[0].n, 0);
      assert.deepEqual((await tx`SELECT id, role FROM chat_messages ORDER BY id`).map((r) => `${r.id}:${r.role}`), ["m1:user", "m2:vakil"], "assistant messages now have the role vakil");
      assert.equal((await tx`SELECT vakil_id FROM chat_conversations`)[0].vakil_id, "a1", "values are kept");
      const indexes = (await tx`SELECT indexname FROM pg_indexes WHERE schemaname = ${schema}`).map((r) => r.indexname);
      assert.ok(indexes.includes("chat_conversations_user_vakil_idx") && indexes.includes("app_vakils_user_idx"), `indexes were renamed: ${indexes.join(",")}`);
      throw new Rollback("done");
    }),
    Rollback,
  );
});

test("a leftover old table (re-created by a server that was still running) is merged into the new one and removed", async () => {
  const sql = getSql();
  assert.ok(sql);
  const schema = `naming_test_both_${Date.now()}`;
  const table = (name: string) => `CREATE TABLE ${name} (id TEXT PRIMARY KEY, user_id TEXT NOT NULL DEFAULT '', name TEXT, purpose TEXT, instructions TEXT, look JSONB, status TEXT, local_access BOOLEAN, model TEXT, created_at BIGINT)`;

  class Rollback extends Error {}
  await assert.rejects(
    sql.begin(async (tx) => {
      await tx.unsafe(`CREATE SCHEMA ${schema}`);
      await tx.unsafe(`SET LOCAL search_path TO ${schema}`);
      await tx.unsafe(`${table("app_vakils")}; ${table("app_agents")};
        INSERT INTO app_vakils (id, user_id, name) VALUES ('mine', 'u1', 'Already migrated');
        INSERT INTO app_agents (id, user_id, name) VALUES ('mine', 'u1', 'Older copy'), ('late', 'u2', 'Written to the old table'), ('builtin', '', 'Shared built-in');`);

      await migrateVakilNaming(tx as unknown as typeof sql);

      const names = (await tx`SELECT id, name FROM app_vakils ORDER BY id`).map((r) => `${r.id}=${r.name}`);
      assert.deepEqual(names, ["late=Written to the old table", "mine=Already migrated"], "owned rows are kept, nothing is overwritten, shared built-ins are not copied");
      assert.equal((await tx`SELECT COUNT(*)::int AS n FROM information_schema.tables WHERE table_schema = ${schema} AND table_name = 'app_agents'`)[0].n, 0);
      throw new Rollback("done");
    }),
    Rollback,
  );
});
