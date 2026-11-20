/**
 * Notes: a lawyer's own working notes (research jottings, hearing prep, ideas), optionally tied to a matter.
 * Plain text or Markdown. Scoped to the owning user; someone else's note looks like one that does not exist.
 */
import crypto from "node:crypto";
import { getSql } from "../db/postgres.js";
import { withSchemaLock } from "../db/schema-lock.js";

export const MAX_NOTES = 500;
export const MAX_TITLE_CHARS = 200;
export const MAX_NOTE_CHARS = 50_000;
const PREVIEW_CHARS = 160;

export interface NoteSummary {
  id: string;
  title: string;
  preview: string;
  matterId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface Note extends Omit<NoteSummary, "preview"> {
  content: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS user_notes (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  title      TEXT NOT NULL DEFAULT '',
  content    TEXT NOT NULL DEFAULT '',
  matter_id  TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS user_notes_user_idx ON user_notes (user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS user_notes_matter_idx ON user_notes (user_id, matter_id);
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

type Row = { id: string; title: string; content: string; matter_id: string | null; created_at: string | number; updated_at: string | number };
const toNote = (r: Row): Note => ({ id: r.id, title: r.title, content: r.content, matterId: r.matter_id, createdAt: Number(r.created_at), updatedAt: Number(r.updated_at) });
const toSummary = (r: Row): NoteSummary => ({
  id: r.id,
  title: r.title,
  preview: r.content.replace(/[#*_`>|[\]]/g, "").replace(/\s+/g, " ").trim().slice(0, PREVIEW_CHARS),
  matterId: r.matter_id,
  createdAt: Number(r.created_at),
  updatedAt: Number(r.updated_at),
});

/** Cleans a title to one line; an empty title is allowed (the list shows "Untitled"). */
export function cleanTitle(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return value.replace(/\s+/g, " ").trim().slice(0, MAX_TITLE_CHARS);
}

/** Note text keeps its line breaks; only the length is limited. */
export function cleanContent(value: unknown): string | null {
  return typeof value === "string" ? value.slice(0, MAX_NOTE_CHARS) : null;
}

export async function listNotes(userId: string, matterId?: string): Promise<NoteSummary[]> {
  if (!userId) return [];
  const sql = await pg();
  const rows = await sql<Row[]>`
    SELECT id, title, content, matter_id, created_at, updated_at FROM user_notes
    WHERE user_id = ${userId} AND (${matterId ?? null}::text IS NULL OR matter_id = ${matterId ?? null})
    ORDER BY updated_at DESC LIMIT ${MAX_NOTES}`;
  return rows.map(toSummary);
}

export async function createNote(userId: string, input: { title?: unknown; content?: unknown; matterId?: string | null }): Promise<Note | "full" | null> {
  if (!userId) return null;
  const title = input.title === undefined ? "" : cleanTitle(input.title);
  const content = input.content === undefined ? "" : cleanContent(input.content);
  if (title === null || content === null) return null;
  const sql = await pg();
  const [{ count }] = await sql<{ count: string }[]>`SELECT COUNT(*) AS count FROM user_notes WHERE user_id = ${userId}`;
  if (Number(count) >= MAX_NOTES) return "full";
  const now = Date.now();
  const id = `note_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const matterId = input.matterId ?? null;
  await sql`INSERT INTO user_notes (id, user_id, title, content, matter_id, created_at, updated_at) VALUES (${id}, ${userId}, ${title}, ${content}, ${matterId}, ${now}, ${now})`;
  return { id, title, content, matterId, createdAt: now, updatedAt: now };
}

export async function getNote(userId: string, id: string): Promise<Note | null> {
  if (!userId) return null;
  const sql = await pg();
  const rows = await sql<Row[]>`SELECT id, title, content, matter_id, created_at, updated_at FROM user_notes WHERE id = ${id} AND user_id = ${userId}`;
  return rows[0] ? toNote(rows[0]) : null;
}

/** Changes only the fields given. Returns null when the note is not the user's or a field is invalid. */
export async function updateNote(userId: string, id: string, patch: { title?: unknown; content?: unknown; matterId?: string | null }): Promise<Note | null> {
  if (!userId) return null;
  const current = await getNote(userId, id);
  if (!current) return null;
  const title = patch.title === undefined ? current.title : cleanTitle(patch.title);
  const content = patch.content === undefined ? current.content : cleanContent(patch.content);
  if (title === null || content === null) return null;
  const matterId = patch.matterId === undefined ? current.matterId : patch.matterId;
  const sql = await pg();
  const now = Date.now();
  await sql`UPDATE user_notes SET title = ${title}, content = ${content}, matter_id = ${matterId}, updated_at = ${now} WHERE id = ${id} AND user_id = ${userId}`;
  return { ...current, title, content, matterId, updatedAt: now };
}

export async function deleteNote(userId: string, id: string): Promise<boolean> {
  if (!userId) return false;
  const sql = await pg();
  const rows = await sql`DELETE FROM user_notes WHERE id = ${id} AND user_id = ${userId} RETURNING id`;
  return rows.length > 0;
}
