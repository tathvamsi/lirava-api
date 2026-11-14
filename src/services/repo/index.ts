import crypto from "node:crypto";
import { emit } from "../bus/index.js";
import { listConversations, listRecentMessages } from "../chats/store.js";
import { pgData } from "../data/pg.js";
import { getPreferences } from "../preferences/index.js";

export type { Conversation, Message } from "../chats/store.js";

export interface Vakil {
  id: string;
  name: string;
  purpose: string;
  instructions: string;
  look: any;
  status: "idle" | "thinking" | "working" | "paused" | "error";
  activity?: string | null;
  localAccess?: boolean;
  model?: string | null;
  createdAt: number;
}

export interface Matter {
  id: string;
  userId: string;
  title: string;
  client: string;
  court: string;
  status: "active" | "on_hold" | "closed";
  nextDate: string | null;
  notes: string;
  createdAt: number;
  updatedAt: number;
}

export interface DocumentArtifact {
  id: string;
  vakilId: string;
  conversationId?: string | null;
  title: string;
  filename: string;
  kind: string;
  content: string;
  summary?: string | null;
  metadata?: any;
  fileId?: string | null;
  pdfFileId?: string | null;
  docxFileId?: string | null;
  createdAt: number;
  updatedAt: number;
}

type Row = Record<string, any>;

// ---------------- AGENTS ----------------
const toVakil = (r: Row): Vakil => ({
  id: r.id,
  name: r.name,
  purpose: r.purpose || "",
  instructions: r.instructions || "",
  look: r.look && typeof r.look === "object" && Object.keys(r.look).length ? r.look : { color: "#3B82F6", shape: "circle" },
  status: (r.status as Vakil["status"]) || "idle",
  activity: null,
  localAccess: r.local_access === true,
  model: r.model || null,
  createdAt: Number(r.created_at) || Date.now(),
});

/** The user's own agents plus the shared built-in ones. */
export async function listVakils(userId: string): Promise<Vakil[]> {
  const sql = await pgData();
  const rows = await sql`SELECT * FROM app_vakils WHERE user_id = ${userId} OR user_id = '' ORDER BY created_at ASC, id ASC`;
  return rows.map(toVakil);
}

/** A Vakil is visible to its owner, and shared built-in agents (no owner) are visible to everyone. */
export async function getVakilForUser(id: string, userId: string): Promise<Vakil | null> {
  const sql = await pgData();
  const rows = await sql`SELECT * FROM app_vakils WHERE id = ${id} AND (user_id = ${userId} OR user_id = '') LIMIT 1`;
  return rows[0] ? toVakil(rows[0]) : null;
}

export async function createVakil(input: {
  name: string;
  purpose: string;
  instructions?: string;
  look?: any;
  userId: string;
}): Promise<Vakil> {
  if (!input.userId) throw new Error("A Vakil needs an owner.");
  const sql = await pgData();
  const id = `vakil_${crypto.randomUUID().slice(0, 8)}`;
  const look = input.look && typeof input.look === "object" ? input.look : { color: "#1E3A8A", shape: "circle" };
  const rows = await sql`
    INSERT INTO app_vakils (id, user_id, name, purpose, instructions, look, status, created_at)
    VALUES (${id}, ${input.userId}, ${input.name}, ${input.purpose}, ${input.instructions || ""}, ${sql.json(look)}, 'idle', ${Date.now()})
    RETURNING *`;
  const vakil = toVakil(rows[0]);
  emit({ type: "vakil", vakilId: vakil.id, userId: input.userId, data: vakil });
  return vakil;
}

/** Only the owner can delete a Vakil; shared built-in agents cannot be deleted. */
export async function deleteVakil(id: string, userId: string): Promise<boolean> {
  if (!userId) return false;
  const sql = await pgData();
  const rows = await sql`DELETE FROM app_vakils WHERE id = ${id} AND user_id = ${userId} RETURNING id`;
  if (rows.length) {
    emit({ type: "vakil_deleted", vakilId: id, userId, data: { id } });
    return true;
  }
  return false;
}

// ---------------- MATTERS ----------------
const toMatter = (r: Row): Matter => ({
  id: r.id,
  userId: r.user_id,
  title: r.title,
  client: r.client,
  court: r.court,
  status: r.status,
  nextDate: r.next_date ?? null,
  notes: r.notes,
  createdAt: Number(r.created_at),
  updatedAt: Number(r.updated_at),
});

export async function listMatters(userId: string): Promise<Matter[]> {
  if (!userId) return [];
  const sql = await pgData();
  const rows = await sql`SELECT * FROM app_matters WHERE user_id = ${userId} ORDER BY updated_at DESC`;
  return rows.map(toMatter);
}

export async function createMatter(input: { userId: string; title: string; client?: string; court?: string; nextDate?: string; notes?: string }): Promise<Matter> {
  if (!input.userId) throw new Error("A matter needs an owner.");
  const sql = await pgData();
  const now = Date.now();
  const id = `matter_${crypto.randomUUID()}`;
  const rows = await sql`
    INSERT INTO app_matters (id, user_id, title, client, court, status, next_date, notes, created_at, updated_at)
    VALUES (${id}, ${input.userId}, ${input.title.trim()}, ${input.client?.trim() || ""}, ${input.court?.trim() || ""}, 'active',
            ${input.nextDate || null}, ${input.notes?.trim() || ""}, ${now}, ${now})
    RETURNING *`;
  return toMatter(rows[0]);
}

/** One of this user's matters, for building a prompt; someone else's matter is simply not found. */
export async function getMatterForUser(id: string, userId: string): Promise<Matter | null> {
  const sql = await pgData();
  const rows = await sql`SELECT * FROM app_matters WHERE id = ${id} AND user_id = ${userId} LIMIT 1`;
  return rows[0] ? toMatter(rows[0]) : null;
}

// ---------------- ARTIFACTS ----------------
const toArtifact = (r: Row): DocumentArtifact => ({
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

export async function listArtifacts(userId: string, options?: { agentOnly?: boolean }): Promise<DocumentArtifact[]> {
  if (!userId) return [];
  const sql = await pgData();
  const rows = options?.agentOnly
    ? await sql`SELECT * FROM app_artifacts WHERE user_id = ${userId} AND conversation_id IS NOT NULL AND vakil_id <> '' ORDER BY created_at DESC`
    : await sql`SELECT * FROM app_artifacts WHERE user_id = ${userId} ORDER BY created_at DESC`;
  return rows.map(toArtifact);
}

/** An artifact is returned only to the user who owns it. */
export async function getArtifactForUser(id: string, userId: string): Promise<DocumentArtifact | null> {
  if (!userId) return null;
  const sql = await pgData();
  const rows = await sql`SELECT * FROM app_artifacts WHERE id = ${id} AND user_id = ${userId} LIMIT 1`;
  return rows[0] ? toArtifact(rows[0]) : null;
}

export async function deleteArtifactForUser(id: string, userId: string): Promise<boolean> {
  if (!userId) return false;
  const sql = await pgData();
  const rows = await sql`DELETE FROM app_artifacts WHERE id = ${id} AND user_id = ${userId} RETURNING id`;
  if (rows.length) {
    emit({ type: "artifact_deleted", id, userId });
    return true;
  }
  return false;
}

/** The same document saved twice (a second click on "Open" or "Download") returns the first copy. */
export async function findDuplicateArtifact(userId: string, conversationId: string | null, title: string, content: string): Promise<DocumentArtifact | null> {
  if (!userId) return null;
  const sql = await pgData();
  const rows = await sql`
    SELECT * FROM app_artifacts
    WHERE user_id = ${userId} AND conversation_id IS NOT DISTINCT FROM ${conversationId} AND title = ${title} AND content = ${content}
    LIMIT 1`;
  return rows[0] ? toArtifact(rows[0]) : null;
}

export async function saveArtifact(data: {
  vakilId: string;
  conversationId?: string | null;
  title: string;
  filename?: string;
  kind?: string;
  content: string;
  summary?: string | null;
  metadata?: any;
  fileId?: string | null;
  pdfFileId?: string | null;
  docxFileId?: string | null;
  userId: string;
}): Promise<DocumentArtifact> {
  if (!data.userId) throw new Error("A document needs an owner.");
  const sql = await pgData();
  const id = `art_${crypto.randomUUID()}`;
  const now = Date.now();
  const filename =
    data.filename ||
    `${(data.title || "document").toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 50)}.pdf`;

  const rows = await sql`
    INSERT INTO app_artifacts (id, user_id, vakil_id, conversation_id, title, filename, kind, content, summary, metadata, file_id, pdf_file_id, docx_file_id, created_at, updated_at)
    VALUES (${id}, ${data.userId}, ${data.vakilId}, ${data.conversationId || null}, ${data.title}, ${filename}, ${data.kind || "document"}, ${data.content},
            ${data.summary || null}, ${data.metadata ? sql.json(data.metadata) : null}, ${data.fileId || null}, ${data.pdfFileId || null},
            ${data.docxFileId || null}, ${now}, ${now})
    RETURNING *`;
  const artifact = toArtifact(rows[0]);
  emit({ type: "artifact", vakilId: data.vakilId, userId: data.userId, data: artifact });
  return artifact;
}

// ---------------- COUNTS (admin overview) ----------------
export async function countData(): Promise<{ vakils: number; artifacts: number; files: number }> {
  const sql = await pgData();
  const [row] = await sql`
    SELECT (SELECT COUNT(*) FROM app_vakils)::int AS vakils,
           (SELECT COUNT(*) FROM app_artifacts)::int AS artifacts,
           (SELECT COUNT(*) FROM app_files)::int AS files`;
  return { vakils: Number(row.vakils), artifacts: Number(row.artifacts), files: Number(row.files) };
}

// ---------------- SNAPSHOT COMPILER ----------------
export async function getSnapshot(userId: string) {
  if (!userId) throw new Error("A signed-in user is required to build a snapshot.");
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
