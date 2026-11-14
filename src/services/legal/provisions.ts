/**
 * The statute library: one row per provision (a section of an Act), kept in PostgreSQL with a full-text
 * index. Administrators load official Act texts through the admin console; they are split into sections
 * and become searchable at once, independent of the embedding server. The built-in starter set is
 * stored here too.
 */
import { getSql } from "../db/postgres.js";
import { ensureEnglishTsv } from "../db/fts.js";
import { withSchemaLock } from "../db/schema-lock.js";
import { searchTerms } from "../documents/index.js";

export interface SectionDraft {
  section: string; // e.g. "483" or "438A"
  title: string;
  text: string;
}

export interface ProvisionHit {
  id: string;
  act: string;
  section: string;
  title: string;
  text: string;
  ratio?: string | null;
  source?: string | null;
  year?: number | null;
  rank: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS legal_provisions (
  id          TEXT PRIMARY KEY,
  act         TEXT NOT NULL,
  section     TEXT NOT NULL,
  title       TEXT NOT NULL DEFAULT '',
  text        TEXT NOT NULL,
  ratio       TEXT,
  source      TEXT,
  year        INT,
  category    TEXT,
  document_id TEXT,
  created_at  BIGINT NOT NULL,
  tsv         TSVECTOR GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(section, '') || ' ' || coalesce(act, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(text, '')), 'C')
  ) STORED
);
CREATE INDEX IF NOT EXISTS legal_provisions_tsv_idx ON legal_provisions USING GIN (tsv);
CREATE INDEX IF NOT EXISTS legal_provisions_document_idx ON legal_provisions (document_id);
ALTER TABLE legal_provisions ADD COLUMN IF NOT EXISTS indexed_at BIGINT;
CREATE INDEX IF NOT EXISTS legal_provisions_act_idx ON legal_provisions (act);
`;

let ready: Promise<void> | null = null;
async function pg() {
  const sql = getSql();
  if (!sql) throw new Error("DATABASE_URL is not configured.");
  if (!ready) {
    ready = withSchemaLock(sql, async (tx) => {
      await tx.unsafe(SCHEMA);
      await ensureEnglishTsv(
        tx,
        "legal_provisions",
        `setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(section, '') || ' ' || coalesce(act, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(text, '')), 'C')`,
      );
    })
      .catch((err) => {
        ready = null;
        throw err;
      });
  }
  await ready;
  return sql;
}

const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);

/**
 * Splits the text of an Act into its sections. Indian Acts number their sections in order
 * ("483. Special powers of High Court ... —", "483A. ..."), so a line that starts a new section is one
 * beginning with the next plausible number. Chapter headings and page furniture between sections are dropped.
 */
export function splitIntoSections(raw: string): SectionDraft[] {
  const lines = raw.replace(/\r\n?/g, "\n").split("\n").map((line) => line.trim());
  const starts: Array<{ index: number; section: string; rest: string }> = [];
  let last = 0;

  lines.forEach((line, index) => {
    const m = /^(\d{1,3})([A-Z]{0,2})\s*[.)]\s+(\S.*)$/.exec(line);
    if (!m) return;
    const n = Number(m[1]);
    // A new section is the next number, or a small step ahead (repealed sections can be skipped); a lettered
    // insertion such as 438A keeps the same number. Anything else is a numbered list inside a section.
    const isNext = n === last + 1 || (n > last && n <= last + 5) || (m[2] && n === last);
    if (!isNext && last !== 0) return;
    if (last === 0 && n > 3) return; // an Act starts at section 1 (or very near it)
    last = Math.max(last, n);
    starts.push({ index, section: `${m[1]}${m[2]}`, rest: m[3] });
  });

  const sections: SectionDraft[] = [];
  starts.forEach((start, i) => {
    const end = i + 1 < starts.length ? starts[i + 1].index : lines.length;
    const body = [start.rest, ...lines.slice(start.index + 1, end)]
      .filter((l) => l && !/^(CHAPTER\s+[IVXLC\d]+|PART\s+[IVXLC\d]+|\d+\s*$)/i.test(l))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (body.length < 12) return;
    // The heading is the opening phrase, up to the first full stop or dash.
    const heading = /^(.{3,200}?)(?:\.\s*[—–-]|\.\s|\s[—–-]\s|$)/.exec(body)?.[1] ?? body.slice(0, 120);
    sections.push({ section: start.section, title: heading.trim().replace(/[.:—–-]+$/, ""), text: body });
  });
  return sections;
}

export async function upsertProvisions(input: {
  act: string;
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
    id: `${slug(input.act)}-sec-${s.section.toLowerCase()}`,
    act: input.act,
    section: `Section ${s.section}`,
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
      INSERT INTO legal_provisions ${sql(batch, "id", "act", "section", "title", "text", "source", "year", "category", "document_id", "created_at")}
      ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, text = EXCLUDED.text, source = EXCLUDED.source,
        year = EXCLUDED.year, category = EXCLUDED.category, document_id = EXCLUDED.document_id,
        indexed_at = CASE WHEN legal_provisions.text = EXCLUDED.text AND legal_provisions.title = EXCLUDED.title THEN legal_provisions.indexed_at ELSE NULL END`;
  }
  return rows.length;
}

/** Stores the built-in starter provisions (once; existing rows, including ones an administrator replaced, are kept). */
export async function seedBuiltInProvisions(
  items: Array<{ id: string; act: string; section: string; title: string; statutoryText: string; ratio?: string; source: string; year?: number; category: string }>,
): Promise<number> {
  const sql = await pg();
  let added = 0;
  for (const item of items) {
    const rows = await sql`
      INSERT INTO legal_provisions (id, act, section, title, text, ratio, source, year, category, created_at)
      VALUES (${`builtin-${item.id}`}, ${item.act}, ${item.section}, ${item.title}, ${item.statutoryText}, ${item.ratio ?? null},
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
    SELECT id, act, section, title, text, ratio, source, year, ts_rank_cd(tsv, q.query) AS rank
    FROM legal_provisions
    CROSS JOIN (SELECT to_tsquery('english', ${terms.join(" | ")}) AS query) q
    WHERE tsv @@ q.query
    ORDER BY rank DESC, section ASC
    LIMIT ${limit}`;
  return rows.map((r) => ({
    id: r.id as string,
    act: r.act as string,
    section: r.section as string,
    title: r.title as string,
    text: r.text as string,
    ratio: (r.ratio as string | null) ?? null,
    source: (r.source as string | null) ?? null,
    year: r.year == null ? null : Number(r.year),
    rank: Number(r.rank),
  }));
}

export async function deleteProvisionsForDocument(documentId: string): Promise<number> {
  const sql = await pg();
  const rows = await sql`DELETE FROM legal_provisions WHERE document_id = ${documentId} RETURNING id`;
  return rows.length;
}

/** The shared connection for the corpus tools. */
export const provisionsDb = pg;

export async function countProvisions(): Promise<number> {
  const sql = await pg();
  const [row] = await sql`SELECT COUNT(*)::int AS n FROM legal_provisions`;
  return Number(row?.n ?? 0);
}
