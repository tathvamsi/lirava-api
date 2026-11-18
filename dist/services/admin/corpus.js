/**
 * Corpus maintenance for the internal admin tool: the statute library lives in PostgreSQL (`legal_provisions`)
 * and each provision is mirrored as one point in the Qdrant collection. PostgreSQL is the source of truth;
 * Qdrant can always be rebuilt from it. `indexed_at` records which provisions are already in the vector index.
 */
import crypto from "node:crypto";
import { config } from "../../config.js";
import { pgData } from "../data/pg.js";
import { extractPages } from "../documents/index.js";
import { embedMany } from "../legal/embeddings.js";
import { provisionsDb, searchProvisions, splitIntoSections } from "../legal/provisions.js";
import { getQdrant, searchStatutes, upsertLegalChunks } from "../legal/qdrant.js";
const COLUMNS = "id, act, section, title, text, ratio, source, year, category, document_id, created_at, indexed_at";
const toRow = (r) => ({
    ...r,
    year: r.year == null ? null : Number(r.year),
    created_at: Number(r.created_at),
    indexed_at: r.indexed_at == null ? null : Number(r.indexed_at),
});
const collection = () => config.qdrantCollection || "soli_legal_corpus";
/** Qdrant point ids must be numbers or UUIDs, so each provision id maps to a stable UUID. */
export function pointId(provisionId) {
    const h = crypto.createHash("sha1").update(`provision:${provisionId}`).digest("hex");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
const embeddingText = (p) => `${p.act} - ${p.section}: ${p.title}\n${p.text}`.slice(0, 7000);
export async function listActs() {
    const sql = await provisionsDb();
    const rows = await sql `
    SELECT act, MAX(year) AS year, MAX(source) AS source, COUNT(*)::int AS sections,
           COUNT(indexed_at)::int AS indexed, BOOL_AND(id LIKE 'builtin-%') AS built_in
    FROM legal_provisions GROUP BY act ORDER BY act`;
    return rows.map((r) => ({
        act: r.act,
        year: r.year == null ? null : Number(r.year),
        source: r.source ?? null,
        sections: Number(r.sections),
        indexed: Number(r.indexed),
        builtIn: Boolean(r.built_in),
    }));
}
export async function listProvisionRows(opts) {
    const sql = await provisionsDb();
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const offset = Math.max(opts.offset ?? 0, 0);
    const act = opts.act?.trim() || null;
    const q = opts.q?.trim() || null;
    const like = q ? `%${q.replace(/[%_\\]/g, (m) => `\\${m}`)}%` : null;
    const where = sql `WHERE (${act}::text IS NULL OR act = ${act}) AND (${like}::text IS NULL OR section ILIKE ${like} OR title ILIKE ${like} OR text ILIKE ${like})`;
    const [{ n }] = await sql `SELECT COUNT(*)::int AS n FROM legal_provisions ${where}`;
    const rows = await sql `
    SELECT ${sql.unsafe(COLUMNS)} FROM legal_provisions ${where}
    ORDER BY act, NULLIF(regexp_replace(section, '\\D', '', 'g'), '')::int NULLS LAST, section
    LIMIT ${limit} OFFSET ${offset}`;
    return { total: Number(n), provisions: rows.map(toRow) };
}
export async function getProvisionRow(id) {
    const sql = await provisionsDb();
    const [row] = await sql `SELECT ${sql.unsafe(COLUMNS)} FROM legal_provisions WHERE id = ${id}`;
    return row ? toRow(row) : null;
}
export async function corpusStats() {
    const sql = await provisionsDb();
    const [row] = await sql `
    SELECT COUNT(*)::int AS provisions, COUNT(DISTINCT act)::int AS acts, COUNT(indexed_at)::int AS indexed FROM legal_provisions`;
    let vector = { status: "offline", points: null };
    try {
        const info = await getQdrant().getCollection(collection());
        vector = { status: "online", points: Number(info.points_count ?? 0) };
    }
    catch (err) {
        vector = { status: "offline", points: null, error: String(err?.message || err).slice(0, 200) };
    }
    return {
        provisions: Number(row.provisions),
        acts: Number(row.acts),
        indexed: Number(row.indexed),
        pending: Number(row.provisions) - Number(row.indexed),
        vector,
        collection: collection(),
        embeddingModel: config.customEmbeddingModel,
        dimensions: config.embeddingDimensions,
    };
}
// ---------------- Editing ----------------
export async function updateProvisionRow(id, patch) {
    const sql = await provisionsDb();
    const current = await getProvisionRow(id);
    if (!current)
        return null;
    const title = patch.title?.trim() ?? current.title;
    const text = patch.text?.trim() ?? current.text;
    const ratio = patch.ratio === undefined ? current.ratio : patch.ratio?.trim() || null;
    const changed = title !== current.title || text !== current.text;
    await sql `UPDATE legal_provisions SET title = ${title}, text = ${text}, ratio = ${ratio},
            indexed_at = ${changed ? null : current.indexed_at} WHERE id = ${id}`;
    return getProvisionRow(id);
}
async function deletePoints(ids) {
    if (!ids.length)
        return;
    try {
        await getQdrant().delete(collection(), { wait: true, points: ids.map(pointId) });
    }
    catch (err) {
        console.warn("[corpus] could not remove vector points:", err?.message || err);
    }
}
export async function deleteProvisionRows(ids) {
    if (!ids.length)
        return 0;
    const sql = await provisionsDb();
    const rows = await sql `DELETE FROM legal_provisions WHERE id IN ${sql(ids)} RETURNING id`;
    await deletePoints(rows.map((r) => r.id));
    return rows.length;
}
export async function deleteAct(act) {
    const sql = await provisionsDb();
    const rows = await sql `DELETE FROM legal_provisions WHERE act = ${act} RETURNING id, document_id`;
    await deletePoints(rows.map((r) => r.id));
    // The uploads these sections came from go too, unless sections of another Act still depend on them.
    const documentIds = [...new Set(rows.map((r) => r.document_id).filter((d) => !!d))];
    if (documentIds.length) {
        const data = await pgData();
        await data `DELETE FROM app_admin_documents WHERE id IN ${data(documentIds)}
               AND NOT EXISTS (SELECT 1 FROM legal_provisions p WHERE p.document_id = app_admin_documents.id)`;
    }
    return rows.length;
}
async function selectForIndexing(opts) {
    const sql = await provisionsDb();
    const act = opts.act ?? null;
    const documentId = opts.documentId ?? null;
    const rows = await sql `
    SELECT ${sql.unsafe(COLUMNS)} FROM legal_provisions
    WHERE (${act}::text IS NULL OR act = ${act})
      AND (${documentId}::text IS NULL OR document_id = ${documentId})
      AND (${opts.ids ? sql `id IN ${sql(opts.ids.length ? opts.ids : [""])}` : sql `TRUE`})
      AND (${opts.pendingOnly ? sql `indexed_at IS NULL` : sql `TRUE`})
    ORDER BY act, id`;
    return rows.map(toRow);
}
/** Embeds the chosen provisions and writes them to the vector index. Failures are counted, not thrown. */
export async function indexProvisions(opts = {}) {
    const rows = await selectForIndexing(opts);
    const result = { total: rows.length, indexed: 0, failed: 0 };
    const sql = await provisionsDb();
    const CHUNK = 32;
    for (let i = 0; i < rows.length; i += CHUNK) {
        const chunk = rows.slice(i, i + CHUNK);
        try {
            const vectors = await embedMany(chunk.map(embeddingText), "passage");
            await upsertLegalChunks(chunk.map((p, k) => ({
                id: pointId(p.id),
                vector: vectors[k],
                payload: {
                    provision_id: p.id,
                    document_id: p.document_id ?? undefined,
                    act: p.act,
                    section: p.section,
                    title: p.title,
                    text: embeddingText(p),
                    statutoryText: p.text,
                    ratio: p.ratio ?? undefined,
                    source: p.source ?? undefined,
                    year: p.year ?? undefined,
                    category: p.category ?? undefined,
                },
            })));
            await sql `UPDATE legal_provisions SET indexed_at = ${Date.now()} WHERE id IN ${sql(chunk.map((p) => p.id))}`;
            result.indexed += chunk.length;
        }
        catch (err) {
            result.failed += chunk.length;
            result.error = String(err?.message || err).slice(0, 300);
            console.warn("[corpus] indexing batch failed:", result.error);
        }
        opts.onProgress?.(Math.min(i + CHUNK, rows.length), rows.length);
    }
    return result;
}
/** Points in the collection that did not come from a provision row (the original starter data). */
export async function removeUnlinkedPoints() {
    try {
        await getQdrant().delete(collection(), { wait: true, filter: { must: [{ is_empty: { key: "provision_id" } }] } });
    }
    catch (err) {
        console.warn("[corpus] could not clear unlinked points:", err?.message || err);
    }
}
const jobs = new Map();
export const listJobs = () => [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt).slice(0, 10);
export const getJob = (id) => jobs.get(id) ?? null;
/** Starts a re-index in the background and returns at once; poll the job for progress. */
export function startReindexJob(opts) {
    const running = [...jobs.values()].find((j) => j.status === "running");
    if (running)
        return running;
    const job = {
        id: `job_${crypto.randomUUID().slice(0, 8)}`,
        kind: opts.rebuild ? "rebuild" : opts.act ? `reindex: ${opts.act}` : opts.pendingOnly ? "index pending" : "reindex all",
        status: "running",
        total: 0,
        done: 0,
        indexed: 0,
        failed: 0,
        startedAt: Date.now(),
    };
    jobs.set(job.id, job);
    void (async () => {
        try {
            if (opts.rebuild)
                await removeUnlinkedPoints();
            const res = await indexProvisions({
                ...opts,
                onProgress: (done, total) => {
                    job.done = done;
                    job.total = total;
                },
            });
            job.total = res.total;
            job.indexed = res.indexed;
            job.failed = res.failed;
            job.error = res.error;
            job.status = res.failed && !res.indexed ? "failed" : "done";
        }
        catch (err) {
            job.status = "failed";
            job.error = String(err?.message || err).slice(0, 300);
        }
        finally {
            job.finishedAt = Date.now();
        }
    })();
    return job;
}
// ---------------- Preview & search ----------------
/** Reads a file and shows how it would be split into sections, without storing anything. */
export async function previewSections(fileName, mimeType, buffer) {
    const extracted = await extractPages(fileName, mimeType, buffer);
    if ("unsupported" in extracted)
        return { error: "Upload a PDF, Word or text file." };
    const text = extracted.pages.join("\n");
    if (text.trim().length < 50)
        return { error: "No readable text was found. A scanned document needs OCR first." };
    const sections = splitIntoSections(text);
    return { pages: extracted.pages.length, characters: text.length, sections };
}
/** Runs one question through both search routes so an administrator can see what each returns. */
export async function searchBoth(question, limit = 5) {
    const [text, vector] = await Promise.all([
        searchProvisions(question, limit).catch((err) => ({ error: String(err?.message || err) })),
        searchStatutes(question, limit).catch((err) => ({ error: String(err?.message || err) })),
    ]);
    return {
        text: Array.isArray(text)
            ? text.map((h) => ({ id: h.id, act: h.act, section: h.section, title: h.title, score: h.rank, excerpt: h.text.slice(0, 280) }))
            : text,
        vector: Array.isArray(vector)
            ? vector.map((h) => {
                const p = (h.payload ?? {});
                return { id: String(h.id), act: p.act, section: p.section, title: p.title, score: h.score, excerpt: String(p.statutoryText || p.text || "").slice(0, 280) };
            })
            : vector,
    };
}
