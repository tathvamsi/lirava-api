import crypto from "node:crypto";
import { emit } from "../bus/index.js";
import { getConversation, listConversations, listRecentMessages } from "../chats/store.js";
import { pgData } from "../data/pg.js";
import { getPreferences } from "../preferences/index.js";
export const MATTER_STAGES = ["received", "reviewing", "drafting", "review", "closed"];
// ---------------- AGENTS ----------------
const toVakil = (r) => ({
    id: r.id,
    name: r.name,
    purpose: r.purpose || "",
    instructions: r.instructions || "",
    look: r.look && typeof r.look === "object" && Object.keys(r.look).length ? r.look : { color: "#3B82F6", shape: "circle" },
    status: r.status || "idle",
    activity: null,
    localAccess: r.local_access === true,
    model: r.model || null,
    createdAt: Number(r.created_at) || Date.now(),
});
/** The user's own agents plus the shared built-in ones. */
export async function listVakils(userId) {
    const sql = await pgData();
    const rows = await sql `SELECT * FROM app_vakils WHERE user_id = ${userId} OR user_id = '' ORDER BY created_at ASC, id ASC`;
    return rows.map(toVakil);
}
/** A Vakil is visible to its owner, and shared built-in agents (no owner) are visible to everyone. */
export async function getVakilForUser(id, userId) {
    const sql = await pgData();
    const rows = await sql `SELECT * FROM app_vakils WHERE id = ${id} AND (user_id = ${userId} OR user_id = '') LIMIT 1`;
    return rows[0] ? toVakil(rows[0]) : null;
}
export async function createVakil(input) {
    if (!input.userId)
        throw new Error("A Vakil needs an owner.");
    const sql = await pgData();
    const id = `vakil_${crypto.randomUUID().slice(0, 8)}`;
    const look = input.look && typeof input.look === "object" ? input.look : { color: "#1E3A8A", shape: "circle" };
    const rows = await sql `
    INSERT INTO app_vakils (id, user_id, name, purpose, instructions, look, status, created_at)
    VALUES (${id}, ${input.userId}, ${input.name}, ${input.purpose}, ${input.instructions || ""}, ${sql.json(look)}, 'idle', ${Date.now()})
    RETURNING *`;
    const vakil = toVakil(rows[0]);
    emit({ type: "vakil", vakilId: vakil.id, userId: input.userId, data: vakil });
    return vakil;
}
/** Only the owner can delete a Vakil; shared built-in agents cannot be deleted. */
export async function deleteVakil(id, userId) {
    if (!userId)
        return false;
    const sql = await pgData();
    const rows = await sql `DELETE FROM app_vakils WHERE id = ${id} AND user_id = ${userId} RETURNING id`;
    if (rows.length) {
        emit({ type: "vakil_deleted", vakilId: id, userId, data: { id } });
        return true;
    }
    return false;
}
// ---------------- MATTERS ----------------
const toMatter = (r) => ({
    id: r.id,
    userId: r.user_id,
    title: r.title,
    client: r.client,
    court: r.court,
    status: r.status,
    nextDate: r.next_date ?? null,
    notes: r.notes,
    stage: MATTER_STAGES.includes(r.stage) ? r.stage : "received",
    intake: r.intake ?? null,
    handedOverAt: r.handed_over_at == null ? null : Number(r.handed_over_at),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
});
export async function listMatters(userId) {
    if (!userId)
        return [];
    const sql = await pgData();
    const rows = await sql `SELECT * FROM app_matters WHERE user_id = ${userId} ORDER BY updated_at DESC`;
    return rows.map(toMatter);
}
export async function createMatter(input) {
    if (!input.userId)
        throw new Error("A matter needs an owner.");
    const sql = await pgData();
    const now = Date.now();
    const id = `matter_${crypto.randomUUID()}`;
    const handedOverAt = input.intake ? now : null;
    const rows = await sql `
    INSERT INTO app_matters (id, user_id, title, client, court, status, next_date, notes, stage, intake, handed_over_at, created_at, updated_at)
    VALUES (${id}, ${input.userId}, ${input.title.trim()}, ${input.client?.trim() || ""}, ${input.court?.trim() || ""}, 'active',
            ${input.nextDate || null}, ${input.notes?.trim() || ""}, 'received', ${input.intake ? sql.json(input.intake) : null}, ${handedOverAt}, ${now}, ${now})
    RETURNING *`;
    const matter = toMatter(rows[0]);
    if (input.intake) {
        await addMatterEvent({ matterId: id, userId: input.userId, type: "stage", stage: "received", title: "Case handed over", body: "Your counsel has your brief and is going through it." });
    }
    return matter;
}
// ---------------- MATTER TIMELINE ----------------
const toEvent = (r) => ({
    id: r.id,
    matterId: r.matter_id,
    type: r.type,
    stage: r.stage ?? null,
    title: r.title,
    body: r.body,
    conversationId: r.conversation_id ?? null,
    artifactId: r.artifact_id ?? null,
    status: r.status ?? null,
    resolutionNote: r.resolution_note ?? null,
    createdAt: Number(r.created_at),
    resolvedAt: r.resolved_at == null ? null : Number(r.resolved_at),
});
export async function listMatterEvents(matterId, userId) {
    const sql = await pgData();
    const rows = await sql `SELECT * FROM app_matter_events WHERE matter_id = ${matterId} AND user_id = ${userId} ORDER BY created_at ASC`;
    return rows.map(toEvent);
}
/** Records something on a matter's timeline. A stage event also moves the matter to that stage. */
export async function addMatterEvent(input) {
    const sql = await pgData();
    const now = Date.now();
    const id = `mev_${crypto.randomUUID()}`;
    const rows = await sql `
    INSERT INTO app_matter_events (id, matter_id, user_id, type, stage, title, body, conversation_id, artifact_id, status, created_at)
    VALUES (${id}, ${input.matterId}, ${input.userId}, ${input.type}, ${input.stage ?? null}, ${input.title.slice(0, 200)}, ${(input.body ?? "").slice(0, 2000)},
            ${input.conversationId ?? null}, ${input.artifactId ?? null}, ${input.type === "checkpoint" ? "open" : null}, ${now})
    RETURNING *`;
    if (input.stage)
        await sql `UPDATE app_matters SET stage = ${input.stage}, updated_at = ${now} WHERE id = ${input.matterId} AND user_id = ${input.userId}`;
    emit({ type: "matter_event", userId: input.userId, vakilId: "", data: { matterId: input.matterId, id } });
    return toEvent(rows[0]);
}
/** The person answers a checkpoint: approve it, or send it back with a note. */
export async function resolveMatterCheckpoint(eventId, matterId, userId, resolution, note) {
    const sql = await pgData();
    const now = Date.now();
    const rows = await sql `
    UPDATE app_matter_events SET status = ${resolution}, resolution_note = ${note.slice(0, 2000) || null}, resolved_at = ${now}
    WHERE id = ${eventId} AND matter_id = ${matterId} AND user_id = ${userId} AND type = 'checkpoint' AND status = 'open'
    RETURNING *`;
    if (!rows[0])
        return null;
    const event = toEvent(rows[0]);
    await addMatterEvent({
        matterId: event.matterId,
        userId,
        type: "note",
        stage: resolution === "approved" ? "reviewing" : "drafting",
        title: resolution === "approved" ? "You approved: " + event.title : "You asked for changes: " + event.title,
        body: note,
        conversationId: event.conversationId,
    });
    return event;
}
const plain = (text, max) => {
    const flat = text.replace(/```[\s\S]*?```/g, " ").replace(/[#*_`>|\[\]]/g, "").replace(/\s+/g, " ").trim();
    return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
};
/** Counsel has picked up a question on a matter: the matter moves from "received" (or "ready for review") to "reviewing". */
export async function noteMatterWorkStarted(matterId, userId, conversationId, question) {
    const matter = await getMatterForUser(matterId, userId);
    if (!matter || matter.stage === "reviewing" || matter.stage === "drafting" || matter.stage === "closed")
        return;
    await addMatterEvent({ matterId, userId, type: "stage", stage: "reviewing", title: "Counsel started work", body: plain(question, 200), conversationId });
}
/** Counsel finished an answer on a matter: a short update, and one checkpoint waiting for the person's say-so. */
export async function noteMatterAnswered(matterId, userId, conversationId, answer) {
    const summary = plain(answer, 320);
    if (!summary)
        return;
    await addMatterEvent({ matterId, userId, type: "note", title: "Update from counsel", body: summary, conversationId });
    // Only a substantial answer is worth stopping the person for; a one-line reply is not.
    if (answer.length >= 600 && !(await hasOpenCheckpoint(matterId, userId))) {
        await addMatterEvent({
            matterId,
            userId,
            type: "checkpoint",
            stage: "review",
            title: "Review counsel's findings",
            body: "Check that counsel has the facts right before the next step.",
            conversationId,
        });
    }
}
/** A finished document on a matter: it goes on the case file, and the person is asked to approve it. */
export async function noteMatterDeliverable(conversationId, userId, artifact) {
    if (!conversationId)
        return;
    const matterId = (await getConversation(conversationId, userId))?.matterId;
    if (!matterId)
        return;
    await addMatterEvent({ matterId, userId, type: "deliverable", stage: "drafting", title: artifact.title, body: "Added to the case file.", conversationId, artifactId: artifact.id });
    await addMatterEvent({ matterId, userId, type: "checkpoint", stage: "review", title: `Approve “${artifact.title}”`, body: "Read the draft and approve it, or tell counsel what to change.", conversationId, artifactId: artifact.id });
}
/** True when this matter already has a checkpoint waiting for the person. */
export async function hasOpenCheckpoint(matterId, userId) {
    const sql = await pgData();
    const rows = await sql `SELECT 1 FROM app_matter_events WHERE matter_id = ${matterId} AND user_id = ${userId} AND type = 'checkpoint' AND status = 'open' LIMIT 1`;
    return rows.length > 0;
}
/** One of this user's matters, for building a prompt; someone else's matter is simply not found. */
export async function getMatterForUser(id, userId) {
    const sql = await pgData();
    const rows = await sql `SELECT * FROM app_matters WHERE id = ${id} AND user_id = ${userId} LIMIT 1`;
    return rows[0] ? toMatter(rows[0]) : null;
}
// ---------------- ARTIFACTS ----------------
const toArtifact = (r) => ({
    id: r.id,
    vakilId: r.vakil_id,
    conversationId: r.conversation_id || null,
    title: r.title,
    filename: r.filename || `${(r.title || "document").toLowerCase().replace(/[^a-z0-9]+/g, "_")}.pdf`,
    kind: r.kind || "document",
    content: r.content || "",
    summary: r.summary || null,
    metadata: r.metadata ?? null,
    fileId: r.file_id || null,
    pdfFileId: r.pdf_file_id || null,
    docxFileId: r.docx_file_id || null,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
});
export async function listArtifacts(userId, options) {
    if (!userId)
        return [];
    const sql = await pgData();
    const rows = options?.agentOnly
        ? await sql `SELECT * FROM app_artifacts WHERE user_id = ${userId} AND conversation_id IS NOT NULL AND vakil_id <> '' ORDER BY created_at DESC`
        : await sql `SELECT * FROM app_artifacts WHERE user_id = ${userId} ORDER BY created_at DESC`;
    return rows.map(toArtifact);
}
/** An artifact is returned only to the user who owns it. */
export async function getArtifactForUser(id, userId) {
    if (!userId)
        return null;
    const sql = await pgData();
    const rows = await sql `SELECT * FROM app_artifacts WHERE id = ${id} AND user_id = ${userId} LIMIT 1`;
    return rows[0] ? toArtifact(rows[0]) : null;
}
export async function deleteArtifactForUser(id, userId) {
    if (!userId)
        return false;
    const sql = await pgData();
    const rows = await sql `DELETE FROM app_artifacts WHERE id = ${id} AND user_id = ${userId} RETURNING id`;
    if (rows.length) {
        emit({ type: "artifact_deleted", id, userId });
        return true;
    }
    return false;
}
/** The same document saved twice (a second click on "Open" or "Download") returns the first copy. */
export async function findDuplicateArtifact(userId, conversationId, title, content) {
    if (!userId)
        return null;
    const sql = await pgData();
    const rows = await sql `
    SELECT * FROM app_artifacts
    WHERE user_id = ${userId} AND conversation_id IS NOT DISTINCT FROM ${conversationId} AND title = ${title} AND content = ${content}
    LIMIT 1`;
    return rows[0] ? toArtifact(rows[0]) : null;
}
export async function saveArtifact(data) {
    if (!data.userId)
        throw new Error("A document needs an owner.");
    const sql = await pgData();
    const id = `art_${crypto.randomUUID()}`;
    const now = Date.now();
    const filename = data.filename ||
        `${(data.title || "document").toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 50)}.pdf`;
    const rows = await sql `
    INSERT INTO app_artifacts (id, user_id, vakil_id, conversation_id, title, filename, kind, content, summary, metadata, file_id, pdf_file_id, docx_file_id, created_at, updated_at)
    VALUES (${id}, ${data.userId}, ${data.vakilId}, ${data.conversationId || null}, ${data.title}, ${filename}, ${data.kind || "document"}, ${data.content},
            ${data.summary || null}, ${data.metadata ? sql.json(data.metadata) : null}, ${data.fileId || null}, ${data.pdfFileId || null},
            ${data.docxFileId || null}, ${now}, ${now})
    RETURNING *`;
    const artifact = toArtifact(rows[0]);
    emit({ type: "artifact", vakilId: data.vakilId, userId: data.userId, data: artifact });
    void noteMatterDeliverable(data.conversationId, data.userId, { id: artifact.id, title: artifact.title }).catch((err) => console.error("[matters] could not record the deliverable:", err instanceof Error ? err.message : err));
    return artifact;
}
// ---------------- COUNTS (admin overview) ----------------
export async function countData() {
    const sql = await pgData();
    const [row] = await sql `
    SELECT (SELECT COUNT(*) FROM app_vakils)::int AS vakils,
           (SELECT COUNT(*) FROM app_artifacts)::int AS artifacts,
           (SELECT COUNT(*) FROM app_files)::int AS files`;
    return { vakils: Number(row.vakils), artifacts: Number(row.artifacts), files: Number(row.files) };
}
// ---------------- SNAPSHOT COMPILER ----------------
export async function getSnapshot(userId) {
    if (!userId)
        throw new Error("A signed-in user is required to build a snapshot.");
    // Everything here comes from PostgreSQL and only includes this user's rows (plus the shared built-in agents).
    const [vakils, messages, conversations, artifacts, preferences] = await Promise.all([
        listVakils(userId),
        listRecentMessages(userId),
        listConversations(userId),
        listArtifacts(userId),
        getPreferences(userId),
    ]);
    return {
        preferences,
        vakils,
        messages,
        artifacts,
        conversations,
        routines: [],
        triggers: [],
        rules: [],
        memories: [],
        skills: [],
        passwords: [],
        channels: [],
        computer: {
            mode: "local",
            docker: false,
            image: "default",
            model: "qwen2.5-7b",
            models: ["qwen2.5-7b"],
            computerTool: "none",
            hasKey: true,
            keySource: "env",
            cloudKey: null,
            openRouter: null,
            nvidia: null,
            groq: null,
            antigravity: null,
            triggersKey: null,
            sky: false,
            composio: false,
        },
        apps: [],
    };
}
