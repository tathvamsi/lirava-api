import path from "node:path";
import crypto from "node:crypto";
import { extractText } from "unpdf";
import { pgData } from "../data/pg.js";

export interface Attachment {
  id: string;
  name: string;
  mime: string;
  size: number;
}

export function guessMime(name: string): string {
  const ext = path.extname(name).toLowerCase();
  const map: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".pdf": "application/pdf",
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".csv": "text/csv",
    ".json": "application/json",
    ".html": "text/html",
    ".htm": "text/html",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".zip": "application/zip",
    ".py": "text/x-python",
    ".js": "text/javascript",
    ".ts": "text/plain",
  };
  return map[ext] || "application/octet-stream";
}

/** Stores a file for its owner in PostgreSQL and returns the handle used to refer to it. */
export async function saveFile(
  vakilId: string,
  name: string,
  mime: string,
  buffer: Buffer,
  userId: string,
): Promise<Attachment> {
  if (!userId) throw new Error("A file needs an owner.");
  const sql = await pgData();
  const id = `file_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const cleanName = name.replace(/[\\/:*?"<>|\x00-\x1f]+/g, "_").slice(0, 120) || "file";
  const resolvedMime = mime && mime !== "application/octet-stream" ? mime : guessMime(cleanName);

  await sql`
    INSERT INTO app_files (id, user_id, vakil_id, name, mime, size, data, created_at)
    VALUES (${id}, ${userId}, ${vakilId}, ${cleanName}, ${resolvedMime}, ${buffer.length}, ${buffer}, ${Date.now()})`;

  return { id, name: cleanName, mime: resolvedMime, size: buffer.length };
}

export interface StoredFile {
  id: string;
  name: string;
  mime: string;
  size: number;
  data: Buffer;
}

/** Returns a file only to the user who uploaded or generated it. */
export async function getFileForUser(fileId: string, userId: string): Promise<StoredFile | null> {
  if (!userId) return null;
  const sql = await pgData();
  const rows = await sql`SELECT id, name, mime, size, data FROM app_files WHERE id = ${fileId} AND user_id = ${userId} LIMIT 1`;
  const row = rows[0];
  if (!row) return null;
  const data = Buffer.from(row.data as Uint8Array);
  return {
    id: row.id as string,
    name: row.name as string,
    mime: (row.mime as string) || guessMime(row.name as string),
    size: Number(row.size) || data.length,
    data,
  };
}

export async function extractTextFromFile(fileId: string, userId: string): Promise<string> {
  const file = await getFileForUser(fileId, userId);
  if (!file) return "";

  const mime = file.mime.toLowerCase();
  const name = file.name.toLowerCase();

  try {
    // 1. PDF
    if (mime.includes("pdf") || name.endsWith(".pdf")) {
      const { text } = await extractText(new Uint8Array(file.data));
      if (Array.isArray(text)) {
        return text.join("\n").slice(0, 15000);
      }
      return String(text || "").slice(0, 15000);
    }

    // 2. Plain Text / Markdown / Code / JSON / CSV
    if (
      mime.startsWith("text/") ||
      mime.includes("json") ||
      mime.includes("csv") ||
      name.endsWith(".txt") ||
      name.endsWith(".md") ||
      name.endsWith(".csv") ||
      name.endsWith(".json")
    ) {
      return file.data.toString("utf-8").slice(0, 15000);
    }
  } catch (err) {
    console.warn(`[files] Failed to extract text from file ${fileId} (${file.name}):`, err);
  }

  return "";
}

/** Removes several files the user owns in one statement (instead of one delete per file). */
export async function deleteFilesForUser(fileIds: string[], userId: string): Promise<number> {
  if (!userId || fileIds.length === 0) return 0;
  const sql = await pgData();
  const rows = await sql`DELETE FROM app_files WHERE user_id = ${userId} AND id = ANY(${fileIds}) RETURNING id`;
  return rows.length;
}
