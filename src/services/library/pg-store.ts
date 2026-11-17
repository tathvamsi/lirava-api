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
    return rows.map(toCase);
  }

  async getCase(id: string): Promise<LibraryCase | null> {
    await ensureSchema();
    const sql = getSql();
    if (!sql) return null;
    const rows = await sql<CaseRow[]>`
      SELECT c.id, c.case_title, c.primary_citation, c.court, c.year,
             (SELECT COUNT(*) FROM library_case_paras p WHERE p.case_id = c.id) AS para_count
      FROM legal_cases c WHERE c.id = ${id}`;
    return rows[0] ? toCase(rows[0]) : null;
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
    const candidates = ACT_YEARS[code] ? [code, `${code}_${ACT_YEARS[code]}`] : [code];
    const rows = await sql<Array<{ id: string; act_code: string; section_num: string; title: string; source: string | null }>>`
      SELECT id, act_code, section_num, title, source FROM legal_provisions
      WHERE UPPER(act_code) IN ${sql(candidates)} AND UPPER(section_num) = ${sectionNum.toUpperCase()}
      LIMIT 1`;
    return rows[0] ?? null;
  }
}
