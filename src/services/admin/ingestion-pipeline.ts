import crypto from "node:crypto";
import { pgData } from "../data/pg.js";
import { extractPages } from "../documents/index.js";
import { provisionsDb, splitIntoSections, upsertProvisions } from "../legal/provisions.js";
import { deleteProvisionRows } from "./corpus.js";

export interface DocumentRecord {
  id: string;
  organization_id: string;
  title: string;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  page_count: number;
  chunk_count: number;
  status: string;
  requires_ocr: number;
  job_stage?: string | null;
  error_message?: string | null;
  storage_path: string;
  checksum_sha256: string;
  created_at: string;
  updated_at: string;
}

// The file's bytes are kept in the database (column `data`) and are never returned in listings.
const COLUMNS =
  "id, organization_id, title, file_name, mime_type, size_bytes, page_count, chunk_count, status, requires_ocr, job_stage, error_message, storage_path, checksum_sha256, created_at, updated_at";

const toRecord = (r: Record<string, any>): DocumentRecord => ({
  ...(r as DocumentRecord),
  size_bytes: Number(r.size_bytes),
  page_count: Number(r.page_count),
  chunk_count: Number(r.chunk_count),
  requires_ocr: Number(r.requires_ocr),
});

export async function listDocuments(orgId: string = "org-legal-corp", status?: string): Promise<DocumentRecord[]> {
  const sql = await pgData();
  const rows =
    status && status !== "all"
      ? await sql.unsafe(`SELECT ${COLUMNS} FROM app_admin_documents WHERE organization_id = $1 AND status = $2 ORDER BY created_at DESC`, [orgId, status])
      : await sql.unsafe(`SELECT ${COLUMNS} FROM app_admin_documents WHERE organization_id = $1 ORDER BY created_at DESC`, [orgId]);
  return rows.map(toRecord);
}

async function update(docId: string, fields: Partial<Pick<DocumentRecord, "status" | "job_stage" | "error_message" | "page_count" | "chunk_count" | "requires_ocr">>) {
  const sql = await pgData();
  const keys = Object.keys(fields) as Array<keyof typeof fields>;
  if (!keys.length) return;
  const sets = keys.map((key, i) => `${key} = $${i + 2}`).join(", ");
  await sql.unsafe(`UPDATE app_admin_documents SET ${sets}, updated_at = $${keys.length + 2} WHERE id = $1`, [
    docId,
    ...keys.map((key) => fields[key] ?? null),
    new Date().toISOString(),
  ] as any[]);
}

/**
 * Stores an Act (PDF, Word or text), reads it, splits it into sections and makes every section searchable
 * in the statute library. Status tells the truth: `ready` only when sections were actually extracted.
 */
export async function ingestDocument(data: {
  organizationId: string;
  title: string;
  fileName: string;
  mimeType: string;
  fileBuffer: Buffer;
  /** The Act's name, as it should appear in citations, e.g. "Bharatiya Nagarik Suraksha Sanhita, 2023". */
  act: string;
  year?: number | null;
  /** Where the text came from, e.g. "India Code (indiacode.nic.in)". */
  source?: string | null;
}): Promise<DocumentRecord> {
  const sql = await pgData();
  const docId = `doc-${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  const checksum = crypto.createHash("sha256").update(data.fileBuffer).digest("hex");

  await sql`
    INSERT INTO app_admin_documents (id, organization_id, title, file_name, mime_type, size_bytes, page_count, chunk_count, status, requires_ocr,
                                     job_stage, storage_path, checksum_sha256, data, created_at, updated_at)
    VALUES (${docId}, ${data.organizationId}, ${data.title}, ${data.fileName}, ${data.mimeType}, ${data.fileBuffer.length}, 0, 0, 'processing', 0,
            'EXTRACTING', ${`db:${docId}`}, ${checksum}, ${data.fileBuffer}, ${now}, ${now})`;

  // Read it, split it into sections, and store each as a searchable provision
  try {
    const extracted = await extractPages(data.fileName, data.mimeType, data.fileBuffer);
    if ("unsupported" in extracted) {
      await update(docId, { status: "failed", job_stage: "UNSUPPORTED", error_message: "Upload a PDF, Word or text file." });
    } else {
      const text = extracted.pages.join("\n");
      if (text.trim().length < 50) {
        await update(docId, {
          status: "failed",
          job_stage: "NEEDS_OCR",
          requires_ocr: 1,
          page_count: extracted.pages.length,
          error_message: "No readable text was found. A scanned document needs OCR first.",
        });
      } else {
        const sections = splitIntoSections(text);
        if (!sections.length) {
          await update(docId, {
            status: "failed",
            job_stage: "NO_SECTIONS",
            page_count: extracted.pages.length,
            error_message: "No numbered sections were recognised. Check that this is the text of an Act.",
          });
        } else {
          const stored = await upsertProvisions({ act: data.act, year: data.year ?? null, source: data.source ?? null, documentId: docId, sections });
          await update(docId, { status: "ready", job_stage: "COMPLETED", page_count: extracted.pages.length, chunk_count: stored });
        }
      }
    }
  } catch (err) {
    console.error("[ingestion] failed:", err);
    await update(docId, { status: "failed", job_stage: "FAILED", error_message: "The file could not be processed." });
  }

  const [row] = await sql.unsafe(`SELECT ${COLUMNS} FROM app_admin_documents WHERE id = $1`, [docId]);
  return toRecord(row);
}

export async function deleteDocument(docId: string, orgId: string = "org-legal-corp"): Promise<boolean> {
  const sql = await pgData();
  const rows = await sql`DELETE FROM app_admin_documents WHERE id = ${docId} AND organization_id = ${orgId} RETURNING id`;
  if (!rows.length) return false;
  // The provisions loaded from this file leave the library with it.
  // (and from the vector index)
  await provisionsDb()
    .then((db) => db`SELECT id FROM legal_provisions WHERE document_id = ${docId}`)
    .then((rows) => deleteProvisionRows(rows.map((r) => r.id as string)))
    .catch((err) => console.warn("[ingestion] could not remove provisions:", err.message));
  return true;
}
