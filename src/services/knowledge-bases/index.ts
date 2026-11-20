/**
 * Knowledge bases: named collections of a lawyer's own documents ("My bail precedents") that can be attached
 * to a chat or a matter. The files are stored and indexed by the documents service, so they are searched and
 * cited exactly like any other document; this module only groups them and says where they apply.
 *
 * Everything is scoped to the owning user. Someone else's knowledge base looks like one that does not exist.
 */
import crypto from "node:crypto";
import { getSql } from "../db/postgres.js";
import { withSchemaLock } from "../db/schema-lock.js";
import { deleteDocumentsByIds, describeDocuments, type DocumentSummary } from "../documents/index.js";

export const MAX_KNOWLEDGE_BASES = 50;
export const MAX_FILES_PER_BASE = 200;
export const MAX_ATTACHED_PER_SCOPE = 5;
export const MAX_NAME_CHARS = 80;
export const MAX_DESCRIPTION_CHARS = 300;

export type LinkScope = "conversation" | "matter";
export const isLinkScope = (value: unknown): value is LinkScope => value === "conversation" || value === "matter";

export interface KnowledgeBase {
  id: string;
  name: string;
  description: string;
  fileCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface KnowledgeBaseDetail extends KnowledgeBase {
  files: DocumentSummary[];
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS knowledge_bases (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at  BIGINT NOT NULL,
  updated_at  BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS knowledge_bases_user_idx ON knowledge_bases (user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS knowledge_files (
  knowledge_id TEXT NOT NULL REFERENCES knowledge_bases (id) ON DELETE CASCADE,
  document_id  TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  added_at     BIGINT NOT NULL,
  PRIMARY KEY (knowledge_id, document_id)
);
CREATE INDEX IF NOT EXISTS knowledge_files_doc_idx ON knowledge_files (document_id);

CREATE TABLE IF NOT EXISTS knowledge_links (
  user_id      TEXT NOT NULL,
  scope        TEXT NOT NULL CHECK (scope IN ('conversation', 'matter')),
  scope_id     TEXT NOT NULL,
  knowledge_id TEXT NOT NULL REFERENCES knowledge_bases (id) ON DELETE CASCADE,
  PRIMARY KEY (scope, scope_id, knowledge_id)
);
CREATE INDEX IF NOT EXISTS knowledge_links_user_idx ON knowledge_links (user_id, scope, scope_id);
`;

let ready: Promise<void> | null = null;
async function pg() {
  const sql = getSql();
  if (!sql) throw new Error("DATABASE_URL is not configured.");
  if (!ready) {
    ready = withSchemaLock(sql, async (tx) => {
      await tx.unsafe(SCHEMA);
    }).catch((err) => {
      ready = null;
      throw err;
    });
  }
  await ready;
  return sql;
}

/** Collapses whitespace and cuts to length; null when nothing usable is left. */
export function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim();
  return text ? text.slice(0, max) : null;
}

type BaseRow = { id: string; name: string; description: string; created_at: string | number; updated_at: string | number; file_count?: string | number };
const toBase = (r: BaseRow): KnowledgeBase => ({
  id: r.id,
  name: r.name,
  description: r.description,
  fileCount: Number(r.file_count ?? 0),
  createdAt: Number(r.created_at),
  updatedAt: Number(r.updated_at),
});

export async function listKnowledgeBases(userId: string): Promise<KnowledgeBase[]> {
  if (!userId) return [];
  const sql = await pg();
  const rows = await sql<BaseRow[]>`
    SELECT b.id, b.name, b.description, b.created_at, b.updated_at,
           (SELECT COUNT(*) FROM knowledge_files f WHERE f.knowledge_id = b.id) AS file_count
    FROM knowledge_bases b WHERE b.user_id = ${userId} ORDER BY b.updated_at DESC LIMIT ${MAX_KNOWLEDGE_BASES}`;
  return rows.map(toBase);
}

export async function createKnowledgeBase(userId: string, name: unknown, description: unknown): Promise<KnowledgeBase | "full" | null> {
  const cleanName = cleanText(name, MAX_NAME_CHARS);
  if (!userId || !cleanName) return null;
  const sql = await pg();
  const [{ count }] = await sql<{ count: string }[]>`SELECT COUNT(*) AS count FROM knowledge_bases WHERE user_id = ${userId}`;
  if (Number(count) >= MAX_KNOWLEDGE_BASES) return "full";
  const now = Date.now();
  const id = `kb_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const desc = cleanText(description, MAX_DESCRIPTION_CHARS) ?? "";
  await sql`INSERT INTO knowledge_bases (id, user_id, name, description, created_at, updated_at) VALUES (${id}, ${userId}, ${cleanName}, ${desc}, ${now}, ${now})`;
  return { id, name: cleanName, description: desc, fileCount: 0, createdAt: now, updatedAt: now };
}

export async function getKnowledgeBase(userId: string, id: string): Promise<KnowledgeBaseDetail | null> {
  if (!userId) return null;
  const sql = await pg();
  const rows = await sql<BaseRow[]>`SELECT id, name, description, created_at, updated_at FROM knowledge_bases WHERE id = ${id} AND user_id = ${userId}`;
  if (!rows[0]) return null;
  const links = await sql<{ document_id: string }[]>`SELECT document_id FROM knowledge_files WHERE knowledge_id = ${id} ORDER BY added_at DESC`;
  const files = await describeDocuments(userId, links.map((l) => l.document_id));
  return { ...toBase(rows[0]), fileCount: files.length, files };
}

export async function updateKnowledgeBase(userId: string, id: string, patch: { name?: unknown; description?: unknown }): Promise<KnowledgeBase | null> {
  if (!userId) return null;
  const sql = await pg();
  const current = await sql<BaseRow[]>`SELECT id, name, description, created_at, updated_at FROM knowledge_bases WHERE id = ${id} AND user_id = ${userId}`;
  if (!current[0]) return null;
  const name = patch.name === undefined ? current[0].name : cleanText(patch.name, MAX_NAME_CHARS);
  if (!name) return null;
  const description = patch.description === undefined ? current[0].description : cleanText(patch.description, MAX_DESCRIPTION_CHARS) ?? "";
  const rows = await sql<BaseRow[]>`
    UPDATE knowledge_bases SET name = ${name}, description = ${description}, updated_at = ${Date.now()}
    WHERE id = ${id} AND user_id = ${userId} RETURNING id, name, description, created_at, updated_at`;
  return rows[0] ? toBase(rows[0]) : null;
}

/** Deletes the base, the links to chats and matters, and the files that were uploaded into it. */
export async function deleteKnowledgeBase(userId: string, id: string): Promise<boolean> {
  if (!userId) return false;
  const sql = await pg();
  const owned = await sql`SELECT 1 FROM knowledge_bases WHERE id = ${id} AND user_id = ${userId}`;
  if (!owned.length) return false;
  const files = await sql<{ document_id: string }[]>`SELECT document_id FROM knowledge_files WHERE knowledge_id = ${id}`;
  await sql`DELETE FROM knowledge_bases WHERE id = ${id} AND user_id = ${userId}`;
  await deleteDocumentsByIds(userId, files.map((f) => f.document_id));
  return true;
}

/** Whether another file may be added. Returns false when the base is not the user's. */
export async function canAddFile(userId: string, id: string): Promise<"ok" | "missing" | "full"> {
  if (!userId) return "missing";
  const sql = await pg();
  const owned = await sql`SELECT 1 FROM knowledge_bases WHERE id = ${id} AND user_id = ${userId}`;
  if (!owned.length) return "missing";
  const [{ count }] = await sql<{ count: string }[]>`SELECT COUNT(*) AS count FROM knowledge_files WHERE knowledge_id = ${id}`;
  return Number(count) >= MAX_FILES_PER_BASE ? "full" : "ok";
}

export async function addFile(userId: string, id: string, documentId: string): Promise<void> {
  const sql = await pg();
  const now = Date.now();
  await sql`INSERT INTO knowledge_files (knowledge_id, document_id, user_id, added_at) VALUES (${id}, ${documentId}, ${userId}, ${now}) ON CONFLICT DO NOTHING`;
  await sql`UPDATE knowledge_bases SET updated_at = ${now} WHERE id = ${id} AND user_id = ${userId}`;
}

export async function removeFile(userId: string, id: string, documentId: string): Promise<boolean> {
  if (!userId) return false;
  const sql = await pg();
  const rows = await sql`
    DELETE FROM knowledge_files WHERE knowledge_id = ${id} AND document_id = ${documentId}
      AND EXISTS (SELECT 1 FROM knowledge_bases b WHERE b.id = ${id} AND b.user_id = ${userId})
    RETURNING document_id`;
  if (!rows.length) return false;
  await deleteDocumentsByIds(userId, [documentId]);
  await sql`UPDATE knowledge_bases SET updated_at = ${Date.now()} WHERE id = ${id} AND user_id = ${userId}`;
  return true;
}

/** The bases attached to one chat or matter. */
export async function listLinks(userId: string, scope: LinkScope, scopeId: string): Promise<KnowledgeBase[]> {
  if (!userId) return [];
  const sql = await pg();
  const rows = await sql<BaseRow[]>`
    SELECT b.id, b.name, b.description, b.created_at, b.updated_at,
           (SELECT COUNT(*) FROM knowledge_files f WHERE f.knowledge_id = b.id) AS file_count
    FROM knowledge_links l JOIN knowledge_bases b ON b.id = l.knowledge_id
    WHERE l.user_id = ${userId} AND b.user_id = ${userId} AND l.scope = ${scope} AND l.scope_id = ${scopeId}
    ORDER BY b.name`;
  return rows.map(toBase);
}

/** Replaces what is attached to a chat or matter. Ids that are not the user's bases are rejected. */
export async function setLinks(userId: string, scope: LinkScope, scopeId: string, ids: unknown): Promise<KnowledgeBase[] | "invalid" | "too-many"> {
  if (!userId || !Array.isArray(ids) || ids.some((i) => typeof i !== "string")) return "invalid";
  const unique = [...new Set(ids as string[])];
  if (unique.length > MAX_ATTACHED_PER_SCOPE) return "too-many";
  const sql = await pg();
  if (unique.length) {
    const owned = await sql`SELECT id FROM knowledge_bases WHERE user_id = ${userId} AND id = ANY(${unique})`;
    if (owned.length !== unique.length) return "invalid";
  }
  await sql.begin(async (tx) => {
    await tx`DELETE FROM knowledge_links WHERE user_id = ${userId} AND scope = ${scope} AND scope_id = ${scopeId}`;
    for (const knowledgeId of unique) {
      await tx`INSERT INTO knowledge_links (user_id, scope, scope_id, knowledge_id) VALUES (${userId}, ${scope}, ${scopeId}, ${knowledgeId})`;
    }
  });
  return listLinks(userId, scope, scopeId);
}

/** Every base attached to the chat or, through its matter, to the case. Empty on any failure: it must never stop an answer. */
export async function linkedKnowledgeIds(userId: string, conversationId: string, matterId: string | null): Promise<string[]> {
  try {
    if (!userId) return [];
    const sql = await pg();
    const rows = await sql<{ knowledge_id: string }[]>`
      SELECT DISTINCT l.knowledge_id FROM knowledge_links l
      JOIN knowledge_bases b ON b.id = l.knowledge_id AND b.user_id = ${userId}
      WHERE l.user_id = ${userId}
        AND ((l.scope = 'conversation' AND l.scope_id = ${conversationId}) OR (l.scope = 'matter' AND ${matterId}::text IS NOT NULL AND l.scope_id = ${matterId}))`;
    return rows.map((r) => r.knowledge_id);
  } catch (err) {
    console.error("[knowledge-bases] could not look up attached bases:", err);
    return [];
  }
}
