import { getDb } from "../db/index.js";
import { emit } from "../bus/index.js";
import crypto from "node:crypto";

export interface Dot {
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

export interface Conversation {
  id: string;
  dotId: string;
  matterId?: string | null;
  title: string;
  userId: string;
  createdAt: number;
  updatedAt?: number;
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

export interface Message {
  id: string;
  dotId: string;
  conversationId?: string | null;
  role: "user" | "assistant" | "system";
  text: string;
  title?: string | null;
  card?: string | null;
  source?: string | null;
  createdAt: number;
}

export interface DocumentArtifact {
  id: string;
  dotId: string;
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

const safeParseJson = <T>(val: string | null | undefined, fallback: T): T => {
  if (!val) return fallback;
  try {
    return JSON.parse(val);
  } catch {
    return fallback;
  }
};

// ---------------- DOTS ----------------
export function listDots(userId: string = ""): Dot[] {
  const db = getDb();
  const query = userId
    ? "SELECT * FROM dots WHERE user_id = ? OR user_id = '' ORDER BY created_at ASC"
    : "SELECT * FROM dots ORDER BY created_at ASC";
  const rows = (userId ? db.prepare(query).all(userId) : db.prepare(query).all()) as Array<Record<string, any>>;

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    purpose: r.purpose || "",
    instructions: r.instructions || "",
    look: safeParseJson(r.look, { color: "#3B82F6", shape: "circle" }),
    status: (r.status as Dot["status"]) || "idle",
    activity: null,
    localAccess: r.local_access === 1,
    model: r.model || null,
    createdAt: r.created_at || Date.now(),
  }));
}

export function getDot(id: string): Dot | null {
  const db = getDb();
  const r = db.prepare("SELECT * FROM dots WHERE id = ?").get(id) as Record<string, any> | undefined;
  if (!r) return null;

  return {
    id: r.id,
    name: r.name,
    purpose: r.purpose || "",
    instructions: r.instructions || "",
    look: safeParseJson(r.look, { color: "#3B82F6", shape: "circle" }),
    status: (r.status as Dot["status"]) || "idle",
    activity: null,
    localAccess: r.local_access === 1,
    model: r.model || null,
    createdAt: r.created_at || Date.now(),
  };
}

export function createDot(input: {
  name: string;
  purpose: string;
  instructions?: string;
  look?: any;
  userId?: string;
}): Dot {
  const db = getDb();
  const id = `vakil_${crypto.randomUUID().slice(0, 8)}`;
  const now = Date.now();
  const lookJson = JSON.stringify(input.look || { color: "#1E3A8A", shape: "circle" });

  db.prepare(`
    INSERT INTO dots (id, name, purpose, instructions, look, status, user_id, created_at)
    VALUES (?, ?, ?, ?, ?, 'idle', ?, ?)
  `).run(id, input.name, input.purpose, input.instructions || "", lookJson, input.userId || "", now);

  const dot = getDot(id)!;
  emit({ type: "dot", dotId: dot.id, data: dot });
  return dot;
}

export function deleteDot(id: string): boolean {
  const db = getDb();
  const res = db.prepare("DELETE FROM dots WHERE id = ?").run(id);
  if (res.changes > 0) {
    emit({ type: "dot_deleted", dotId: id, data: { id } });
    return true;
  }
  return false;
}

// ---------------- CONVERSATIONS & MESSAGES ----------------
export function listMatters(userId: string): Matter[] {
  const rows = getDb().prepare("SELECT * FROM matters WHERE user_id = ? ORDER BY updated_at DESC").all(userId) as Array<Record<string, any>>;
  return rows.map((r) => ({ id: r.id, userId: r.user_id, title: r.title, client: r.client, court: r.court, status: r.status, nextDate: r.next_date, notes: r.notes, createdAt: r.created_at, updatedAt: r.updated_at }));
}

export function createMatter(input: { userId: string; title: string; client?: string; court?: string; nextDate?: string; notes?: string }): Matter {
  const now = Date.now();
  const id = `matter_${crypto.randomUUID()}`;
  getDb().prepare(`INSERT INTO matters (id, user_id, title, client, court, status, next_date, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`)
    .run(id, input.userId, input.title.trim(), input.client?.trim() || "", input.court?.trim() || "", input.nextDate || null, input.notes?.trim() || "", now, now);
  return listMatters(input.userId).find((matter) => matter.id === id)!;
}

export function listConversations(userId: string = "", dotId?: string): Conversation[] {
  const db = getDb();
  let query = "SELECT * FROM conversations";
  const params: any[] = [];

  if (dotId) {
    query += " WHERE dot_id = ?";
    params.push(dotId);
    if (userId) {
      query += " AND (user_id = ? OR user_id = '')";
      params.push(userId);
    }
  } else if (userId) {
    query += " WHERE user_id = ? OR user_id = ''";
    params.push(userId);
  }
  query += " ORDER BY created_at DESC";

  const rows = db.prepare(query).all(...params) as Array<Record<string, any>>;
  return rows.map((r) => ({
    id: r.id,
    dotId: r.dot_id,
    matterId: r.matter_id || null,
    title: r.title || "Untitled Conversation",
    userId: r.user_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at || r.created_at,
  }));
}

export function getConversation(id: string): Conversation | null {
  const db = getDb();
  const r = db.prepare("SELECT * FROM conversations WHERE id = ?").get(id) as Record<string, any> | undefined;
  if (!r) return null;
  return {
    id: r.id,
    dotId: r.dot_id,
    matterId: r.matter_id || null,
    title: r.title || "Untitled Conversation",
    userId: r.user_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at || r.created_at,
  };
}

export function createConversation(
  dotId: string,
  title: string = "New Legal Consultation",
  userId: string = "",
  customId?: string,
  matterId?: string
): Conversation {
  const db = getDb();
  const id = customId || `conv_${crypto.randomUUID()}`;
  const now = Date.now();

  db.prepare(`
    INSERT INTO conversations (id, dot_id, title, user_id, matter_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, dotId, title, userId, matterId || null, now, now);

  const conv: Conversation = { id, dotId, matterId: matterId || null, title, userId, createdAt: now, updatedAt: now };
  emit({ type: "conversation", dotId, data: conv });
  return conv;
}

export function deleteConversation(id: string): boolean {
  const db = getDb();
  const conv = getConversation(id);
  const dotId = conv?.dotId;
  const userId = conv?.userId;

  try {
    db.exec("BEGIN");
    db.prepare("DELETE FROM messages WHERE conversation_id = ?").run(id);
    db.prepare("DELETE FROM artifacts WHERE conversation_id = ?").run(id);
    const res = db.prepare("DELETE FROM conversations WHERE id = ?").run(id);
    db.exec("COMMIT");

    emit({ type: "conversation_deleted", id, dotId, userId });
    return res.changes > 0 || true;
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw err;
  }
}

export function renameConversation(id: string, title: string): Conversation | null {
  const db = getDb();
  const now = Date.now();
  const res = db.prepare("UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?").run(title, now, id);
  if (res.changes === 0) return null;
  const conv = getConversation(id);
  if (conv) {
    emit({ type: "conversation", dotId: conv.dotId, data: conv });
  }
  return conv;
}

export function setConversationMatter(id: string, matterId: string | null): Conversation | null {
  const db = getDb();
  const now = Date.now();
  const res = db.prepare("UPDATE conversations SET matter_id = ?, updated_at = ? WHERE id = ?").run(matterId, now, id);
  if (res.changes === 0) return null;
  const conv = getConversation(id);
  if (conv) emit({ type: "conversation", dotId: conv.dotId, data: conv });
  return conv;
}

export function moveConversation(id: string, targetDotId: string): Conversation | null {
  const db = getDb();
  const now = Date.now();
  const res = db.prepare("UPDATE conversations SET dot_id = ?, updated_at = ? WHERE id = ?").run(targetDotId, now, id);
  if (res.changes === 0) return null;
  db.prepare("UPDATE messages SET dot_id = ? WHERE conversation_id = ?").run(targetDotId, id);
  const conv = getConversation(id);
  if (conv) {
    emit({ type: "conversation", dotId: targetDotId, data: conv });
  }
  return conv;
}

export function listMessages(dotId?: string, conversationId?: string): Message[] {
  const db = getDb();
  let query = "SELECT * FROM messages";
  const params: any[] = [];

  if (conversationId) {
    query += " WHERE conversation_id = ? ORDER BY created_at ASC";
    params.push(conversationId);
    const rows = db.prepare(query).all(...params) as Array<Record<string, any>>;
    return rows.map((r) => ({
      id: r.id,
      dotId: r.dot_id,
      conversationId: r.conversation_id || null,
      role: r.role,
      text: r.text || "",
      title: r.title || null,
      card: r.card || null,
      source: r.source || null,
      attachments: r.attachments ? safeParseJson(r.attachments, null) : null,
      artifactId: r.artifact_id || null,
      createdAt: r.created_at,
    }));
  } else if (dotId) {
    query += " WHERE dot_id = ? ORDER BY created_at DESC LIMIT 100";
    params.push(dotId);
  } else {
    query += " ORDER BY created_at DESC LIMIT 200";
  }

  const rows = db.prepare(query).all(...params) as Array<Record<string, any>>;
  return rows.reverse().map((r) => ({
    id: r.id,
    dotId: r.dot_id,
    conversationId: r.conversation_id || null,
    role: r.role,
    text: r.text || "",
    title: r.title || null,
    card: r.card || null,
    source: r.source || null,
    attachments: r.attachments ? safeParseJson(r.attachments, null) : null,
    artifactId: r.artifact_id || null,
    createdAt: r.created_at,
  }));
}

// ---------------- ARTIFACTS ----------------
export function listArtifacts(userId: string = "", options?: { agentOnly?: boolean }): DocumentArtifact[] {
  const db = getDb();
  const agentFilter = options?.agentOnly ? " AND conversation_id IS NOT NULL AND dot_id <> ''" : "";
  const query = userId
    ? `SELECT * FROM artifacts WHERE user_id = ?${agentFilter} ORDER BY created_at DESC`
    : `SELECT * FROM artifacts WHERE 1 = 1${agentFilter} ORDER BY created_at DESC`;
  const rows = (userId ? db.prepare(query).all(userId) : db.prepare(query).all()) as Array<Record<string, any>>;

  return rows.map((r) => ({
    id: r.id,
    dotId: r.dot_id,
    conversationId: r.conversation_id || null,
    title: r.title,
    filename: r.filename || `${(r.title || "document").toLowerCase().replace(/[^a-z0-9]+/g, "_")}.pdf`,
    kind: r.kind || "document",
    content: r.content || "",
    summary: r.summary || null,
    metadata: safeParseJson(r.metadata, null),
    fileId: r.file_id || null,
    pdfFileId: r.pdf_file_id || null,
    docxFileId: r.docx_file_id || null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

export function saveArtifact(data: {
  dotId: string;
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
  userId?: string;
}): DocumentArtifact {
  const db = getDb();
  const id = `art_${crypto.randomUUID()}`;
  const now = Date.now();
  const filename =
    data.filename ||
    `${(data.title || "document").toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 50)}.pdf`;
  const kind = data.kind || "document";

  db.prepare(`
    INSERT INTO artifacts (
      id, dot_id, conversation_id, user_id, title, filename, kind, content, summary, metadata, file_id, pdf_file_id, docx_file_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    data.dotId,
    data.conversationId || null,
    data.userId || "",
    data.title,
    filename,
    kind,
    data.content,
    data.summary || null,
    data.metadata ? JSON.stringify(data.metadata) : null,
    data.fileId || null,
    data.pdfFileId || null,
    data.docxFileId || null,
    now,
    now
  );

  const artifact: DocumentArtifact = {
    id,
    dotId: data.dotId,
    conversationId: data.conversationId || null,
    title: data.title,
    filename,
    kind,
    content: data.content,
    summary: data.summary || null,
    metadata: data.metadata || null,
    fileId: data.fileId || null,
    pdfFileId: data.pdfFileId || null,
    docxFileId: data.docxFileId || null,
    createdAt: now,
    updatedAt: now,
  };

  emit({ type: "artifact", dotId: data.dotId, data: artifact });
  return artifact;
}

// ---------------- SNAPSHOT COMPILER ----------------
export function getSnapshot(userId: string = "") {
  const dots = listDots(userId);
  const messages = listMessages();
  const artifacts = listArtifacts(userId);
  const conversations = listConversations(userId);

  return {
    dots,
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
