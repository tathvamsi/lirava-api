/**
 * The statute library: one row per provision (a section of an Act), kept in PostgreSQL with a full-text
 * index. Administrators load official Act texts through the admin console; they are split into sections
 * and become searchable at once, independent of the embedding server. The built-in starter set is
 * stored here too.
 */
import { getSql } from "../db/postgres.js";
import { ensureEnglishTsv } from "../db/fts.js";
import { withSchemaLock, LEGAL_SCHEMA_LOCK_KEY } from "../db/schema-lock.js";
import { searchTerms } from "../documents/index.js";
import {
  splitIntoSections,
  parseCpcOrders,
  parseBareAct,
  extractStructuralElements,
  type SectionDraft,
  type ParsedProvision,
  type ParseOptions,
} from "./parser.js";

export {
  splitIntoSections,
  parseCpcOrders,
  parseBareAct,
  extractStructuralElements,
  type SectionDraft,
  type ParsedProvision,
  type ParseOptions,
};

export interface LegalProvisionRow {
  id: string;
  act: string;
  act_code?: string;
  section: string;
  section_num?: string;
  title: string;
  text: string;
  ratio?: string | null;
  source?: string | null;
  year?: number | null;
  category?: string | null;
  document_id?: string | null;
  created_at: number;
  indexed_at?: number | null;
  rank?: number;
}

export type ProvisionHit = LegalProvisionRow;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS legal_provisions (
  id          TEXT PRIMARY KEY,
  act         TEXT NOT NULL,
  act_code    TEXT,
  section     TEXT NOT NULL,
  section_num TEXT,
  title       TEXT NOT NULL DEFAULT '',
  text        TEXT NOT NULL,
  ratio       TEXT,
  source      TEXT,
  year        INT,
  category    TEXT,
  document_id TEXT,
  created_at  BIGINT NOT NULL,
  indexed_at  BIGINT,
  tsv         TSVECTOR GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(section, '') || ' ' || coalesce(act_code, '') || ' ' || coalesce(act, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(text, '') || ' ' || coalesce(ratio, '')), 'C')
  ) STORED
);
ALTER TABLE legal_provisions ADD COLUMN IF NOT EXISTS act_code TEXT;
ALTER TABLE legal_provisions ADD COLUMN IF NOT EXISTS section_num TEXT;
ALTER TABLE legal_provisions ADD COLUMN IF NOT EXISTS indexed_at BIGINT;
CREATE INDEX IF NOT EXISTS legal_provisions_tsv_idx ON legal_provisions USING GIN (tsv);
CREATE INDEX IF NOT EXISTS legal_provisions_act_code_sec_idx ON legal_provisions (act_code, section_num);
CREATE INDEX IF NOT EXISTS legal_provisions_document_idx ON legal_provisions (document_id);
CREATE INDEX IF NOT EXISTS legal_provisions_act_idx ON legal_provisions (act);

UPDATE legal_provisions
SET act_code = CASE
  WHEN act ILIKE '%Nagarik Suraksha%' OR act ILIKE '%BNSS%' THEN 'BNSS'
  WHEN act ILIKE '%Nyaya Sanhita%' OR act ILIKE '%BNS%' THEN 'BNS'
  WHEN act ILIKE '%Sakshya%' OR act ILIKE '%BSA%' THEN 'BSA'
  WHEN act ILIKE '%Civil Procedure%' OR act ILIKE '%CPC%' THEN 'CPC'
  WHEN act ILIKE '%Criminal Procedure%' OR act ILIKE '%CrPC%' THEN 'CRPC'
  WHEN act ILIKE '%Penal Code%' OR act ILIKE '%IPC%' THEN 'IPC'
  WHEN act ILIKE '%Contract%' OR act ILIKE '%ICA%' THEN 'ICA'
  WHEN act ILIKE '%Negotiable%' OR act ILIKE '%NIA%' THEN 'NIA'
  ELSE UPPER(SPLIT_PART(act, ' ', 1))
END
WHERE act_code IS NULL;

UPDATE legal_provisions
SET section_num = REGEXP_REPLACE(section, '^(Order\\s+[A-Z0-9]+\\s+Rule\\s+[A-Z0-9]+|Section\\s+)', '', 'i')
WHERE section_num IS NULL;
`;

let ready: Promise<void> | null = null;
async function pg() {
  const sql = getSql();
  if (!sql) throw new Error("DATABASE_URL is not configured.");
  if (!ready) {
    ready = withSchemaLock(
      sql,
      async (tx) => {
        await tx.unsafe(SCHEMA);
        await ensureEnglishTsv(
          tx,
          "legal_provisions",
          `setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(section, '') || ' ' || coalesce(act_code, '') || ' ' || coalesce(act, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(text, '') || ' ' || coalesce(ratio, '')), 'C')`,
        );
      },
      LEGAL_SCHEMA_LOCK_KEY,
    ).catch((err) => {
      ready = null;
      throw err;
    });
  }
  await ready;
  return sql;
}

export async function ensureLegalProvisionsSchema(): Promise<void> {
  await pg();
}

const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);

export async function upsertProvisions(input: {
  act: string;
  actCode?: string | null;
  year?: number | null;
  source?: string | null;
  category?: string | null;
  documentId?: string | null;
  sections: SectionDraft[];
}): Promise<number> {
  if (!input.sections.length) return 0;
  const sql = await pg();
  const now = Date.now();
  const rows = input.sections.map((s) => ({
    id: `${slug(input.act)}-sec-${s.section.toLowerCase().replace(/\s+/g, "-")}`,
    act: input.act,
    act_code: input.actCode ?? null,
    section: /^(Order|Section|Schedule)\b/i.test(s.section) ? s.section : `Section ${s.section}`,
    section_num: s.section.replace(/^(Order\s+[A-Z0-9]+\s+Rule\s+[A-Z0-9]+|Section\s+)/i, "").trim(),
    title: s.title,
    text: s.text,
    source: input.source ?? null,
    year: input.year ?? null,
    category: input.category ?? null,
    document_id: input.documentId ?? null,
    created_at: now,
  }));
  for (let i = 0; i < rows.length; i += 100) {
    const batch = rows.slice(i, i + 100);
    await sql`
      INSERT INTO legal_provisions ${sql(batch, "id", "act", "act_code", "section", "section_num", "title", "text", "source", "year", "category", "document_id", "created_at")}
      ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, text = EXCLUDED.text, source = EXCLUDED.source,
        year = EXCLUDED.year, category = EXCLUDED.category, document_id = EXCLUDED.document_id,
        act_code = COALESCE(EXCLUDED.act_code, legal_provisions.act_code),
        section_num = COALESCE(EXCLUDED.section_num, legal_provisions.section_num),
        indexed_at = CASE WHEN legal_provisions.text = EXCLUDED.text AND legal_provisions.title = EXCLUDED.title THEN legal_provisions.indexed_at ELSE NULL END`;
  }
  return rows.length;
}

/** Stores the built-in starter provisions (once; existing rows, including ones an administrator replaced, are kept). */
export async function seedBuiltInProvisions(
  items: Array<{
    id: string;
    act: string;
    act_code?: string;
    section: string;
    section_num?: string;
    title: string;
    statutoryText: string;
    ratio?: string;
    source: string;
    year?: number;
    category: string;
  }>,
): Promise<number> {
  const sql = await pg();
  let added = 0;
  for (const item of items) {
    const rows = await sql`
      INSERT INTO legal_provisions (id, act, act_code, section, section_num, title, text, ratio, source, year, category, created_at)
      VALUES (${`builtin-${item.id}`}, ${item.act}, ${item.act_code ?? null}, ${item.section}, ${item.section_num ?? null}, ${item.title}, ${item.statutoryText}, ${item.ratio ?? null},
              ${item.source}, ${item.year ?? null}, ${item.category}, ${Date.now()})
      ON CONFLICT (id) DO NOTHING RETURNING id`;
    added += rows.length;
  }
  return added;
}

export async function searchProvisions(question: string, limit = 4): Promise<ProvisionHit[]> {
  const terms = searchTerms(question);
  if (!terms.length) return [];
  const sql = await pg();
  const rows = await sql`
    SELECT id, act, act_code, section, section_num, title, text, ratio, source, year, category, document_id, created_at, indexed_at, ts_rank_cd(tsv, q.query) AS rank
    FROM legal_provisions
    CROSS JOIN (SELECT to_tsquery('english', ${terms.join(" | ")}) AS query) q
    WHERE tsv @@ q.query
    ORDER BY rank DESC, section ASC
    LIMIT ${limit}`;
  return rows.map((r) => ({
    id: r.id as string,
    act: r.act as string,
    act_code: (r.act_code as string | undefined) ?? undefined,
    section: r.section as string,
    section_num: (r.section_num as string | undefined) ?? undefined,
    title: r.title as string,
    text: r.text as string,
    ratio: (r.ratio as string | null) ?? null,
    source: (r.source as string | null) ?? null,
    year: r.year == null ? null : Number(r.year),
    category: (r.category as string | null) ?? null,
    document_id: (r.document_id as string | null) ?? null,
    created_at: Number(r.created_at || Date.now()),
    indexed_at: r.indexed_at == null ? null : Number(r.indexed_at),
    rank: Number(r.rank || 0),
  }));
}

export async function lookupProvision(
  actCode: string,
  sectionNum: string,
): Promise<LegalProvisionRow | null> {
  const sql = await pg();
  const cleanSec = sectionNum.replace(/^Section\s+/i, "").trim();
  const baseAct = actCode.replace(/_\d{4}$/, "").trim();
  const actPattern = `%${baseAct}%`;
  const secPattern = `%${cleanSec}%`;

  const rows = await sql<LegalProvisionRow[]>`
    SELECT id, act, act_code, section, section_num, title, text, ratio, source, year, category, document_id, created_at, indexed_at, 1.0 AS rank
    FROM legal_provisions
    WHERE (COALESCE(act_code, '') || ' ' || act ILIKE ${actPattern})
      AND (COALESCE(section_num, '') || ' ' || section ILIKE ${secPattern})
    LIMIT 1`;
  if (!rows.length) return null;
  const r = rows[0];
  return {
    id: r.id as string,
    act: r.act as string,
    act_code: (r.act_code as string | undefined) ?? undefined,
    section: r.section as string,
    section_num: (r.section_num as string | undefined) ?? undefined,
    title: r.title as string,
    text: r.text as string,
    ratio: (r.ratio as string | null) ?? null,
    source: (r.source as string | null) ?? null,
    year: r.year == null ? null : Number(r.year),
    category: (r.category as string | null) ?? null,
    document_id: (r.document_id as string | null) ?? null,
    created_at: Number(r.created_at || Date.now()),
    indexed_at: r.indexed_at == null ? null : Number(r.indexed_at),
    rank: Number(r.rank || 1),
  };
}

/** The shared connection for the corpus tools. */
export const provisionsDb = pg;
