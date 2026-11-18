import postgres from "postgres";
import crypto from "node:crypto";
import { config } from "../../config.js";
let sqlInstance = null;
export function setSql(client) {
    sqlInstance = client;
}
export function getSql() {
    if (sqlInstance)
        return sqlInstance;
    if (!config.databaseUrl)
        return null;
    try {
        sqlInstance = postgres(config.databaseUrl, {
            max: config.nodeEnv === "production" ? 10 : 5,
            idle_timeout: 20,
            connect_timeout: 10,
            prepare: false,
            // "relation already exists, skipping" from CREATE ... IF NOT EXISTS is expected, not worth logging.
            onnotice: () => { },
        });
        return sqlInstance;
    }
    catch (err) {
        console.error("[soli-backend] Failed to initialize Postgres client:", err);
        return null;
    }
}
/** Users and sessions live only in PostgreSQL. If it cannot be reached that is an error, never a silent second store. */
function db() {
    const sql = getSql();
    if (!sql)
        throw new Error("DATABASE_URL is not configured. Users and sessions are stored in PostgreSQL.");
    return sql;
}
export async function findUserByEmail(email) {
    const rows = await db() `
    SELECT id, name, email, password_hash, role, created_at, updated_at
    FROM users WHERE LOWER(email) = ${email.trim().toLowerCase()} LIMIT 1`;
    return rows[0] ?? null;
}
export async function insertUser(user) {
    const rows = await db() `
    INSERT INTO users (id, name, email, password_hash, role, created_at, updated_at)
    VALUES (${user.id || crypto.randomUUID()}, ${user.name.trim()}, ${user.email.trim().toLowerCase()}, ${user.passwordHash}, ${user.role}, NOW(), NOW())
    RETURNING id, name, email, password_hash, role, created_at, updated_at`;
    return rows[0];
}
export async function insertSession(session) {
    const rows = await db() `
    INSERT INTO sessions (id, user_id, expires_at, created_at)
    VALUES (${session.id || crypto.randomUUID()}, ${session.userId}, ${session.expiresAt}, NOW())
    RETURNING id, user_id, expires_at, created_at`;
    return rows[0];
}
export async function findValidSession(sessionId, userId) {
    const rows = await db() `
    SELECT
      u.id, u.name, u.email, u.password_hash, u.role, u.created_at, u.updated_at,
      s.id AS session_id, s.expires_at AS session_expires_at, s.created_at AS session_created_at
    FROM users u
    INNER JOIN sessions s ON s.user_id = u.id
    WHERE s.id = ${sessionId} AND s.user_id = ${userId} AND s.expires_at > NOW()
    LIMIT 1`;
    const r = rows[0];
    if (!r)
        return null;
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
export async function deleteSession(sessionId) {
    await db() `DELETE FROM sessions WHERE id = ${sessionId}`;
    return true;
}
export async function closeSql() {
    if (sqlInstance) {
        await sqlInstance.end();
        sqlInstance = null;
    }
}
