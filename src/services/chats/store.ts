/**
 * PostgreSQL chat storage.
 *
 * Every conversation and message row carries the owning `user_id`, and every
 * query below filters on it. A caller can only ever read or change rows that
 * belong to the user id it passes in, and that id must come from the verified
 * session (see middleware/auth.ts), never from the request body or query.
 */
import crypto from "node:crypto";
import { getLegacyDb } from "../db/index.js";
import { matterOwned, pgData } from "../data/pg.js";
import { getSql } from "../db/postgres.js";
import { emit } from "../bus/index.js";
import { deleteChatOnlyDocuments } from "../documents/index.js";
import { migrateVakilNaming } from "../db/migrate-naming.js";
import { withSchemaLock } from "../db/schema-lock.js";

export class ChatError extends Error {
  constructor(
    public status: 400 | 401 | 403 | 404 | 409,
    message: string,
  ) {
    super(message);
  }
}

export interface Conversation {
  id: string;
  vakilId: string;
  matterId?: string | null;
  title: string;
  userId: string;
  /** Pinned chats sit at the top of the list; archived ones are tucked away. Both belong to the user's own chat. */
  pinned?: boolean;
  archived?: boolean;
  createdAt: number;
  updatedAt?: number;
}

/** A source an answer drew on: a passage of the user's own document (with its page), or a statute provision. */
export type Citation =
  | { kind: "document"; label: string; fileId: string; name: string; page: number; unit: "page" | "section"; excerpt: string }
  | { kind: "statute"; label: string; title: string; act?: string; section?: string; source?: string };

export interface Message {
  id: string;
  vakilId: string;
  conversationId?: string | null;
  role: "user" | "vakil" | "assistant" | "system";
  text: string;
  title?: string | null;
  card?: string | null;
  source?: string | null;
  attachments?: unknown[] | null;
  citations?: Citation[] | null;
  artifactId?: string | null;
  createdAt: number;
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

let ready: Promise<void> | null = null;

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
export async function initChatStore(): Promise<void> {
  await pg();
}

type Row = Record<string, any>;

const toConversation = (r: Row): Conversation => ({
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

const toMessage = (r: Row): Message => ({
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

function requireUser(userId: string | undefined | null): string {
  if (!userId || !userId.trim()) throw new ChatError(401, "Sign in required.");
  return userId;
}

/** A matter may only be attached to a chat by the user who owns that matter. */
async function assertMatterOwned(matterId: string, userId: string) {
  if (!(await matterOwned(matterId, userId))) throw new ChatError(404, "Matter not found.");
}

// ---------------- Conversations ----------------

export async function listConversations(userId: string, vakilId?: string): Promise<Conversation[]> {
  const uid = requireUser(userId);
  const sql = await pg();
  const rows = vakilId
    ? await sql`SELECT * FROM chat_conversations WHERE user_id = ${uid} AND vakil_id = ${vakilId} ORDER BY updated_at DESC`
    : await sql`SELECT * FROM chat_conversations WHERE user_id = ${uid} ORDER BY updated_at DESC`;
  return rows.map(toConversation);
}

/** Returns the conversation only if `userId` owns it; otherwise null (indistinguishable from "not found"). */
export async function getConversation(id: string, userId: string): Promise<Conversation | null> {
  const uid = requireUser(userId);
  const sql = await pg();
  const rows = await sql`SELECT * FROM chat_conversations WHERE id = ${id} AND user_id = ${uid} LIMIT 1`;
  return rows[0] ? toConversation(rows[0]) : null;
}

export async function latestConversationId(vakilId: string, userId: string): Promise<string | null> {
  const uid = requireUser(userId);
  const sql = await pg();
  const rows = await sql`
    SELECT id FROM chat_conversations WHERE user_id = ${uid} AND vakil_id = ${vakilId}
    ORDER BY updated_at DESC LIMIT 1`;
  return rows[0]?.id ?? null;
}

export async function createConversation(
  vakilId: string,
  title: string = "New Legal Consultation",
  userId: string,
  customId?: string,
  matterId?: string | null,
): Promise<Conversation> {
  const uid = requireUser(userId);
  if (matterId) await assertMatterOwned(matterId, uid);
  const sql = await pg();
  const id = customId?.trim() || `conv_${crypto.randomUUID()}`;
  const now = Date.now();

  const inserted = await sql`
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
  if (existing) return existing;
  throw new ChatError(409, "That conversation id is already in use.");
}

export async function deleteConversation(id: string, userId: string): Promise<boolean> {
  const uid = requireUser(userId);
  const sql = await pg();
  const rows = await sql`DELETE FROM chat_conversations WHERE id = ${id} AND user_id = ${uid} RETURNING vakil_id`;
  if (!rows[0]) return false;
  // Documents that belonged only to this chat go with it (matter documents stay with their matter).
  await deleteChatOnlyDocuments(uid, id).catch((err) => console.warn("[chats] document cleanup failed:", err.message));
  // Artifacts still live in the local store; remove this user's artifacts for the chat.
  await (await pgData())`DELETE FROM app_artifacts WHERE conversation_id = ${id} AND user_id = ${uid}`;
  emit({ type: "conversation_deleted", id, vakilId: rows[0].vakil_id, userId: uid });
  return true;
}

export async function renameConversation(id: string, userId: string, title: string): Promise<Conversation | null> {
  const uid = requireUser(userId);
  const sql = await pg();
  const rows = await sql`
    UPDATE chat_conversations SET title = ${title}, updated_at = ${Date.now()}
    WHERE id = ${id} AND user_id = ${uid} RETURNING *`;
  if (!rows[0]) return null;
  const conv = toConversation(rows[0]);
  emit({ type: "conversation", vakilId: conv.vakilId, userId: uid, data: conv });
  return conv;
}

export async function setConversationMatter(
  id: string,
  userId: string,
  matterId: string | null,
): Promise<Conversation | null> {
  const uid = requireUser(userId);
  if (matterId) await assertMatterOwned(matterId, uid);
  const sql = await pg();
  const rows = await sql`
    UPDATE chat_conversations SET matter_id = ${matterId}, updated_at = ${Date.now()}
    WHERE id = ${id} AND user_id = ${uid} RETURNING *`;
  if (!rows[0]) return null;
  const conv = toConversation(rows[0]);
  emit({ type: "conversation", vakilId: conv.vakilId, userId: uid, data: conv });
  return conv;
}

/** Pin or archive one of the user's chats. This does not count as activity, so it never reorders the list by recency. */
export async function setConversationFlags(
  id: string,
  userId: string,
  flags: { pinned?: boolean; archived?: boolean },
): Promise<Conversation | null> {
  const uid = requireUser(userId);
  const sql = await pg();
  const rows = await sql`
    UPDATE chat_conversations
    SET pinned = COALESCE(${flags.pinned ?? null}::boolean, pinned), archived = COALESCE(${flags.archived ?? null}::boolean, archived)
    WHERE id = ${id} AND user_id = ${uid} RETURNING *`;
  if (!rows[0]) return null;
  const conv = toConversation(rows[0]);
  emit({ type: "conversation", vakilId: conv.vakilId, userId: uid, data: conv });
  return conv;
}

export async function moveConversation(id: string, userId: string, targetVakilId: string): Promise<Conversation | null> {
  const uid = requireUser(userId);
  const sql = await pg();
  const conv = await sql.begin(async (tx) => {
    const rows = await tx`
      UPDATE chat_conversations SET vakil_id = ${targetVakilId}, updated_at = ${Date.now()}
      WHERE id = ${id} AND user_id = ${uid} RETURNING *`;
    if (!rows[0]) return null;
    await tx`UPDATE chat_messages SET vakil_id = ${targetVakilId} WHERE conversation_id = ${id} AND user_id = ${uid}`;
    return toConversation(rows[0]);
  });
  if (conv) emit({ type: "conversation", vakilId: targetVakilId, userId: uid, data: conv });
  return conv;
}

export async function touchConversation(id: string, userId: string, at: number = Date.now()): Promise<void> {
  const uid = requireUser(userId);
  const sql = await pg();
  await sql`UPDATE chat_conversations SET updated_at = ${at} WHERE id = ${id} AND user_id = ${uid}`;
}

// ---------------- Messages ----------------

export async function listMessages(conversationId: string, userId: string): Promise<Message[]> {
  const uid = requireUser(userId);
  const sql = await pg();
  const rows = await sql`
    SELECT * FROM chat_messages WHERE conversation_id = ${conversationId} AND user_id = ${uid}
    ORDER BY created_at ASC`;
  return rows.map(toMessage);
}

/** Most recent messages across this user's chats, oldest first. Used for the live snapshot. */
export async function listRecentMessages(userId: string, limit = 200): Promise<Message[]> {
  const uid = requireUser(userId);
  const sql = await pg();
  const rows = await sql`
    SELECT * FROM chat_messages WHERE user_id = ${uid} ORDER BY created_at DESC LIMIT ${limit}`;
  return rows.reverse().map(toMessage);
}

/** Prior turns for building the model prompt, oldest first. */
export async function recentHistory(
  conversationId: string,
  userId: string,
  excludeMessageId: string,
  limit: number,
): Promise<Array<{ role: string; text: string }>> {
  const uid = requireUser(userId);
  const sql = await pg();
  const rows = await sql`
    SELECT role, text FROM chat_messages
    WHERE conversation_id = ${conversationId} AND user_id = ${uid} AND id <> ${excludeMessageId}
    ORDER BY created_at DESC LIMIT ${limit}`;
  return rows.map((r) => ({ role: r.role as string, text: r.text as string })).reverse();
}

/** The running summary of this chat's older messages, and the time of the last message it covers. */
export async function getChatSummary(conversationId: string, userId: string): Promise<{ summary: string; upto: number }> {
  const uid = requireUser(userId);
  const sql = await pg();
  const rows = await sql`SELECT summary, summary_upto FROM chat_conversations WHERE id = ${conversationId} AND user_id = ${uid} LIMIT 1`;
  return { summary: (rows[0]?.summary as string | null) ?? "", upto: Number(rows[0]?.summary_upto ?? 0) };
}

/** Saves the summary. It only moves forward: an older summary never overwrites a newer one. */
export async function setChatSummary(conversationId: string, userId: string, summary: string, upto: number): Promise<boolean> {
  const uid = requireUser(userId);
  const sql = await pg();
  const rows = await sql`
    UPDATE chat_conversations SET summary = ${summary}, summary_upto = ${upto}
    WHERE id = ${conversationId} AND user_id = ${uid} AND summary_upto <= ${upto}
    RETURNING id`;
  return rows.length > 0;
}

/** Messages newer than `after` (the summary's end), newest `limit` of them, oldest first, with their times. */
export async function historyAfter(
  conversationId: string,
  userId: string,
  excludeMessageId: string,
  after: number,
  limit: number,
): Promise<Array<{ role: string; text: string; createdAt: number }>> {
  const uid = requireUser(userId);
  const sql = await pg();
  const rows = await sql`
    SELECT role, text, created_at FROM chat_messages
    WHERE conversation_id = ${conversationId} AND user_id = ${uid} AND id <> ${excludeMessageId} AND created_at > ${after}
    ORDER BY created_at DESC LIMIT ${limit}`;
  return rows.map((r) => ({ role: r.role as string, text: r.text as string, createdAt: Number(r.created_at) })).reverse();
}

export async function insertMessage(input: {
  id?: string;
  conversationId: string;
  userId: string;
  vakilId: string;
  role: Message["role"];
  text: string;
  attachments?: unknown[] | null;
  citations?: Citation[] | null;
  createdAt?: number;
}): Promise<Message> {
  const uid = requireUser(input.userId);
  const sql = await pg();

  // The conversation must exist and belong to this user before anything is written to it.
  const owned = await getConversation(input.conversationId, uid);
  if (!owned) throw new ChatError(404, "Conversation not found.");

  const createdAt = input.createdAt ?? Date.now();
  let id = input.id?.trim() || `msg-${crypto.randomUUID()}`;
  const attachments = input.attachments && input.attachments.length ? sql.json(input.attachments as any) : null;
  const citations = input.citations && input.citations.length ? sql.json(input.citations as any) : null;

  for (let attempt = 0; attempt < 2; attempt++) {
    const rows = await sql`
      INSERT INTO chat_messages (id, conversation_id, user_id, vakil_id, role, text, attachments, citations, created_at)
      VALUES (${id}, ${input.conversationId}, ${uid}, ${input.vakilId}, ${input.role}, ${input.text}, ${attachments}, ${citations}, ${createdAt})
      ON CONFLICT (id) DO NOTHING
      RETURNING *`;
    if (rows[0]) return toMessage(rows[0]);
    // The id is taken. If it is this user's own copy of this same message (a retry after a timeout), return it
    // instead of storing the question twice. If it belongs to anyone else, never touch it: use a fresh id.
    if (attempt === 0 && input.id) {
      const same = await sql`
        SELECT * FROM chat_messages
        WHERE id = ${id} AND user_id = ${uid} AND conversation_id = ${input.conversationId} AND role = ${input.role}`;
      if (same[0]) return toMessage(same[0]);
    }
    id = `msg-${crypto.randomUUID()}`;
  }
  throw new Error("Could not store message.");
}

export async function countMessagesSince(since: number): Promise<{ total: number; recent: number }> {
  const sql = await pg();
  const [row] = await sql`
    SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE created_at >= ${since})::int AS recent FROM chat_messages`;
  return { total: Number(row?.total ?? 0), recent: Number(row?.recent ?? 0) };
}

export async function countConversations(): Promise<number> {
  const sql = await pg();
  const [row] = await sql`SELECT COUNT(*)::int AS n FROM chat_conversations`;
  return Number(row?.n ?? 0);
}

// ---------------- One-time import of the old local (SQLite) chats ----------------

/**
 * Copies chats that were stored in the local SQLite file into Postgres, once.
 * Only conversations with a known owner are imported. Conversations with no
 * owner (`user_id = ''`) cannot be attributed to anyone, so they are skipped
 * rather than being made visible to every user. The SQLite data is left untouched.
 */
export async function importLegacyChats(): Promise<{ conversations: number; messages: number; skippedUnowned: number } | null> {
  const db = getLegacyDb();
  if (!db) return null; // nothing local to import
  const sql = await pg();
  const done = await sql`SELECT 1 FROM app_settings WHERE key = 'chats_imported_to_postgres_v1'`.catch(() => []);
  if (done.length) return null;
  const convs = db.prepare("SELECT * FROM conversations").all() as Row[];
  let conversations = 0;
  let messages = 0;
  let skippedUnowned = 0;

  for (const c of convs) {
    if (!c.user_id) {
      skippedUnowned++;
      continue;
    }
    const created = await sql`
      INSERT INTO chat_conversations (id, user_id, vakil_id, matter_id, title, created_at, updated_at)
      VALUES (${c.id}, ${c.user_id}, ${c.dot_id}, ${c.matter_id ?? null}, ${c.title ?? ""}, ${c.created_at}, ${c.updated_at || c.created_at})
      ON CONFLICT (id) DO NOTHING RETURNING id`;
    if (!created[0]) continue; // already there, possibly owned by someone else: leave it alone
    conversations++;

    const msgs = db.prepare("SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at").all(c.id) as Row[];
    for (const m of msgs) {
      let attachments: unknown[] | null = null;
      try {
        const parsed = m.attachments ? JSON.parse(m.attachments) : null;
        attachments = Array.isArray(parsed) && parsed.length ? parsed : null;
      } catch {
        attachments = null;
      }
      const ins = await sql`
        INSERT INTO chat_messages (id, conversation_id, user_id, vakil_id, role, text, title, card, source, attachments, created_at)
        VALUES (${m.id}, ${c.id}, ${c.user_id}, ${m.dot_id}, ${m.role === "dot" ? "vakil" : m.role}, ${m.text ?? ""}, ${m.title ?? null}, ${m.card ?? null},
                ${m.source ?? null}, ${attachments ? sql.json(attachments as any) : null}, ${m.created_at})
        ON CONFLICT (id) DO NOTHING RETURNING id`;
      if (ins[0]) messages++;
    }
  }

  await sql`INSERT INTO app_settings (key, value) VALUES ('chats_imported_to_postgres_v1', ${JSON.stringify({ at: Date.now(), conversations, messages, skippedUnowned })})
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
  return { conversations, messages, skippedUnowned };
}
