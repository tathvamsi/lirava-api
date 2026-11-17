import { getSql } from "../db/postgres.js";
import { withSchemaLock, LEGAL_SCHEMA_LOCK_KEY } from "../db/schema-lock.js";
import { keysFromCitationString } from "./cite-parse.js";
import type { CasePara, LibraryCase, LibraryProvision, LibraryStore } from "./types.js";

/**
 * The library in Postgres. Cases come from `legal_cases` (the seeded and, later, ingested judgments) and provisions
 * from `legal_provisions`. Two small tables are added: the lookup of citation keys, and the numbered paragraphs of
 * judgments (empty until judgments are ingested, which is why a quote can't be checked against a seed-only case).
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS library_cite_keys (
  key     TEXT NOT NULL,
  case_id TEXT NOT NULL,
  PRIMARY KEY (key, case_id)
);
CREATE INDEX IF NOT EXISTS library_cite_keys_case_idx ON library_cite_keys (case_id);

CREATE TABLE IF NOT EXISTS library_case_paras (
  case_id TEXT NOT NULL,
  para_no TEXT NOT NULL,
  seq     INT  NOT NULL,
  text    TEXT NOT NULL,
  PRIMARY KEY (case_id, para_no)
);

-- Reported judgments known by name, date, bench and citation. No judgment text lives here: this is the list a
-- citation is checked against, kept apart from legal_cases so that retrieval never returns a case with no text.
CREATE TABLE IF NOT EXISTS library_judgments (
  id               TEXT PRIMARY KEY,
  title            TEXT NOT NULL,
  petitioner       TEXT,
  respondent       TEXT,
  court            TEXT NOT NULL,
  year             INT  NOT NULL,
  decision_date    TEXT,
  bench            TEXT,
  disposal         TEXT,
  neutral_citation TEXT,
  scr_citation     TEXT,
  cnr              TEXT,
  pdf_path         TEXT,
  dataset          TEXT NOT NULL,
  licence          TEXT NOT NULL,
  ingested_at      BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS library_judgments_year_idx ON library_judgments (year);

-- Statute sections loaded from an official-text dataset, one row per section, with where each came from.
CREATE TABLE IF NOT EXISTS library_provisions (
  id               TEXT PRIMARY KEY,
  act_code         TEXT NOT NULL,
  section_num      TEXT NOT NULL,
  act_title        TEXT NOT NULL,
  year             INT,
  act_status       TEXT NOT NULL,
  in_force         BOOLEAN NOT NULL,
  title            TEXT NOT NULL,
  chapter          TEXT,
  text             TEXT NOT NULL,
  text_sha256      TEXT NOT NULL,
  source_url       TEXT,
  source_publisher TEXT,
  dataset          TEXT NOT NULL,
  licence          TEXT NOT NULL,
  ingested_at      BIGINT NOT NULL,
  UNIQUE (act_code, section_num)
);
`;

const ACT_YEARS: Record<string, number> = { BNSS: 2023, BNS: 2023, BSA: 2023, IPC: 1860, CRPC: 1973, CPC: 1908, IEA: 1872, NIA: 1881, ICA: 1872 };

let ready: Promise<void> | null = null;

async function ensureSchema(): Promise<void> {
  const sql = getSql();
  if (!sql) throw new Error("DATABASE_URL is not configured.");
  if (!ready) {
    const attempt: Promise<void> = withSchemaLock(
      sql,
      async (tx) => {
        await tx.unsafe(SCHEMA);
      },
      LEGAL_SCHEMA_LOCK_KEY,
    ).then(async () => {
      await syncCiteKeys();
    });
    // A failed attempt must not be remembered, so the next call tries again.
    attempt.catch(() => {
      ready = null;
    });
    ready = attempt;
  }
  await ready;
}

/** Makes sure every case in legal_cases can be found by each citation it carries. Safe to run again. */
export async function syncCiteKeys(): Promise<number> {
  const sql = getSql();
  if (!sql) return 0;
  const rows = await sql<Array<{ id: string; primary_citation: string; equivalent_citations: unknown; neutral_citation: string | null }>>`
    SELECT id, primary_citation, equivalent_citations, neutral_citation FROM legal_cases`;
  let added = 0;
  for (const row of rows) {
    const equivalents = Array.isArray(row.equivalent_citations) ? (row.equivalent_citations as unknown[]).filter((x): x is string => typeof x === "string") : [];
    const keys = new Set([row.primary_citation, row.neutral_citation, ...equivalents].flatMap((c) => keysFromCitationString(c)));
    for (const key of keys) {
      await sql`INSERT INTO library_cite_keys (key, case_id) VALUES (${key}, ${row.id}) ON CONFLICT DO NOTHING`;
      added++;
    }
  }
  return added;
}

interface CaseRow {
  id: string;
  case_title: string;
  primary_citation: string;
  court: string;
  year: number;
  para_count: number;
}

const toCase = (r: CaseRow): LibraryCase => ({
  id: r.id,
  title: r.case_title,
  court: r.court,
  year: r.year,
  citation_text: r.primary_citation,
  source_url: null,
  para_count: Number(r.para_count),
});

interface JudgmentRow {
  id: string;
  title: string;
  court: string;
  year: number;
  neutral_citation: string | null;
  scr_citation: string | null;
}

// No paragraphs are stored for these, so the verifier can confirm the citation and the case name but not a quotation.
const toJudgmentCase = (r: JudgmentRow): LibraryCase => ({
  id: r.id,
  title: r.title,
  court: r.court,
  year: r.year,
  citation_text: [r.scr_citation, r.neutral_citation].filter(Boolean).join("; "),
  source_url: null,
  para_count: 0,
});

export class PgLibraryStore implements LibraryStore {
  async findCases(key: string): Promise<LibraryCase[]> {
    await ensureSchema();
    const sql = getSql();
    if (!sql) return [];
    const rows = await sql<CaseRow[]>`
      SELECT c.id, c.case_title, c.primary_citation, c.court, c.year,
             (SELECT COUNT(*) FROM library_case_paras p WHERE p.case_id = c.id) AS para_count
      FROM library_cite_keys k JOIN legal_cases c ON c.id = k.case_id
      WHERE k.key = ${key}`;
    const judgments = await sql<JudgmentRow[]>`
      SELECT j.id, j.title, j.court, j.year, j.neutral_citation, j.scr_citation
      FROM library_cite_keys k JOIN library_judgments j ON j.id = k.case_id
      WHERE k.key = ${key}`;
    return [...rows.map(toCase), ...judgments.map(toJudgmentCase)];
  }

  async getCase(id: string): Promise<LibraryCase | null> {
    await ensureSchema();
    const sql = getSql();
    if (!sql) return null;
    const rows = await sql<CaseRow[]>`
      SELECT c.id, c.case_title, c.primary_citation, c.court, c.year,
             (SELECT COUNT(*) FROM library_case_paras p WHERE p.case_id = c.id) AS para_count
      FROM legal_cases c WHERE c.id = ${id}`;
    if (rows[0]) return toCase(rows[0]);
    const judgments = await sql<JudgmentRow[]>`
      SELECT id, title, court, year, neutral_citation, scr_citation FROM library_judgments WHERE id = ${id}`;
    return judgments[0] ? toJudgmentCase(judgments[0]) : null;
  }

  async getParas(caseId: string): Promise<CasePara[]> {
    await ensureSchema();
    const sql = getSql();
    if (!sql) return [];
    return sql<CasePara[]>`SELECT case_id, para_no, text FROM library_case_paras WHERE case_id = ${caseId} ORDER BY seq`;
  }

  async findProvision(actCode: string, sectionNum: string): Promise<LibraryProvision | null> {
    const sql = getSql();
    if (!sql) return null;
    const code = actCode.toUpperCase();
    // The loaded statute text comes first; the hand-written seed rows are the fallback for sections it does not hold.
    try {
      await ensureSchema();
      const loaded = await sql<Array<{ id: string; act_code: string; section_num: string; title: string; source_url: string | null; act_status: string; text: string }>>`
        SELECT id, act_code, section_num, title, source_url, act_status, text FROM library_provisions
        WHERE act_code = ${code} AND section_num = ${sectionNum.toUpperCase()} LIMIT 1`;
      if (loaded[0]) {
        const r = loaded[0];
        return { id: r.id, act_code: r.act_code, section_num: r.section_num, title: r.title, source: r.source_url, repealed: r.act_status === "repealed", text: r.text };
      }
    } catch {
      /* fall through to the seed table */
    }
    const candidates = ACT_YEARS[code] ? [code, `${code}_${ACT_YEARS[code]}`] : [code];
    const rows = await sql<Array<{ id: string; act_code: string; section_num: string; title: string; source: string | null }>>`
      SELECT id, act_code, section_num, title, source FROM legal_provisions
      WHERE UPPER(act_code) IN ${sql(candidates)} AND UPPER(section_num) = ${sectionNum.toUpperCase()}
      LIMIT 1`;
    return rows[0] ?? null;
  }
}

export const ensureLibrarySchema = ensureSchema;

export interface LibraryProvisionRow {
  act_code: string;
  section_num: string;
  act_title: string;
  year: number | null;
  act_status: string;
  in_force: boolean;
  title: string;
  chapter: string | null;
  text: string;
  text_sha256: string;
  source_url: string | null;
  source_publisher: string | null;
  dataset: string;
  licence: string;
}

export interface LibraryJudgmentRow {
  id: string;
  title: string;
  petitioner: string | null;
  respondent: string | null;
  court: string;
  year: number;
  decision_date: string | null;
  bench: string | null;
  disposal: string | null;
  neutral_citation: string | null;
  scr_citation: string | null;
  cnr: string | null;
  pdf_path: string | null;
  dataset: string;
  licence: string;
}

/** Adds or refreshes reported judgments and every citation key they can be found by. Re-running changes nothing. */
export async function upsertLibraryJudgments(rows: LibraryJudgmentRow[]): Promise<{ judgments: number; keys: number }> {
  await ensureSchema();
  const sql = getSql();
  if (!sql) throw new Error("DATABASE_URL is not configured.");
  const now = Date.now();
  let judgments = 0;
  let keys = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const slice = rows.slice(i, i + 500);
    const batch = slice.map((r) => ({ ...r, ingested_at: now }));
    await sql`
      INSERT INTO library_judgments ${sql(batch, "id", "title", "petitioner", "respondent", "court", "year", "decision_date", "bench", "disposal", "neutral_citation", "scr_citation", "cnr", "pdf_path", "dataset", "licence", "ingested_at")}
      ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, petitioner = EXCLUDED.petitioner, respondent = EXCLUDED.respondent,
        court = EXCLUDED.court, year = EXCLUDED.year, decision_date = EXCLUDED.decision_date, bench = EXCLUDED.bench,
        disposal = EXCLUDED.disposal, neutral_citation = EXCLUDED.neutral_citation, scr_citation = EXCLUDED.scr_citation,
        cnr = EXCLUDED.cnr, pdf_path = EXCLUDED.pdf_path, dataset = EXCLUDED.dataset, licence = EXCLUDED.licence,
        ingested_at = EXCLUDED.ingested_at`;
    judgments += batch.length;
    const keyRows = slice.flatMap((r) =>
      [...new Set([r.neutral_citation, r.scr_citation].flatMap((c) => (c ? keysFromCitationString(c) : [])))].map((key) => ({ key, case_id: r.id })),
    );
    if (keyRows.length) {
      await sql`INSERT INTO library_cite_keys ${sql(keyRows, "key", "case_id")} ON CONFLICT DO NOTHING`;
      keys += keyRows.length;
    }
  }
  return { judgments, keys };
}

/** Adds or refreshes statute sections. Returns how many rows were written. Re-running with the same data changes nothing. */
export async function upsertLibraryProvisions(rows: LibraryProvisionRow[]): Promise<number> {
  await ensureSchema();
  const sql = getSql();
  if (!sql) throw new Error("DATABASE_URL is not configured.");
  const now = Date.now();
  let written = 0;
  for (let i = 0; i < rows.length; i += 200) {
    const batch = rows.slice(i, i + 200).map((r) => ({ id: `${r.act_code}:${r.section_num}`, ...r, ingested_at: now }));
    await sql`
      INSERT INTO library_provisions ${sql(batch, "id", "act_code", "section_num", "act_title", "year", "act_status", "in_force", "title", "chapter", "text", "text_sha256", "source_url", "source_publisher", "dataset", "licence", "ingested_at")}
      ON CONFLICT (id) DO UPDATE SET act_title = EXCLUDED.act_title, year = EXCLUDED.year, act_status = EXCLUDED.act_status,
        in_force = EXCLUDED.in_force, title = EXCLUDED.title, chapter = EXCLUDED.chapter, text = EXCLUDED.text,
        text_sha256 = EXCLUDED.text_sha256, source_url = EXCLUDED.source_url, source_publisher = EXCLUDED.source_publisher,
        dataset = EXCLUDED.dataset, licence = EXCLUDED.licence, ingested_at = EXCLUDED.ingested_at`;
    written += batch.length;
  }
  return written;
}
