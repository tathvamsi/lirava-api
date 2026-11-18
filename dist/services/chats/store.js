/**
 * PostgreSQL chat storage.
 *
 * Every conversation and message row carries the owning `user_id`, and every
 * query below filters on it. A caller can only ever read or change rows that
 * belong to the user id it passes in, and that id must come from the verified
 * session (see middleware/auth.ts), never from the request body or query.
 */
import crypto from "node:crypto";
import { matterOwned, pgData } from "../data/pg.js";
import { getSql } from "../db/postgres.js";
import { emit } from "../bus/index.js";
import { deleteChatOnlyDocuments } from "../documents/index.js";
import { migrateVakilNaming } from "../db/migrate-naming.js";
import { withSchemaLock } from "../db/schema-lock.js";
export class ChatError extends Error {
    status;
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}
const SCHEMA = `
CREATE TABLE IF NOT EXISTS chat_conversations (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  vakil_id      TEXT NOT NULL,
  matter_id   TEXT,
  title       TEXT NOT NULL DEFAULT '',
  created_at  BIGINT NOT NULL,
  updated_at  BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS chat_conversations_user_idx ON chat_conversations (user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS chat_conversations_user_vakil_idx ON chat_conversations (user_id, vakil_id);

CREATE TABLE IF NOT EXISTS chat_messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES chat_conversations (id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL,
  vakil_id          TEXT NOT NULL,
  role            TEXT NOT NULL,
  text            TEXT NOT NULL DEFAULT '',
  title           TEXT,
  card            TEXT,
  source          TEXT,
  attachments     JSONB,
  artifact_id     TEXT,
  created_at      BIGINT NOT NULL
);
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS citations JSONB;
ALTER TABLE chat_conversations ADD COLUMN IF NOT EXISTS pinned BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE chat_conversations ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT FALSE;
-- Running summary of the older part of a long chat, so the model keeps the facts after old messages no longer fit.
ALTER TABLE chat_conversations ADD COLUMN IF NOT EXISTS summary TEXT;
ALTER TABLE chat_conversations ADD COLUMN IF NOT EXISTS summary_upto BIGINT NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS chat_messages_conv_idx ON chat_messages (conversation_id, created_at);
CREATE INDEX IF NOT EXISTS chat_messages_user_idx ON chat_messages (user_id, created_at DESC);
`;
let ready = null;
/** Returns the Postgres client once the chat tables exist. Throws if Postgres is not configured. */
async function pg() {
    const sql = getSql();
    if (!sql) {
        throw new Error("DATABASE_URL is not configured. Chats are stored in PostgreSQL.");
    }
    if (!ready) {
        // Rename anything still stored under the old "dot" / "agent" names first, then create what is missing.
        ready = withSchemaLock(sql, async (tx) => {
            await migrateVakilNaming(tx);
            await tx.unsafe(SCHEMA);
        })
            .catch((err) => {
            ready = null;
            throw err;
        });
    }
    await ready;
    return sql;
}
/** Call at startup so a missing or unreachable database is reported immediately. */
export async function initChatStore() {
    await pg();
}
const toConversation = (r) => ({
    id: r.id,
    vakilId: r.vakil_id,
    matterId: r.matter_id ?? null,
    title: r.title || "Untitled Conversation",
    userId: r.user_id,
    pinned: r.pinned === true,
    archived: r.archived === true,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
});
const toMessage = (r) => ({
    id: r.id,
    vakilId: r.vakil_id,
    conversationId: r.conversation_id,
    role: r.role,
    text: r.text || "",
    title: r.title ?? null,
    card: r.card ?? null,
    source: r.source ?? null,
    attachments: Array.isArray(r.attachments) ? r.attachments : null,
    citations: Array.isArray(r.citations) ? r.citations : null,
    artifactId: r.artifact_id ?? null,
    createdAt: Number(r.created_at),
});
function requireUser(userId) {
    if (!userId || !userId.trim())
        throw new ChatError(401, "Sign in required.");
    return userId;
}
/** A matter may only be attached to a chat by the user who owns that matter. */
async function assertMatterOwned(matterId, userId) {
    if (!(await matterOwned(matterId, userId)))
        throw new ChatError(404, "Matter not found.");
}
// ---------------- Conversations ----------------
export async function listConversations(userId, vakilId) {
    const uid = requireUser(userId);
    const sql = await pg();
    const rows = vakilId
        ? await sql `SELECT * FROM chat_conversations WHERE user_id = ${uid} AND vakil_id = ${vakilId} ORDER BY updated_at DESC`
        : await sql `SELECT * FROM chat_conversations WHERE user_id = ${uid} ORDER BY updated_at DESC`;
    return rows.map(toConversation);
}
/** Returns the conversation only if `userId` owns it; otherwise null (indistinguishable from "not found"). */
export async function getConversation(id, userId) {
    const uid = requireUser(userId);
    const sql = await pg();
    const rows = await sql `SELECT * FROM chat_conversations WHERE id = ${id} AND user_id = ${uid} LIMIT 1`;
    return rows[0] ? toConversation(rows[0]) : null;
}
export async function latestConversationId(vakilId, userId) {
    const uid = requireUser(userId);
    const sql = await pg();
    const rows = await sql `
    SELECT id FROM chat_conversations WHERE user_id = ${uid} AND vakil_id = ${vakilId}
    ORDER BY updated_at DESC LIMIT 1`;
    return rows[0]?.id ?? null;
}
export async function createConversation(vakilId, title = "New Legal Consultation", userId, customId, matterId) {
    const uid = requireUser(userId);
    if (matterId)
        await assertMatterOwned(matterId, uid);
    const sql = await pg();
    const id = customId?.trim() || `conv_${crypto.randomUUID()}`;
    const now = Date.now();
    const inserted = await sql `
    INSERT INTO chat_conversations (id, user_id, vakil_id, matter_id, title, created_at, updated_at)
    VALUES (${id}, ${uid}, ${vakilId}, ${matterId || null}, ${title}, ${now}, ${now})
    ON CONFLICT (id) DO NOTHING
    RETURNING *`;
    if (inserted[0]) {
        const conv = toConversation(inserted[0]);
        emit({ type: "conversation", vakilId, userId: uid, data: conv });
        return conv;
    }
    // The id is taken. Retrying your own create is fine; someone else's id is not.
    const existing = await getConversation(id, uid);
    if (existing)
        return existing;
    throw new ChatError(409, "That conversation id is already in use.");
}
export async function deleteConversation(id, userId) {
    const uid = requireUser(userId);
    const sql = await pg();
    const rows = await sql `DELETE FROM chat_conversations WHERE id = ${id} AND user_id = ${uid} RETURNING vakil_id`;
    if (!rows[0])
        return false;
    // Documents that belonged only to this chat go with it (matter documents stay with their matter).
    await deleteChatOnlyDocuments(uid, id).catch((err) => console.warn("[chats] document cleanup failed:", err.message));
    // Artifacts still live in the local store; remove this user's artifacts for the chat.
    await (await pgData()) `DELETE FROM app_artifacts WHERE conversation_id = ${id} AND user_id = ${uid}`;
    emit({ type: "conversation_deleted", id, vakilId: rows[0].vakil_id, userId: uid });
    return true;
}
export async function renameConversation(id, userId, title) {
    const uid = requireUser(userId);
    const sql = await pg();
    const rows = await sql `
    UPDATE chat_conversations SET title = ${title}, updated_at = ${Date.now()}
    WHERE id = ${id} AND user_id = ${uid} RETURNING *`;
    if (!rows[0])
        return null;
    const conv = toConversation(rows[0]);
    emit({ type: "conversation", vakilId: conv.vakilId, userId: uid, data: conv });
    return conv;
}
export async function setConversationMatter(id, userId, matterId) {
    const uid = requireUser(userId);
    if (matterId)
        await assertMatterOwned(matterId, uid);
    const sql = await pg();
    const rows = await sql `
    UPDATE chat_conversations SET matter_id = ${matterId}, updated_at = ${Date.now()}
    WHERE id = ${id} AND user_id = ${uid} RETURNING *`;
    if (!rows[0])
        return null;
    const conv = toConversation(rows[0]);
    emit({ type: "conversation", vakilId: conv.vakilId, userId: uid, data: conv });
    return conv;
}
/** Pin or archive one of the user's chats. This does not count as activity, so it never reorders the list by recency. */
export async function setConversationFlags(id, userId, flags) {
    const uid = requireUser(userId);
    const sql = await pg();
    const rows = await sql `
    UPDATE chat_conversations
    SET pinned = COALESCE(${flags.pinned ?? null}::boolean, pinned), archived = COALESCE(${flags.archived ?? null}::boolean, archived)
    WHERE id = ${id} AND user_id = ${uid} RETURNING *`;
    if (!rows[0])
        return null;
    const conv = toConversation(rows[0]);
    emit({ type: "conversation", vakilId: conv.vakilId, userId: uid, data: conv });
    return conv;
}
export async function moveConversation(id, userId, targetVakilId) {
    const uid = requireUser(userId);
    const sql = await pg();
    const conv = await sql.begin(async (tx) => {
        const rows = await tx `
      UPDATE chat_conversations SET vakil_id = ${targetVakilId}, updated_at = ${Date.now()}
      WHERE id = ${id} AND user_id = ${uid} RETURNING *`;
        if (!rows[0])
            return null;
        await tx `UPDATE chat_messages SET vakil_id = ${targetVakilId} WHERE conversation_id = ${id} AND user_id = ${uid}`;
        return toConversation(rows[0]);
    });
    if (conv)
        emit({ type: "conversation", vakilId: targetVakilId, userId: uid, data: conv });
    return conv;
}
export async function touchConversation(id, userId, at = Date.now()) {
    const uid = requireUser(userId);
    const sql = await pg();
    await sql `UPDATE chat_conversations SET updated_at = ${at} WHERE id = ${id} AND user_id = ${uid}`;
}
// ---------------- Messages ----------------
export async function listMessages(conversationId, userId) {
    const uid = requireUser(userId);
    const sql = await pg();
    const rows = await sql `
    SELECT * FROM chat_messages WHERE conversation_id = ${conversationId} AND user_id = ${uid}
    ORDER BY created_at ASC`;
    return rows.map(toMessage);
}
/** Most recent messages across this user's chats, oldest first. Used for the live snapshot. */
export async function listRecentMessages(userId, limit = 200) {
    const uid = requireUser(userId);
    const sql = await pg();
    const rows = await sql `
    SELECT * FROM chat_messages WHERE user_id = ${uid} ORDER BY created_at DESC LIMIT ${limit}`;
    return rows.reverse().map(toMessage);
}
/** The running summary of this chat's older messages, and the time of the last message it covers. */
export async function getChatSummary(conversationId, userId) {
    const uid = requireUser(userId);
    const sql = await pg();
    const rows = await sql `SELECT summary, summary_upto FROM chat_conversations WHERE id = ${conversationId} AND user_id = ${uid} LIMIT 1`;
    return { summary: rows[0]?.summary ?? "", upto: Number(rows[0]?.summary_upto ?? 0) };
}
/** Saves the summary. It only moves forward: an older summary never overwrites a newer one. */
export async function setChatSummary(conversationId, userId, summary, upto) {
    const uid = requireUser(userId);
    const sql = await pg();
    const rows = await sql `
    UPDATE chat_conversations SET summary = ${summary}, summary_upto = ${upto}
    WHERE id = ${conversationId} AND user_id = ${uid} AND summary_upto <= ${upto}
    RETURNING id`;
    return rows.length > 0;
}
/** Messages newer than `after` (the summary's end), newest `limit` of them, oldest first, with their times. */
export async function historyAfter(conversationId, userId, excludeMessageId, after, limit) {
    const uid = requireUser(userId);
    const sql = await pg();
    const rows = await sql `
    SELECT role, text, created_at FROM chat_messages
    WHERE conversation_id = ${conversationId} AND user_id = ${uid} AND id <> ${excludeMessageId} AND created_at > ${after}
    ORDER BY created_at DESC LIMIT ${limit}`;
    return rows.map((r) => ({ role: r.role, text: r.text, createdAt: Number(r.created_at) })).reverse();
}
/**
 * Everything the prompt needs from the chat in one query: the running summary and the newest `limit` messages after
 * it (oldest first). One statement means one round trip, and the summary and its cut-off point always agree even if
 * a background summary update lands while this runs.
 */
export async function getChatContext(conversationId, userId, excludeMessageId, limit) {
    const uid = requireUser(userId);
    const sql = await pg();
    const rows = await sql `
    SELECT c.summary, c.summary_upto,
      COALESCE((
        SELECT json_agg(json_build_object('role', t.role, 'text', t.text, 'createdAt', t.created_at) ORDER BY t.created_at)
        FROM (
          SELECT role, text, created_at FROM chat_messages
          WHERE conversation_id = c.id AND user_id = c.user_id AND id <> ${excludeMessageId} AND created_at > c.summary_upto
          ORDER BY created_at DESC LIMIT ${limit}
        ) t
      ), '[]'::json) AS history
    FROM chat_conversations c
    WHERE c.id = ${conversationId} AND c.user_id = ${uid}
    LIMIT 1`;
    const row = rows[0];
    const history = (Array.isArray(row?.history) ? row.history : []);
    return {
        summary: row?.summary ?? "",
        upto: Number(row?.summary_upto ?? 0),
        history: history.map((m) => ({ role: m.role, text: m.text, createdAt: Number(m.createdAt) })),
    };
}
export async function insertMessage(input) {
    const uid = requireUser(input.userId);
    const sql = await pg();
    const createdAt = input.createdAt ?? Date.now();
    let id = input.id?.trim() || `msg-${crypto.randomUUID()}`;
    const attachments = input.attachments && input.attachments.length ? sql.json(input.attachments) : null;
    const citations = input.citations && input.citations.length ? sql.json(input.citations) : null;
    for (let attempt = 0; attempt < 2; attempt++) {
        // One statement both checks that the chat exists and is this user's (the SELECT matches no row otherwise) and
        // writes the message, so the usual case needs a single round trip instead of a lookup first.
        const rows = await sql `
      INSERT INTO chat_messages (id, conversation_id, user_id, vakil_id, role, text, attachments, citations, created_at)
      SELECT ${id}::text, c.id, c.user_id, ${input.vakilId}::text, ${input.role}::text, ${input.text}::text, ${attachments}::jsonb, ${citations}::jsonb, ${createdAt}::bigint
      FROM chat_conversations c
      WHERE c.id = ${input.conversationId} AND c.user_id = ${uid}
      ON CONFLICT (id) DO NOTHING
      RETURNING *`;
        if (rows[0])
            return toMessage(rows[0]);
        // Nothing was written: either the chat is not this user's (or does not exist), or the message id is taken.
        if (attempt === 0 && !(await getConversation(input.conversationId, uid)))
            throw new ChatError(404, "Conversation not found.");
        // The id is taken. If it is this user's own copy of this same message (a retry after a timeout), return it
        // instead of storing the question twice. If it belongs to anyone else, never touch it: use a fresh id.
        if (attempt === 0 && input.id) {
            const same = await sql `
        SELECT * FROM chat_messages
        WHERE id = ${id} AND user_id = ${uid} AND conversation_id = ${input.conversationId} AND role = ${input.role}`;
            if (same[0])
                return toMessage(same[0]);
        }
        id = `msg-${crypto.randomUUID()}`;
    }
    throw new Error("Could not store message.");
}
export async function countMessagesSince(since) {
    const sql = await pg();
    const [row] = await sql `
    SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE created_at >= ${since})::int AS recent FROM chat_messages`;
    return { total: Number(row?.total ?? 0), recent: Number(row?.recent ?? 0) };
}
export async function countConversations() {
    const sql = await pg();
    const [row] = await sql `SELECT COUNT(*)::int AS n FROM chat_conversations`;
    return Number(row?.n ?? 0);
}
