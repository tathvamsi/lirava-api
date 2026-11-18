import postgres from "postgres";
import crypto from "node:crypto";
import { config } from "../../config.js";

export interface UserRow {
  id: string;
  name: string;
  email: string;
  password_hash: string;
  role: "admin" | "user";
  created_at: Date;
  updated_at: Date;
}

export interface SessionRow {
  id: string;
  user_id: string;
  expires_at: Date;
  created_at: Date;
}

let sqlInstance: postgres.Sql | null = null;

export function setSql(client: postgres.Sql | null): void {
  sqlInstance = client;
}

export function getSql(): postgres.Sql | null {
  if (sqlInstance) return sqlInstance;
  if (!config.databaseUrl) return null;
  try {
    sqlInstance = postgres(config.databaseUrl, {
      max: config.nodeEnv === "production" ? 10 : 5,
      idle_timeout: 20,
      connect_timeout: 10,
      prepare: false,
      // "relation already exists, skipping" from CREATE ... IF NOT EXISTS is expected, not worth logging.
      onnotice: () => {},
    });
    return sqlInstance;
  } catch (err) {
    console.error("[soli-backend] Failed to initialize Postgres client:", err);
    return null;
  }
}

/** Users and sessions live only in PostgreSQL. If it cannot be reached that is an error, never a silent second store. */
function db(): postgres.Sql {
  const sql = getSql();
  if (!sql) throw new Error("DATABASE_URL is not configured. Users and sessions are stored in PostgreSQL.");
  return sql;
}

export async function findUserByEmail(email: string): Promise<UserRow | null> {
  const rows = await db()<UserRow[]>`
    SELECT id, name, email, password_hash, role, created_at, updated_at
    FROM users WHERE LOWER(email) = ${email.trim().toLowerCase()} LIMIT 1`;
  return rows[0] ?? null;
}

export async function insertUser(user: {
  id?: string;
  name: string;
  email: string;
  passwordHash: string;
  role: "admin" | "user";
}): Promise<UserRow> {
  const rows = await db()<UserRow[]>`
    INSERT INTO users (id, name, email, password_hash, role, created_at, updated_at)
    VALUES (${user.id || crypto.randomUUID()}, ${user.name.trim()}, ${user.email.trim().toLowerCase()}, ${user.passwordHash}, ${user.role}, NOW(), NOW())
    RETURNING id, name, email, password_hash, role, created_at, updated_at`;
  return rows[0];
}

export async function insertSession(session: { id?: string; userId: string; expiresAt: Date }): Promise<SessionRow> {
  const rows = await db()<SessionRow[]>`
    INSERT INTO sessions (id, user_id, expires_at, created_at)
    VALUES (${session.id || crypto.randomUUID()}, ${session.userId}, ${session.expiresAt}, NOW())
    RETURNING id, user_id, expires_at, created_at`;
  return rows[0];
}

export async function findValidSession(
  sessionId: string,
  userId: string,
): Promise<{ user: UserRow; session: SessionRow } | null> {
  const rows = await db()<(UserRow & { session_id: string; session_expires_at: Date; session_created_at: Date })[]>`
    SELECT
      u.id, u.name, u.email, u.password_hash, u.role, u.created_at, u.updated_at,
      s.id AS session_id, s.expires_at AS session_expires_at, s.created_at AS session_created_at
    FROM users u
    INNER JOIN sessions s ON s.user_id = u.id
    WHERE s.id = ${sessionId} AND s.user_id = ${userId} AND s.expires_at > NOW()
    LIMIT 1`;
  const r = rows[0];
  if (!r) return null;
  return {
    user: {
      id: r.id,
      name: r.name,
      email: r.email,
      password_hash: r.password_hash,
      role: r.role,
      created_at: r.created_at,
      updated_at: r.updated_at,
    },
    session: { id: r.session_id, user_id: r.id, expires_at: r.session_expires_at, created_at: r.session_created_at },
  };
}

export async function deleteSession(sessionId: string): Promise<boolean> {
  await db()`DELETE FROM sessions WHERE id = ${sessionId}`;
  return true;
}

export async function closeSql(): Promise<void> {
  if (sqlInstance) {
    await sqlInstance.end();
    sqlInstance = null;
  }
}
