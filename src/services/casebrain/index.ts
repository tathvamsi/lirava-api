/**
 * The case knowledge tree: what the lawyer knows about a matter, as nodes under sections (Parties, Facts, Chronology, Issues,
 * Law, Arguments, Evidence, Open questions), with links between them (supports, contradicts, cites). The lawyer builds and
 * edits it by hand; the case file read from the papers can be imported into it as "proposed" nodes, which stay proposed until
 * the lawyer confirms them. Every node is scoped to its owner.
 */
import crypto from "node:crypto";
import { getSql } from "../db/postgres.js";
import { withSchemaLock } from "../db/schema-lock.js";
import { getCaseFile } from "../casefile/index.js";
import { buildOnboardingNodes, type OnboardingMatter } from "./onboarding.js";

export const NODE_KINDS = ["section", "party", "fact", "event", "issue", "law", "argument", "evidence", "question", "note"] as const;
export const NODE_STATUSES = ["proposed", "confirmed", "disputed"] as const;
export const NODE_RELATIONS = ["supports", "contradicts", "cites"] as const;
export type NodeKind = (typeof NODE_KINDS)[number];
export type NodeStatus = (typeof NODE_STATUSES)[number];
export type NodeRelation = (typeof NODE_RELATIONS)[number];

export interface NodeSource {
  documentId?: string;
  name?: string;
  page?: number;
  quote?: string;
}
export interface NodeLink {
  to: string;
  relation: NodeRelation;
}
export interface CaseNode {
  id: string;
  matterId: string;
  parentId: string | null;
  kind: NodeKind;
  title: string;
  body: string;
  /** For events: the ISO date it happened. */
  date: string | null;
  sources: NodeSource[];
  links: NodeLink[];
  status: NodeStatus;
  origin: "lawyer" | "document";
  position: number;
  createdAt: number;
  updatedAt: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS case_nodes (
  id          TEXT PRIMARY KEY,
  matter_id   TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  parent_id   TEXT,
  kind        TEXT NOT NULL,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL DEFAULT '',
  date        TEXT,
  sources     JSONB NOT NULL DEFAULT '[]',
  links       JSONB NOT NULL DEFAULT '[]',
  status      TEXT NOT NULL DEFAULT 'confirmed',
  origin      TEXT NOT NULL DEFAULT 'lawyer',
  origin_key  TEXT,
  position    INTEGER NOT NULL DEFAULT 0,
  created_at  BIGINT NOT NULL,
  updated_at  BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS case_nodes_matter_idx ON case_nodes (user_id, matter_id);
CREATE UNIQUE INDEX IF NOT EXISTS case_nodes_origin_key_idx ON case_nodes (matter_id, origin_key) WHERE origin_key IS NOT NULL;
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

type Row = Record<string, any>;
const toNode = (r: Row): CaseNode => ({
  id: r.id,
  matterId: r.matter_id,
  parentId: r.parent_id ?? null,
  kind: r.kind,
  title: r.title,
  body: r.body ?? "",
  date: r.date ?? null,
  sources: Array.isArray(r.sources) ? r.sources : [],
  links: Array.isArray(r.links) ? r.links : [],
  status: r.status,
  origin: r.origin === "document" ? "document" : "lawyer",
  position: Number(r.position),
  createdAt: Number(r.created_at),
  updatedAt: Number(r.updated_at),
});

const clip = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** The sections every case starts with, in the order a lawyer reads a file. */
const SECTIONS: Array<[string, string]> = [
  ["parties", "Parties"],
  ["facts", "Facts"],
  ["chronology", "Chronology"],
  ["issues", "Issues"],
  ["law", "Law and authorities"],
  ["arguments", "Arguments"],
  ["evidence", "Evidence and documents"],
  ["questions", "Open questions"],
];

export async function listNodes(userId: string, matterId: string): Promise<CaseNode[]> {
  const sql = await pg();
  const rows = await sql`SELECT * FROM case_nodes WHERE user_id = ${userId} AND matter_id = ${matterId} ORDER BY position ASC, created_at ASC`;
  return rows.map(toNode);
}

/** Creates the starting sections once. Safe to call again. */
export async function ensureSections(userId: string, matterId: string): Promise<void> {
  const sql = await pg();
  const now = Date.now();
  for (let i = 0; i < SECTIONS.length; i++) {
    const [key, title] = SECTIONS[i];
    await sql`
      INSERT INTO case_nodes (id, matter_id, user_id, parent_id, kind, title, status, origin, origin_key, position, created_at, updated_at)
      VALUES (${`node_${crypto.randomUUID()}`}, ${matterId}, ${userId}, NULL, 'section', ${title}, 'confirmed', 'lawyer', ${`section:${key}`}, ${i}, ${now}, ${now})
      ON CONFLICT (matter_id, origin_key) WHERE origin_key IS NOT NULL DO NOTHING`;
  }
}

/**
 * Seeds the tree with the facts a lawyer supplied during handover. These are
 * confirmed from the outset because they are the lawyer's own instructions,
 * unlike items extracted from uploaded papers, which remain proposed.
 */
export async function initializeMatterKnowledgeTree(userId: string, matterId: string, matter: OnboardingMatter): Promise<void> {
  await ensureSections(userId, matterId);
  const sections = new Map((await listNodes(userId, matterId)).filter((node) => node.kind === "section").map((node) => [node.title, node.id]));
  for (const entry of buildOnboardingNodes(matter)) {
    const parentId = sections.get(entry.section);
    if (!parentId) continue;
    await createNode(userId, matterId, {
      parentId,
      kind: entry.kind,
      title: entry.title,
      body: entry.body,
      date: entry.date,
      status: entry.status,
    });
  }
}

function cleanSources(raw: unknown): NodeSource[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .slice(0, 10)
    .map((s) => {
      const o = (s ?? {}) as Record<string, unknown>;
      const page = Number(o.page);
      return {
        ...(clip(o.documentId, 80) ? { documentId: clip(o.documentId, 80) } : {}),
        ...(clip(o.name, 200) ? { name: clip(o.name, 200) } : {}),
        ...(Number.isInteger(page) && page > 0 ? { page } : {}),
        ...(clip(o.quote, 600) ? { quote: clip(o.quote, 600) } : {}),
      };
    })
    .filter((s) => Object.keys(s).length > 0);
}

function cleanLinks(raw: unknown, selfId: string): NodeLink[] {
  if (!Array.isArray(raw)) return [];
  const out: NodeLink[] = [];
  for (const l of raw.slice(0, 30)) {
    const o = (l ?? {}) as Record<string, unknown>;
    const to = clip(o.to, 80);
    const relation = NODE_RELATIONS.find((r) => r === o.relation);
    if (to && to !== selfId && relation && !out.some((x) => x.to === to && x.relation === relation)) out.push({ to, relation });
  }
  return out;
}

export interface NodeInput {
  parentId?: unknown;
  kind?: unknown;
  title?: unknown;
  body?: unknown;
  date?: unknown;
  sources?: unknown;
  links?: unknown;
  status?: unknown;
}

const isoDate = (v: unknown) => (/^\d{4}-\d{2}-\d{2}$/.test(clip(v, 10)) ? clip(v, 10) : null);

/** Adds a node the lawyer wrote. A parent that is not this matter's own node is refused. */
export async function createNode(userId: string, matterId: string, input: NodeInput): Promise<CaseNode | null> {
  const kind = NODE_KINDS.find((k) => k === input.kind);
  const title = clip(input.title, 300);
  if (!kind || !title) return null;
  const sql = await pg();
  await ensureSections(userId, matterId);
  const parentId = clip(input.parentId, 80) || null;
  if (parentId) {
    const parent = await sql`SELECT 1 FROM case_nodes WHERE id = ${parentId} AND user_id = ${userId} AND matter_id = ${matterId}`;
    if (!parent.length) return null;
  }
  const status = NODE_STATUSES.find((s) => s === input.status) ?? "confirmed";
  const now = Date.now();
  const id = `node_${crypto.randomUUID()}`;
  const last = await sql`SELECT COALESCE(MAX(position), -1) AS p FROM case_nodes WHERE matter_id = ${matterId} AND user_id = ${userId} AND parent_id IS NOT DISTINCT FROM ${parentId}`;
  const rows = await sql`
    INSERT INTO case_nodes (id, matter_id, user_id, parent_id, kind, title, body, date, sources, links, status, origin, position, created_at, updated_at)
    VALUES (${id}, ${matterId}, ${userId}, ${parentId}, ${kind}, ${title}, ${clip(input.body, 8000)}, ${isoDate(input.date)},
            ${sql.json(cleanSources(input.sources) as any)}, ${sql.json(cleanLinks(input.links, id) as any)}, ${status}, 'lawyer', ${Number(last[0].p) + 1}, ${now}, ${now})
    RETURNING *`;
  return toNode(rows[0]);
}

/** Edits a node. Only the fields sent change. Moving a node under itself or its own descendant is refused. */
export async function updateNode(userId: string, matterId: string, id: string, input: NodeInput): Promise<CaseNode | null> {
  const sql = await pg();
  const found = await sql`SELECT * FROM case_nodes WHERE id = ${id} AND user_id = ${userId} AND matter_id = ${matterId}`;
  if (!found.length) return null;
  const cur = toNode(found[0]);
  let parentId = cur.parentId;
  if ("parentId" in input) {
    const next = clip(input.parentId, 80) || null;
    if (next) {
      const byId = new Map((await listNodes(userId, matterId)).map((n) => [n.id, n]));
      if (!byId.has(next)) return null;
      for (let at: string | null = next; at; at = byId.get(at)?.parentId ?? null) if (at === id) return null;
    }
    parentId = next;
  }
  const kind = "kind" in input ? NODE_KINDS.find((k) => k === input.kind) : cur.kind;
  const title = "title" in input ? clip(input.title, 300) : cur.title;
  const status = "status" in input ? NODE_STATUSES.find((s) => s === input.status) : cur.status;
  if (!kind || !title || !status) return null;
  const date = "date" in input ? isoDate(input.date) : cur.date;
  const body = "body" in input ? clip(input.body, 8000) : cur.body;
  const sources = "sources" in input ? cleanSources(input.sources) : cur.sources;
  const links = "links" in input ? cleanLinks(input.links, id) : cur.links;
  const rows = await sql`
    UPDATE case_nodes SET parent_id = ${parentId}, kind = ${kind}, title = ${title}, body = ${body}, date = ${date},
      sources = ${sql.json(sources as any)}, links = ${sql.json(links as any)}, status = ${status}, updated_at = ${Date.now()}
    WHERE id = ${id} AND user_id = ${userId} AND matter_id = ${matterId} RETURNING *`;
  return toNode(rows[0]);
}

/** Deletes a node and everything under it, and removes links that pointed at any of them. */
export async function deleteNode(userId: string, matterId: string, id: string): Promise<boolean> {
  const all = await listNodes(userId, matterId);
  if (!all.some((n) => n.id === id)) return false;
  const doomed = new Set<string>([id]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const n of all) {
      if (n.parentId && doomed.has(n.parentId) && !doomed.has(n.id)) {
        doomed.add(n.id);
        grew = true;
      }
    }
  }
  const sql = await pg();
  const ids = Array.from(doomed);
  await sql`DELETE FROM case_nodes WHERE user_id = ${userId} AND matter_id = ${matterId} AND id = ANY(${ids})`;
  for (const n of all) {
    if (doomed.has(n.id) || !n.links.some((l) => doomed.has(l.to))) continue;
    await sql`UPDATE case_nodes SET links = ${sql.json(n.links.filter((l) => !doomed.has(l.to)) as any)}, updated_at = ${Date.now()} WHERE id = ${n.id} AND user_id = ${userId}`;
  }
  return true;
}

/** Removes every node of a matter (used when the matter is deleted). */
export async function deleteMatterNodes(userId: string, matterId: string): Promise<void> {
  const sql = await pg();
  await sql`DELETE FROM case_nodes WHERE user_id = ${userId} AND matter_id = ${matterId}`;
}

/**
 * Imports what the case file read from the papers (parties, dated events, facts, claims) as proposed nodes, each keeping its
 * quote and page. Items already imported are skipped, so it can be run again after more papers are read.
 */
export async function importCaseFile(userId: string, matterId: string): Promise<{ added: number }> {
  const view = await getCaseFile(userId, matterId);
  await ensureSections(userId, matterId);
  const content = view?.content;
  if (!content) return { added: 0 };
  const sql = await pg();
  const sections = new Map<string, string>();
  for (const n of await listNodes(userId, matterId)) if (n.kind === "section") sections.set(n.title, n.id);
  const hash = (s: string) => crypto.createHash("sha1").update(s).digest("hex").slice(0, 16);
  type Src = { documentId: string; name: string; page: number };
  const items: Array<{ section: string; kind: NodeKind; title: string; body: string; date: string | null; src: Src; quote: string }> = [
    ...content.parties.map((p) => ({ section: "Parties", kind: "party" as const, title: p.name, body: p.role, date: null, src: p.source, quote: p.quote })),
    ...content.chronology.map((e) => ({ section: "Chronology", kind: "event" as const, title: e.what, body: "", date: e.date, src: e.source, quote: e.quote })),
    ...content.facts.map((f) => ({ section: "Facts", kind: "fact" as const, title: f.text, body: "", date: null, src: f.source, quote: f.quote })),
    ...content.claims.map((f) => ({ section: "Arguments", kind: "argument" as const, title: f.text, body: "Claim made in the papers.", date: null, src: f.source, quote: f.quote })),
  ];
  let added = 0;
  const now = Date.now();
  for (const item of items) {
    const parent = sections.get(item.section) ?? null;
    const key = `doc:${item.kind}:${hash(`${item.title}|${item.date ?? ""}|${item.src.documentId}|${item.src.page}`)}`;
    const rows = await sql`
      INSERT INTO case_nodes (id, matter_id, user_id, parent_id, kind, title, body, date, sources, links, status, origin, origin_key, position, created_at, updated_at)
      VALUES (${`node_${crypto.randomUUID()}`}, ${matterId}, ${userId}, ${parent}, ${item.kind}, ${item.title.slice(0, 300)}, ${item.body.slice(0, 2000)}, ${item.date},
              ${sql.json([{ documentId: item.src.documentId, name: item.src.name, page: item.src.page, quote: item.quote.slice(0, 600) }] as any)}, ${sql.json([] as any)},
              'proposed', 'document', ${key}, ${added}, ${now}, ${now})
      ON CONFLICT (matter_id, origin_key) WHERE origin_key IS NOT NULL DO NOTHING RETURNING id`;
    if (rows.length) added++;
  }
  return { added };
}
