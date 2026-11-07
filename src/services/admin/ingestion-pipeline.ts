import { getDb } from "../db/index.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config } from "../../config.js";

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

export function listDocuments(orgId: string = "org-legal-corp", status?: string): DocumentRecord[] {
  const db = getDb();
  if (status && status !== "all") {
    return db.prepare(`
      SELECT * FROM admin_documents
      WHERE organization_id = ? AND status = ?
      ORDER BY created_at DESC
    `).all(orgId, status) as unknown as DocumentRecord[];
  }

  return db.prepare(`
    SELECT * FROM admin_documents
    WHERE organization_id = ?
    ORDER BY created_at DESC
  `).all(orgId) as unknown as DocumentRecord[];
}

export async function ingestDocument(data: {
  organizationId: string;
  title: string;
  fileName: string;
  mimeType: string;
  fileBuffer: Buffer;
}): Promise<DocumentRecord> {
  const db = getDb();
  const docId = `doc-${crypto.randomUUID()}`;
  const now = new Date().toISOString();

  // 1. Vault Partitioning: storage outside public root
  const vaultDir = path.join(config.dotsDataDir, "vault", data.organizationId);
  if (!fs.existsSync(vaultDir)) {
    fs.mkdirSync(vaultDir, { recursive: true });
  }

  const storagePath = path.join(vaultDir, `${docId}_${path.basename(data.fileName)}`);
  fs.writeFileSync(storagePath, data.fileBuffer);

  // 2. Checksum
  const checksum = crypto.createHash("sha256").update(data.fileBuffer).digest("hex");

  // 3. OCR Detection heuristic
  const isPdf = data.mimeType.includes("pdf") || data.fileName.endsWith(".pdf");
  const requiresOcr = isPdf ? 1 : 0;

  const doc: DocumentRecord = {
    id: docId,
    organization_id: data.organizationId,
    title: data.title,
    file_name: data.fileName,
    mime_type: data.mimeType,
    size_bytes: data.fileBuffer.length,
    page_count: 1,
    chunk_count: 1,
    status: "ready",
    requires_ocr: requiresOcr,
    job_stage: "COMPLETED",
    error_message: null,
    storage_path: storagePath,
    checksum_sha256: checksum,
    created_at: now,
    updated_at: now,
  };

  db.prepare(`
    INSERT INTO admin_documents (
      id, organization_id, title, file_name, mime_type, size_bytes,
      page_count, chunk_count, status, requires_ocr, job_stage,
      error_message, storage_path, checksum_sha256, created_at, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    )
  `).run(
    doc.id, doc.organization_id, doc.title, doc.file_name, doc.mime_type,
    doc.size_bytes, doc.page_count, doc.chunk_count, doc.status,
    doc.requires_ocr, doc.job_stage ?? null, doc.error_message ?? null, doc.storage_path,
    doc.checksum_sha256, doc.created_at, doc.updated_at
  );

  return doc;
}

export function deleteDocument(docId: string, orgId: string = "org-legal-corp"): boolean {
  const db = getDb();
  const doc = db.prepare("SELECT * FROM admin_documents WHERE id = ? AND organization_id = ?").get(docId, orgId) as DocumentRecord | undefined;
  if (!doc) return false;

  // Remove vault file
  try {
    if (fs.existsSync(doc.storage_path)) {
      fs.unlinkSync(doc.storage_path);
    }
  } catch (err) {
    console.warn("[ingestion-pipeline] Error removing vault file:", err);
  }

  db.prepare("DELETE FROM admin_documents WHERE id = ?").run(docId);
  db.prepare("DELETE FROM admin_collection_documents WHERE document_id = ?").run(docId);

  return true;
}
