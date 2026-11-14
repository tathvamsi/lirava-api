import { registerUser } from "../src/services/auth/index.js";
import { getSql } from "../src/services/db/postgres.js";

export interface TestUser {
  id: string;
  email: string;
  token: string;
  headers: Record<string, string>;
}

let counter = 0;

/** Creates a real user + session (same path as signup) and returns ready-to-use auth headers. */
export async function createTestUser(label = "user"): Promise<TestUser> {
  const email = `test_${label}_${Date.now()}_${counter++}@example.com`;
  const result = await registerUser({ name: `Test ${label}`, email, password: "Password123!Secure" });
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
