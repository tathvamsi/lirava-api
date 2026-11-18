/**
 * Failed sign-in tracking, kept in PostgreSQL so it survives restarts and applies across instances.
 *
 *  - An (account, address) pair is blocked after PAIR_LIMIT failures: whoever keeps guessing is stopped.
 *  - An account is blocked for everyone only after the much higher EMAIL_LIMIT failures, which only a
 *    spread-out guessing campaign reaches. A single stranger therefore cannot lock the real owner out,
 *    because the owner signs in from a different address.
 *
 * If PostgreSQL cannot be reached the same limits are applied from memory.
 */
import { getSql } from "../db/postgres.js";
import { withSchemaLock } from "../db/schema-lock.js";
import { RateLimiter } from "../../middleware/security.js";
const WINDOW_MS = 15 * 60 * 1000;
const PAIR_LIMIT = 8;
const EMAIL_LIMIT = 40;
const memoryPair = new RateLimiter(PAIR_LIMIT, WINDOW_MS);
const memoryEmail = new RateLimiter(EMAIL_LIMIT, WINDOW_MS);
let ready = null;
async function table() {
    const sql = getSql();
    if (!sql)
        return null;
    if (!ready) {
        ready = withSchemaLock(sql, (tx) => tx.unsafe(`CREATE TABLE IF NOT EXISTS login_failures (
           email TEXT NOT NULL,
           ip    TEXT NOT NULL,
           at    BIGINT NOT NULL
         );
         CREATE INDEX IF NOT EXISTS login_failures_email_at_idx ON login_failures (email, at);`))
            .then(() => undefined)
            .catch((err) => {
            ready = null;
            throw err;
        });
    }
    await ready;
    return sql;
}
const pairKey = (email, ip) => `${email}|${ip}`;
export async function isLoginBlocked(email, ip) {
    try {
        const sql = await table();
        if (sql) {
            const since = Date.now() - WINDOW_MS;
            const [row] = await sql `
        SELECT COUNT(*) FILTER (WHERE ip = ${ip})::int AS pair, COUNT(*)::int AS email
        FROM login_failures WHERE email = ${email} AND at > ${since}`;
            return Number(row?.pair ?? 0) >= PAIR_LIMIT || Number(row?.email ?? 0) >= EMAIL_LIMIT;
        }
    }
    catch (err) {
        console.warn("[auth] login-attempt store unavailable, using memory:", err.message);
    }
    return memoryPair.isBlocked(pairKey(email, ip)).blocked || memoryEmail.isBlocked(email).blocked;
}
export async function recordLoginFailure(email, ip) {
    memoryPair.hit(pairKey(email, ip));
    memoryEmail.hit(email);
    try {
        const sql = await table();
        if (!sql)
            return;
        await sql `INSERT INTO login_failures (email, ip, at) VALUES (${email}, ${ip}, ${Date.now()})`;
        // Old rows are useless: tidy up now and then.
        if (Math.random() < 0.05)
            await sql `DELETE FROM login_failures WHERE at < ${Date.now() - WINDOW_MS}`;
    }
    catch (err) {
        console.warn("[auth] could not record failed sign-in:", err.message);
    }
}
/** A successful sign-in clears that address's failures for the account. */
export async function clearLoginFailures(email, ip) {
    memoryPair.reset(pairKey(email, ip));
    try {
        const sql = await table();
        if (sql)
            await sql `DELETE FROM login_failures WHERE email = ${email} AND ip = ${ip}`;
    }
    catch {
        // best effort
    }
}
