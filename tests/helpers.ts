import { after } from "node:test";
import { registerUser } from "../src/services/auth/index.js";
import { getSql } from "../src/services/db/postgres.js";

export interface TestUser {
  id: string;
  email: string;
  token: string;
  headers: Record<string, string>;
}

let counter = 0;

// Scheduled automations a test creates belong to a throwaway user but live in the shared database. If they are left behind,
// the running server's scheduler later fires every one of them at the real model, day after day. So the users this test file
// creates are remembered, and their automations and runs are removed when the file ends.
const createdUserIds: string[] = [];
after(async () => {
  const sql = getSql();
  if (!sql || createdUserIds.length === 0) return;
  try {
    await sql`DELETE FROM automation_runs WHERE automation_id IN (SELECT id FROM automations WHERE user_id::text = ANY(${createdUserIds}))`;
    await sql`DELETE FROM automations WHERE user_id::text = ANY(${createdUserIds})`;
  } catch {
    /* the tables do not exist in a run that never used automations */
  }
});

/** Creates a real user + session (same path as signup) and returns ready-to-use auth headers. */
export async function createTestUser(label = "user"): Promise<TestUser> {
  const email = `test_${label}_${Date.now()}_${counter++}@example.com`;
  const result = await registerUser({ name: `Test ${label}`, email, password: "Password123!Secure" });
  createdUserIds.push(result.user.id);
  return {
    id: result.user.id,
    email,
    token: result.token,
    headers: { Authorization: `Bearer ${result.token}`, "Content-Type": "application/json" },
  };
}

/** A real user promoted to administrator in the database (roles are read fresh on every request). */
export async function createTestAdmin(label = "admin"): Promise<TestUser> {
  const user = await createTestUser(label);
  const sql = getSql();
  if (sql) await sql`UPDATE users SET role = 'admin' WHERE id = ${user.id}`;
  return user;
}
