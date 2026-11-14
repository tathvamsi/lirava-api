/**
 * Matter documents: text is extracted page by page, split into chunks, and stored in PostgreSQL
 * with a full-text index so questions can be answered from the right passage and cite its page.
 *
 * Everything is scoped to the owning user. A document is searchable in the chat it was attached to
 * and, when that chat belongs to a matter, in every chat of that matter.
 */
import JSZip from "jszip";
import { extractText } from "unpdf";
import { getSql } from "../db/postgres.js";
import { ensureEnglishTsv } from "../db/fts.js";
import { withSchemaLock } from "../db/schema-lock.js";
import { deleteFileForUser } from "../files/index.js";

export type IndexStatus = "ready" | "no_text" | "unsupported" | "failed";

export interface IndexResult {
  status: IndexStatus;
  pages: number;
  chunks: number;
  unit: "page" | "section";
  note?: string;
}

export interface DocumentHit {
  documentId: string;
  name: string;
  page: number;
  unit: "page" | "section";
  text: string;
  rank: number;
}

const MAX_PAGES = 600;
const MAX_CHUNKS = 2500;
const CHUNK_CHARS = 900;
const CHUNK_OVERLAP = 150;
const SECTION_CHARS = 3000;
const MAX_XML_BYTES = 50 * 1024 * 1024;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS matter_documents (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL,
  name            TEXT NOT NULL,
  mime            TEXT,
  conversation_id TEXT,
  matter_id       TEXT,
  unit            TEXT NOT NULL DEFAULT 'page',
  pages           INT NOT NULL DEFAULT 0,
  chunks          INT NOT NULL DEFAULT 0,
  status          TEXT NOT NULL,
  note            TEXT,
  created_at      BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS matter_documents_user_matter_idx ON matter_documents (user_id, matter_id);
CREATE INDEX IF NOT EXISTS matter_documents_user_conv_idx ON matter_documents (user_id, conversation_id);

CREATE TABLE IF NOT EXISTS document_chunks (
  id          BIGSERIAL PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES matter_documents (id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL,
  page        INT NOT NULL,
  idx         INT NOT NULL,
  text        TEXT NOT NULL,
  tsv         TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', text)) STORED
);
CREATE INDEX IF NOT EXISTS document_chunks_tsv_idx ON document_chunks USING GIN (tsv);
CREATE INDEX IF NOT EXISTS document_chunks_doc_idx ON document_chunks (document_id, page, idx);
`;

let ready: Promise<void> | null = null;
async function pg() {
  const sql = getSql();
  if (!sql) throw new Error("DATABASE_URL is not configured.");
  if (!ready) {
    ready = withSchemaLock(sql, async (tx) => {
      await tx.unsafe(SCHEMA);
      await ensureEnglishTsv(tx, "document_chunks", "to_tsvector('english', text)");
    })
      .catch((err) => {
        ready = null;
        throw err;
      });
  }
  await ready;
  return sql;
}

// ---------------- Text extraction ----------------

const decodeXml = (value: string) =>
  value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)));

/** Groups paragraphs into sections of roughly SECTION_CHARS, for formats that have no real pages. */
function toSections(paragraphs: string[]): string[] {
  const sections: string[] = [];
  let current = "";
  for (const paragraph of paragraphs) {
    if (current && current.length + paragraph.length > SECTION_CHARS) {
      sections.push(current);
      current = "";
    }
    current += (current ? "\n" : "") + paragraph;
  }
  if (current) sections.push(current);
  return sections;
}

async function docxParagraphs(buffer: Buffer): Promise<string[]> {
  const zip = await JSZip.loadAsync(buffer);
  const entry = zip.file("word/document.xml");
  if (!entry) return [];
  // Refuse a file that would expand into something enormous (a "zip bomb").
  const size = (entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0;
  if (size > MAX_XML_BYTES) throw new Error("The document is too large to read.");
  const xml = await entry.async("string");
  return xml
    .split(/<\/w:p>/)
    .map((paragraph) =>
      decodeXml(
        Array.from(paragraph.replace(/<w:br\s*\/?>/g, "<w:t> </w:t>").matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g))
          .map((m) => m[1])
          .join(""),
      ).trim(),
    )
    .filter(Boolean);
}

/** The text of a file, one entry per page (or per section for formats without pages). */
export async function extractPages(
  name: string,
  mime: string,
  buffer: Buffer,
): Promise<{ pages: string[]; unit: "page" | "section" } | { unsupported: true }> {
  const lower = name.toLowerCase();
  if (mime.includes("pdf") || lower.endsWith(".pdf")) {
    const result = await extractText(new Uint8Array(buffer), { mergePages: false });
    const pages = Array.isArray(result.text) ? result.text : [String(result.text ?? "")];
    return { pages: pages.slice(0, MAX_PAGES), unit: "page" };
  }
  if (lower.endsWith(".docx")) {
    return { pages: toSections(await docxParagraphs(buffer)).slice(0, MAX_PAGES), unit: "section" };
  }
  if (/\.(txt|md|csv|rtf)$/.test(lower) || mime.startsWith("text/")) {
    const lines = buffer.toString("utf8").replace(/\r\n?/g, "\n").split("\n").map((l) => l.trim()).filter(Boolean);
    return { pages: toSections(lines).slice(0, MAX_PAGES), unit: "section" };
  }
  return { unsupported: true };
}

/** Splits a page into overlapping chunks that break at sentence or word boundaries. */
export function chunkText(text: string, size = CHUNK_CHARS, overlap = CHUNK_OVERLAP): string[] {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= size) return clean ? [clean] : [];
  const chunks: string[] = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(start + size, clean.length);
    if (end < clean.length) {
      const window = clean.slice(start, end);
      const sentence = Math.max(window.lastIndexOf(". "), window.lastIndexOf("; "), window.lastIndexOf("? "));
      const space = window.lastIndexOf(" ");
      const cut = sentence > size * 0.5 ? sentence + 1 : space > size * 0.5 ? space : -1;
      if (cut > 0) end = start + cut;
    }
    const piece = clean.slice(start, end).trim();
    if (piece) chunks.push(piece);
    if (end >= clean.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return chunks;
}

// ---------------- Indexing ----------------

export async function indexDocument(input: {
  userId: string;
  fileId: string;
  name: string;
  mime: string;
  buffer: Buffer;
  conversationId?: string | null;
  matterId?: string | null;
}): Promise<IndexResult> {
  const sql = await pg();
  const now = Date.now();
  let result: IndexResult;
  const rows: Array<{ document_id: string; user_id: string; page: number; idx: number; text: string }> = [];

  try {
    const extracted = await extractPages(input.name, input.mime, input.buffer);
    if ("unsupported" in extracted) {
      result = { status: "unsupported", pages: 0, chunks: 0, unit: "page", note: "This file type is stored but its text is not searchable." };
    } else {
      extracted.pages.forEach((pageText, pageIndex) => {
        chunkText(pageText).forEach((text, idx) => {
          if (rows.length < MAX_CHUNKS) rows.push({ document_id: input.fileId, user_id: input.userId, page: pageIndex + 1, idx, text });
        });
      });
      result =
        rows.length === 0
          ? {
              status: "no_text",
              pages: extracted.pages.length,
              chunks: 0,
              unit: extracted.unit,
              note: "No readable text was found. A scanned document needs OCR before it can be searched.",
            }
          : { status: "ready", pages: extracted.pages.length, chunks: rows.length, unit: extracted.unit };
    }
  } catch (err) {
    console.warn("[documents] could not read", input.name, (err as Error).message);
    result = { status: "failed", pages: 0, chunks: 0, unit: "page", note: "The file could not be read." };
  }

  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO matter_documents (id, user_id, name, mime, conversation_id, matter_id, unit, pages, chunks, status, note, created_at)
      VALUES (${input.fileId}, ${input.userId}, ${input.name}, ${input.mime}, ${input.conversationId ?? null}, ${input.matterId ?? null},
              ${result.unit}, ${result.pages}, ${result.chunks}, ${result.status}, ${result.note ?? null}, ${now})
      ON CONFLICT (id) DO NOTHING`;
    for (let i = 0; i < rows.length; i += 200) {
      await tx`INSERT INTO document_chunks ${tx(rows.slice(i, i + 200), "document_id", "user_id", "page", "idx", "text")}`;
    }
  });
  return result;
}

/** Ties documents to the chat (and matter) they are used in, so later questions can find them. */
export async function linkDocuments(userId: string, fileIds: string[], conversationId: string, matterId: string | null): Promise<void> {
  if (!fileIds.length) return;
  const sql = await pg();
  await sql`
    UPDATE matter_documents
    SET conversation_id = ${conversationId}, matter_id = COALESCE(${matterId}, matter_id)
    WHERE user_id = ${userId} AND id = ANY(${fileIds})`;
}

export async function indexedStatus(userId: string, fileIds: string[]): Promise<Map<string, IndexStatus>> {
  const map = new Map<string, IndexStatus>();
  if (!fileIds.length) return map;
  const sql = await pg();
  const rows = await sql`SELECT id, status FROM matter_documents WHERE user_id = ${userId} AND id = ANY(${fileIds})`;
  for (const row of rows) map.set(row.id as string, row.status as IndexStatus);
  return map;
}

// ---------------- Search ----------------

const STOP_WORDS = new Set(
  ("the and for are was were has have had not but you your with that this from they them their there what when where which who whom " +
    "will would shall should can could may might must any all some into onto upon under about above below between over than then " +
    "also been being its our out his her she him how why does did done per via yes").split(" "),
);

/** Words worth searching for, with legal numbers such as "483" kept. */
export function searchTerms(question: string): string[] {
  const seen = new Set<string>();
  for (const word of question.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    const isNumber = /^\p{N}+$/u.test(word);
    if ((word.length >= 3 || (isNumber && word.length >= 2)) && !STOP_WORDS.has(word)) seen.add(word);
    if (seen.size >= 14) break;
  }
  return [...seen];
}

export interface SearchScope {
  conversationId: string;
  matterId?: string | null;
}

/**
 * The passages of this user's documents that best match the question, within the chat's scope
 * (documents attached to the chat, plus every document of the chat's matter).
 */
export async function searchDocuments(userId: string, scope: SearchScope, question: string, limit = 5): Promise<DocumentHit[]> {
  if (!userId) return [];
  const sql = await pg();
  const matterId = scope.matterId ?? null;
  const terms = searchTerms(question);

  const toHit = (r: Record<string, unknown>): DocumentHit => ({
    documentId: r.document_id as string,
    name: r.name as string,
    page: Number(r.page),
    unit: (r.unit as "page" | "section") ?? "page",
    text: r.text as string,
    rank: Number(r.rank ?? 0),
  });

  if (terms.length) {
    const rows = await sql`
      SELECT c.document_id, d.name, d.unit, c.page, c.text, ts_rank_cd(c.tsv, q.query) AS rank
      FROM document_chunks c
      JOIN matter_documents d ON d.id = c.document_id
      CROSS JOIN (SELECT to_tsquery('english', ${terms.join(" | ")}) AS query) q
      WHERE c.user_id = ${userId} AND d.user_id = ${userId}
        AND c.tsv @@ q.query
        AND (d.conversation_id = ${scope.conversationId} OR (${matterId}::text IS NOT NULL AND d.matter_id = ${matterId}))
      ORDER BY rank DESC, c.page ASC, c.idx ASC
      LIMIT ${limit}`;
    if (rows.length) return rows.map(toHit);
  }

  // The question shares no words with the documents (for example "summarise this"): start from the opening of each.
  const rows = await sql`
    SELECT DISTINCT ON (c.document_id) c.document_id, d.name, d.unit, c.page, c.text, 0 AS rank
    FROM document_chunks c
    JOIN matter_documents d ON d.id = c.document_id
    WHERE c.user_id = ${userId} AND d.user_id = ${userId}
      AND (d.conversation_id = ${scope.conversationId} OR (${matterId}::text IS NOT NULL AND d.matter_id = ${matterId}))
    ORDER BY c.document_id, c.page ASC, c.idx ASC
    LIMIT ${limit}`;
  return rows.map(toHit);
}

// ---------------- Listing and cleanup ----------------

export interface DocumentSummary {
  id: string;
  name: string;
  status: IndexStatus;
  pages: number;
  unit: "page" | "section";
  note: string | null;
  conversationId: string | null;
  matterId: string | null;
  createdAt: number;
}

export async function listMatterDocuments(userId: string, matterId: string): Promise<DocumentSummary[]> {
  const sql = await pg();
  const rows = await sql`
    SELECT id, name, status, pages, unit, note, conversation_id, matter_id, created_at
    FROM matter_documents WHERE user_id = ${userId} AND matter_id = ${matterId} ORDER BY created_at DESC`;
  return rows.map((r) => ({
    id: r.id as string,
    name: r.name as string,
    status: r.status as IndexStatus,
    pages: Number(r.pages),
    unit: r.unit as "page" | "section",
    note: (r.note as string | null) ?? null,
    conversationId: (r.conversation_id as string | null) ?? null,
    matterId: (r.matter_id as string | null) ?? null,
    createdAt: Number(r.created_at),
  }));
}

/** Deleting a chat removes the documents that belonged only to it (matter documents stay with the matter). */
export async function deleteChatOnlyDocuments(userId: string, conversationId: string): Promise<void> {
  const sql = await pg();
  const rows = await sql`
    DELETE FROM matter_documents WHERE user_id = ${userId} AND conversation_id = ${conversationId} AND matter_id IS NULL RETURNING id`;
  for (const row of rows) await deleteFileForUser(row.id as string, userId);
}
