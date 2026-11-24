/**
 * The case file: what a matter's documents say, as parties, a dated chronology, facts and claims,
 * each tied to the document and page it came from. This is step one of working a case: everything
 * later (issues, research, drafting) builds on facts the lawyer has confirmed here.
 *
 * Building is resumable. Each call reads as many windows of text as fits in a time budget, saves its
 * progress, and returns. The caller keeps calling until the status is "ready". That keeps every request
 * short enough for serverless hosting, and a slow model never loses finished work.
 */
import { llmModel } from "../agent/providers.js";
import { getLlmClient } from "../agent/client.js";
import { getSql } from "../db/postgres.js";
import { withSchemaLock } from "../db/schema-lock.js";
import { listMatterDocuments } from "../documents/index.js";
import { kindPriority } from "../documents/classify.js";
import { addMatterEvent } from "../repo/index.js";
import {
  EXTRACTION_SYSTEM,
  extractionPrompt,
  joinChunks,
  mergeCaseFile,
  normalizePages,
  parseWindowJson,
  planWindows,
  type CaseFileContent,
  type DocumentParts,
  type PageText,
  type RawWindow,
} from "./extract.js";

// A criminal file runs to dozens of documents. The build is resumable, so a larger limit costs time, not reliability.
const MAX_DOCUMENTS = 40;
const MAX_TOTAL_WINDOWS = 120;
const DEFAULT_BUDGET_MS = 100_000;
const CALL_TIMEOUT_MS = 80_000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS matter_case_files (
  matter_id           TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL,
  status              TEXT NOT NULL,
  progress            JSONB,
  data                JSONB,
  checkpoint_event_id TEXT,
  error               TEXT,
  updated_at          BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS matter_case_files_user_idx ON matter_case_files (user_id);
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

export type CaseFileStatus = "building" | "ready" | "failed";

interface Progress {
  queue: Array<{ documentId: string; index: number }>;
  /** Parsed model replies so far, by document. */
  parts: Record<string, RawWindow[]>;
  total: number;
  done: number;
  /** Windows the model could not answer (counted, never hidden). */
  failed: number;
}

export interface CaseFileView {
  status: CaseFileStatus;
  progress: { done: number; total: number; failed: number };
  content: CaseFileContent | null;
  /** Documents that were not read, and why. */
  skipped: Array<{ name: string; reason: string }>;
  /** The "confirm these facts" checkpoint on the matter's timeline. */
  checkpointEventId: string | null;
  error: string | null;
  updatedAt: number;
}

// ---------------- Reading ----------------

async function loadPages(userId: string, documentId: string): Promise<PageText[]> {
  const sql = await pg();
  const rows = await sql`SELECT page, text FROM document_chunks WHERE document_id = ${documentId} AND user_id = ${userId} ORDER BY page ASC, idx ASC`;
  const byPage = new Map<number, string[]>();
  for (const row of rows) {
    const page = Number(row.page);
    const chunks = byPage.get(page) ?? [];
    chunks.push(row.text as string);
    byPage.set(page, chunks);
  }
  return Array.from(byPage.entries()).map(([page, chunks]) => ({ page, text: joinChunks(chunks) }));
}

async function askWindow(documentName: string, windowText: string): Promise<RawWindow | null> {
  const client = getLlmClient();
  const messages = [
    { role: "system" as const, content: EXTRACTION_SYSTEM },
    { role: "user" as const, content: extractionPrompt(documentName, windowText) },
  ];
  // First try asks the server for strict JSON; if that is refused or unparseable, try once more as plain text.
  for (const strict of [true, false]) {
    try {
      const res = await client.chat.completions.create(
        {
          model: llmModel(),
          messages,
          temperature: 0,
          max_tokens: 900,
          ...(strict ? { response_format: { type: "json_object" as const } } : {}),
        },
        { timeout: CALL_TIMEOUT_MS },
      );
      const parsed = parseWindowJson(res.choices[0]?.message?.content ?? "");
      if (parsed) return parsed;
    } catch (err) {
      console.warn("[casefile] model call failed:", (err as Error).message);
    }
  }
  return null;
}

// ---------------- Storage ----------------

async function readRow(userId: string, matterId: string) {
  const sql = await pg();
  const rows = await sql`SELECT * FROM matter_case_files WHERE matter_id = ${matterId} AND user_id = ${userId} LIMIT 1`;
  return rows[0] ?? null;
}

async function save(
  userId: string,
  matterId: string,
  patch: { status: CaseFileStatus; progress: Progress | null; data?: { content: CaseFileContent; skipped: Array<{ name: string; reason: string }> } | null; error?: string | null; checkpointEventId?: string | null },
) {
  const sql = await pg();
  const now = Date.now();
  await sql`
    INSERT INTO matter_case_files (matter_id, user_id, status, progress, data, checkpoint_event_id, error, updated_at)
    VALUES (${matterId}, ${userId}, ${patch.status}, ${patch.progress ? sql.json(patch.progress as never) : null},
            ${patch.data ? sql.json(patch.data as never) : null}, ${patch.checkpointEventId ?? null}, ${patch.error ?? null}, ${now})
    ON CONFLICT (matter_id) DO UPDATE SET
      status = EXCLUDED.status,
      progress = EXCLUDED.progress,
      data = COALESCE(EXCLUDED.data, matter_case_files.data),
      checkpoint_event_id = COALESCE(EXCLUDED.checkpoint_event_id, matter_case_files.checkpoint_event_id),
      error = EXCLUDED.error,
      updated_at = EXCLUDED.updated_at
    WHERE matter_case_files.user_id = EXCLUDED.user_id`;
}

function toView(row: Record<string, any>): CaseFileView {
  const progress = (row.progress ?? null) as Progress | null;
  const data = (row.data ?? null) as { content?: CaseFileContent; skipped?: Array<{ name: string; reason: string }> } | null;
  return {
    status: row.status as CaseFileStatus,
    progress: { done: progress?.done ?? 0, total: progress?.total ?? 0, failed: progress?.failed ?? 0 },
    content: data?.content ?? null,
    skipped: data?.skipped ?? [],
    checkpointEventId: (row.checkpoint_event_id as string | null) ?? null,
    error: (row.error as string | null) ?? null,
    updatedAt: Number(row.updated_at),
  };
}

export async function getCaseFile(userId: string, matterId: string): Promise<CaseFileView | null> {
  const row = await readRow(userId, matterId);
  return row ? toView(row) : null;
}

// ---------------- Building ----------------

/** Lists what will be read and what cannot be, and queues every window. */
async function plan(userId: string, matterId: string): Promise<{ progress: Progress; skipped: Array<{ name: string; reason: string }> }> {
  const all = await listMatterDocuments(userId, matterId);
  // Read the record of events (FIR, statements, reports) before the paperwork around it, so a build cut short by the limits loses the least.
  const docs = [...all].sort((a, b) => kindPriority(a.kind ?? "other") - kindPriority(b.kind ?? "other") || a.createdAt - b.createdAt);
  const skipped: Array<{ name: string; reason: string }> = [];
  const queue: Progress["queue"] = [];
  let readable = 0;

  for (const doc of docs) {
    if (doc.duplicateOf) {
      const original = all.find((d) => d.id === doc.duplicateOf);
      skipped.push({ name: doc.name, reason: `Same text as "${original?.name ?? "an earlier upload"}", so it was read once.` });
      continue;
    }
    if (doc.status !== "ready") {
      skipped.push({ name: doc.name, reason: doc.note || "No readable text was found. A scanned document or photo needs OCR first." });
      continue;
    }
    if (readable >= MAX_DOCUMENTS) {
      skipped.push({ name: doc.name, reason: `Only the first ${MAX_DOCUMENTS} documents are read in one build.` });
      continue;
    }
    readable++;
    const windows = planWindows(await loadPages(userId, doc.id));
    for (let index = 0; index < windows.length; index++) {
      if (queue.length >= MAX_TOTAL_WINDOWS) {
        skipped.push({ name: doc.name, reason: "The rest of this document was not read: the build limit was reached." });
        break;
      }
      queue.push({ documentId: doc.id, index });
    }
  }
  return { progress: { queue, parts: {}, total: queue.length, done: 0, failed: 0 }, skipped };
}

const running = new Set<string>();

/**
 * Starts a build (or restarts it) and works on it for up to `budgetMs`. Call again while the status is "building".
 * A finished case file is returned as it is unless `restart` is set.
 */
export async function advanceCaseFile(
  userId: string,
  matterId: string,
  options: { restart?: boolean; budgetMs?: number } = {},
): Promise<CaseFileView> {
  const existing = await readRow(userId, matterId);
  if (existing && existing.status === "ready" && !options.restart) return toView(existing);
  if (running.has(matterId) && existing) return toView(existing);
  running.add(matterId);

  try {
    const started = Date.now();
    const budget = options.budgetMs ?? DEFAULT_BUDGET_MS;
    let progress: Progress;
    let skipped: Array<{ name: string; reason: string }> = (existing?.data as any)?.skipped ?? [];

    if (!existing || existing.status === "failed" || options.restart || !existing.progress) {
      const planned = await plan(userId, matterId);
      progress = planned.progress;
      skipped = planned.skipped;
      if (!progress.total) {
        await save(userId, matterId, {
          status: "failed",
          progress,
          data: { content: mergeCaseFile([]), skipped },
          error: "There is no readable text in this matter yet. Upload the documents, or the scanned pages once OCR is available.",
        });
        return (await getCaseFile(userId, matterId))!;
      }
      await save(userId, matterId, { status: "building", progress, data: { content: mergeCaseFile([]), skipped }, error: null });
    } else {
      progress = existing.progress as Progress;
    }

    const docs = await listMatterDocuments(userId, matterId);
    const nameOf = (id: string) => docs.find((d) => d.id === id)?.name ?? "document";
    const pageCache = new Map<string, PageText[]>();
    const pagesOf = async (id: string) => {
      if (!pageCache.has(id)) pageCache.set(id, await loadPages(userId, id));
      return pageCache.get(id)!;
    };

    while (progress.queue.length && Date.now() - started < budget) {
      const next = progress.queue[0];
      const windows = planWindows(await pagesOf(next.documentId));
      const target = windows[next.index];
      const reply = target ? await askWindow(nameOf(next.documentId), target.text) : null;
      progress.queue.shift();
      progress.done++;
      if (reply) (progress.parts[next.documentId] ??= []).push(reply);
      else progress.failed++;
      await save(userId, matterId, { status: "building", progress, error: null });
    }

    if (progress.queue.length) return (await getCaseFile(userId, matterId))!;

    // Everything has been read: check each item against its document and combine.
    const parts: DocumentParts[] = [];
    for (const doc of docs) {
      const windows = progress.parts[doc.id];
      if (!windows) continue;
      parts.push({ doc: { id: doc.id, name: doc.name, pages: doc.pages }, pages: normalizePages(await pagesOf(doc.id)), windows });
    }
    const content = mergeCaseFile(parts);

    let checkpointEventId: string | null = (existing?.checkpoint_event_id as string | null) ?? null;
    if (!checkpointEventId) {
      const event = await addMatterEvent({
        matterId,
        userId,
        type: "checkpoint",
        stage: "review",
        title: "Confirm the case facts",
        body: `Counsel read ${content.documents.length} document(s) and listed ${content.parties.length} parties, ${content.chronology.length} dated events and ${content.facts.length} facts. Check them before work continues.`,
      });
      checkpointEventId = event.id;
    }
    const allFailed = progress.failed >= progress.total;
    await save(userId, matterId, {
      status: allFailed ? "failed" : "ready",
      progress,
      data: { content, skipped },
      checkpointEventId,
      error: allFailed ? "The model could not read the documents. Try again in a moment." : null,
    });
    return (await getCaseFile(userId, matterId))!;
  } catch (err) {
    console.error("[casefile] build failed:", (err as Error).message);
    const row = await readRow(userId, matterId).catch(() => null);
    if (row) await save(userId, matterId, { status: "failed", progress: row.progress as Progress | null, error: "The case file could not be built. Try again." }).catch(() => {});
    throw err;
  } finally {
    running.delete(matterId);
  }
}
