import postgres from "postgres";
import { config } from "../../config.js";
import { getDb } from "./index.js";
import crypto from "node:crypto";
let sqlInstance = null;
function getSql() {
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
        });
        return sqlInstance;
    }
    catch (err) {
        console.error("[soli-backend] Failed to initialize Postgres client:", err);
        return null;
    }
}
// Ensure SQLite has fallback tables if Postgres is unavailable
function initSqliteAuthTables() {
    const db = getDb();
    db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
}
export async function findUserByEmail(email) {
    const normalizedEmail = email.trim().toLowerCase();
    const sql = getSql();
    if (sql) {
        try {
            const rows = await sql `
        SELECT id, name, email, password_hash, role, created_at, updated_at
        FROM users
        WHERE LOWER(email) = ${normalizedEmail}
        LIMIT 1
      `;
            if (rows.length > 0)
                return rows[0];
        }
        catch (err) {
            console.warn("[soli-backend] Postgres findUserByEmail failed, checking SQLite fallback:", err);
        }
    }
    // Fallback to SQLite
    initSqliteAuthTables();
    const db = getDb();
    const row = db.prepare("SELECT * FROM users WHERE LOWER(email) = ? LIMIT 1").get(normalizedEmail);
    if (!row)
        return null;
    return {
        id: row.id,
        name: row.name,
        email: row.email,
        password_hash: row.password_hash,
        role: row.role,
        created_at: new Date(row.created_at),
        updated_at: new Date(row.updated_at),
    };
}
export async function findUserById(id) {
    const sql = getSql();
    if (sql) {
        try {
            const rows = await sql `
        SELECT id, name, email, password_hash, role, created_at, updated_at
        FROM users
        WHERE id = ${id}
        LIMIT 1
      `;
            if (rows.length > 0)
                return rows[0];
        }
        catch (err) {
            console.warn("[soli-backend] Postgres findUserById failed, checking SQLite fallback:", err);
        }
    }
    // Fallback to SQLite
    initSqliteAuthTables();
    const db = getDb();
    const row = db.prepare("SELECT * FROM users WHERE id = ? LIMIT 1").get(id);
    if (!row)
        return null;
    return {
        id: row.id,
        name: row.name,
        email: row.email,
        password_hash: row.password_hash,
        role: row.role,
        created_at: new Date(row.created_at),
        updated_at: new Date(row.updated_at),
    };
}
export async function insertUser(user) {
    const id = user.id || crypto.randomUUID();
    const normalizedEmail = user.email.trim().toLowerCase();
    const sql = getSql();
    if (sql) {
        try {
            const rows = await sql `
        INSERT INTO users (id, name, email, password_hash, role, created_at, updated_at)
        VALUES (${id}, ${user.name.trim()}, ${normalizedEmail}, ${user.passwordHash}, ${user.role}, NOW(), NOW())
        RETURNING id, name, email, password_hash, role, created_at, updated_at
      `;
            if (rows.length > 0)
                return rows[0];
        }
        catch (err) {
            console.warn("[soli-backend] Postgres insertUser failed, falling back to SQLite:", err);
        }
    }
    // Fallback to SQLite
    initSqliteAuthTables();
    const db = getDb();
    const now = Date.now();
    db.prepare(`
    INSERT INTO users (id, name, email, password_hash, role, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, user.name.trim(), normalizedEmail, user.passwordHash, user.role, now, now);
    return {
        id,
        name: user.name.trim(),
        email: normalizedEmail,
        password_hash: user.passwordHash,
        role: user.role,
        created_at: new Date(now),
        updated_at: new Date(now),
    };
}
export async function insertSession(session) {
    const id = session.id || crypto.randomUUID();
    const sql = getSql();
    if (sql) {
        try {
            const rows = await sql `
        INSERT INTO sessions (id, user_id, expires_at, created_at)
        VALUES (${id}, ${session.userId}, ${session.expiresAt}, NOW())
        RETURNING id, user_id, expires_at, created_at
      `;
            if (rows.length > 0)
                return rows[0];
        }
        catch (err) {
            console.warn("[soli-backend] Postgres insertSession failed, falling back to SQLite:", err);
        }
    }
    // Fallback to SQLite
    initSqliteAuthTables();
    const db = getDb();
    const now = Date.now();
    db.prepare(`
    INSERT INTO sessions (id, user_id, expires_at, created_at)
    VALUES (?, ?, ?, ?)
  `).run(id, session.userId, session.expiresAt.getTime(), now);
    return {
        id,
        user_id: session.userId,
        expires_at: session.expiresAt,
        created_at: new Date(now),
    };
}
export async function findValidSession(sessionId, userId) {
    const sql = getSql();
    if (sql) {
        try {
            const rows = await sql `
        SELECT 
          u.id, u.name, u.email, u.password_hash, u.role, u.created_at, u.updated_at,
          s.id AS session_id, s.expires_at AS session_expires_at, s.created_at AS session_created_at
        FROM users u
        INNER JOIN sessions s ON s.user_id = u.id
        WHERE s.id = ${sessionId} AND s.user_id = ${userId} AND s.expires_at > NOW()
        LIMIT 1
      `;
            if (rows.length > 0) {
                const r = rows[0];
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
                    session: {
                        id: r.session_id,
                        user_id: r.id,
                        expires_at: r.session_expires_at,
                        created_at: r.session_created_at,
                    },
                };
            }
        }
        catch (err) {
            console.warn("[soli-backend] Postgres findValidSession failed, checking SQLite fallback:", err);
        }
    }
    // Fallback to SQLite
    initSqliteAuthTables();
    const db = getDb();
    const now = Date.now();
    const row = db.prepare(`
    SELECT 
      u.id, u.name, u.email, u.password_hash, u.role, u.created_at, u.updated_at,
      s.id AS session_id, s.expires_at AS session_expires_at, s.created_at AS session_created_at
    FROM users u
    INNER JOIN sessions s ON s.user_id = u.id
    WHERE s.id = ? AND s.user_id = ? AND s.expires_at > ?
    LIMIT 1
  `).get(sessionId, userId, now);
    if (!row)
        return null;
    return {
        user: {
            id: row.id,
            name: row.name,
            email: row.email,
            password_hash: row.password_hash,
            role: row.role,
            created_at: new Date(row.created_at),
            updated_at: new Date(row.updated_at),
        },
        session: {
            id: row.session_id,
            user_id: row.id,
            expires_at: new Date(row.session_expires_at),
            created_at: new Date(row.session_created_at),
        },
    };
}
export async function deleteSession(sessionId) {
    const sql = getSql();
    if (sql) {
        try {
            await sql `DELETE FROM sessions WHERE id = ${sessionId}`;
        }
        catch (err) {
            console.warn("[soli-backend] Postgres deleteSession failed:", err);
        }
    }
    // Also clean SQLite if present
    try {
        initSqliteAuthTables();
        getDb().prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
    }
    catch { }
    return true;
}
export async function closeSql() {
    if (sqlInstance) {
        await sqlInstance.end();
        sqlInstance = null;
    }
}
