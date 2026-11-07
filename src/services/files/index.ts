import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { config } from "../../config.js";
import { getDb } from "../db/index.js";
import { extractText } from "unpdf";

export interface Attachment {
  id: string;
  name: string;
  mime: string;
  size: number;
}

export interface FileRecord extends Attachment {
  dotId: string;
  userId: string;
  createdAt: number;
}

const FILES_DIR = path.join(config.dotsDataDir, "files");

function ensureDir() {
  if (!fs.existsSync(FILES_DIR)) {
    fs.mkdirSync(FILES_DIR, { recursive: true });
  }
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

export function saveFile(
  dotId: string,
  name: string,
  mime: string,
  buffer: Buffer,
  userId: string = ""
): Attachment {
  ensureDir();
  const db = getDb();
  const id = `file_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const cleanName = name.replace(/[\\/:*?"<>|\x00-\x1f]+/g, "_").slice(0, 120) || "file";
  const resolvedMime = mime && mime !== "application/octet-stream" ? mime : guessMime(cleanName);
  const now = Date.now();

  const filePath = path.join(FILES_DIR, id);
  fs.writeFileSync(filePath, buffer);

  db.prepare(`
    INSERT INTO files (id, dot_id, name, mime, size, source, box_path, user_id, created_at)
    VALUES (?, ?, ?, ?, ?, 'user', NULL, ?, ?)
  `).run(id, dotId, cleanName, resolvedMime, buffer.length, userId, now);

  return {
    id,
    name: cleanName,
    mime: resolvedMime,
    size: buffer.length,
  };
}

export function getFile(fileId: string): {
  id: string;
  name: string;
  mime: string;
  size: number;
  data: Buffer;
} | null {
  ensureDir();
  const db = getDb();
  const row = db.prepare("SELECT * FROM files WHERE id = ?").get(fileId) as
    | Record<string, any>
    | undefined;

  if (!row) return null;

  const filePath = path.join(FILES_DIR, row.id);
  if (!fs.existsSync(filePath)) return null;

  const data = fs.readFileSync(filePath);
  return {
    id: row.id,
    name: row.name,
    mime: row.mime || guessMime(row.name),
    size: row.size || data.length,
    data,
  };
}

export async function extractTextFromFile(fileId: string): Promise<string> {
  const file = getFile(fileId);
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
