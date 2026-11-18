import { getSql } from "../db/postgres.js";
import { withSchemaLock, LEGAL_SCHEMA_LOCK_KEY } from "../db/schema-lock.js";
import { searchTerms } from "../documents/index.js";
const CASES_SCHEMA = `
CREATE TABLE IF NOT EXISTS legal_cases (
  id                  TEXT PRIMARY KEY,
  case_title          TEXT NOT NULL,
  primary_citation    TEXT NOT NULL UNIQUE,
  equivalent_citations JSONB NOT NULL DEFAULT '[]'::jsonb,
  neutral_citation    TEXT,
  court               TEXT NOT NULL DEFAULT 'Supreme Court of India',
  year                INT NOT NULL,
  bench_description   TEXT,
  ratio               TEXT NOT NULL,
  principles          JSONB NOT NULL DEFAULT '[]'::jsonb,
  statutory_citations JSONB NOT NULL DEFAULT '[]'::jsonb,
  category            TEXT NOT NULL DEFAULT 'landmark',
  created_at          BIGINT NOT NULL,
  indexed_at          BIGINT,
  tsv                 TSVECTOR GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(case_title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(primary_citation, '') || ' ' || coalesce(neutral_citation, '') || ' ' || coalesce(bench_description, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(ratio, '')), 'C')
  ) STORED
);

CREATE UNIQUE INDEX IF NOT EXISTS legal_cases_primary_cit_idx ON legal_cases (primary_citation);
CREATE INDEX IF NOT EXISTS legal_cases_neutral_cit_idx ON legal_cases (neutral_citation);
CREATE INDEX IF NOT EXISTS legal_cases_year_idx ON legal_cases (year);
CREATE INDEX IF NOT EXISTS legal_cases_category_idx ON legal_cases (category);
CREATE INDEX IF NOT EXISTS legal_cases_tsv_idx ON legal_cases USING GIN (tsv);
`;
let ready = null;
export async function ensureLegalCasesSchema() {
    const sql = getSql();
    if (!sql)
        throw new Error("DATABASE_URL is not configured.");
    if (!ready) {
        ready = withSchemaLock(sql, async (tx) => {
            await tx.unsafe(CASES_SCHEMA);
        }, LEGAL_SCHEMA_LOCK_KEY).catch((err) => {
            ready = null;
            throw err;
        });
    }
    await ready;
}
export async function insertLegalCase(caseData) {
    await ensureLegalCasesSchema();
    const sql = getSql();
    if (!sql)
        throw new Error("DATABASE_URL is not configured.");
    const now = Date.now();
    const rows = await sql `
    INSERT INTO legal_cases (
      id, case_title, primary_citation, neutral_citation, court, year, ratio, category,
      equivalent_citations, bench_description, principles, statutory_citations, created_at
    ) VALUES (
      ${caseData.id}, ${caseData.case_title}, ${caseData.primary_citation}, ${caseData.neutral_citation ?? null},
      ${caseData.court || "Supreme Court of India"}, ${caseData.year}, ${caseData.ratio}, ${caseData.category || "landmark"},
      ${sql.json(caseData.equivalent_citations || [])}, ${caseData.bench_description ?? null},
      ${sql.json(caseData.principles || [])}, ${sql.json(caseData.statutory_citations || [])}, ${now}
    )
    ON CONFLICT (id) DO UPDATE SET
      case_title = EXCLUDED.case_title,
      primary_citation = EXCLUDED.primary_citation,
      equivalent_citations = EXCLUDED.equivalent_citations,
      neutral_citation = EXCLUDED.neutral_citation,
      bench_description = EXCLUDED.bench_description,
      ratio = EXCLUDED.ratio,
      principles = EXCLUDED.principles,
      statutory_citations = EXCLUDED.statutory_citations,
      category = EXCLUDED.category
    RETURNING id, case_title, primary_citation, equivalent_citations, neutral_citation,
              court, year, bench_description, ratio, principles, statutory_citations, category, created_at, indexed_at`;
    return rows[0];
}
export async function lookupCaseCitation(citation) {
    await ensureLegalCasesSchema();
    const sql = getSql();
    if (!sql)
        return null;
    const q = citation.trim();
    if (!q)
        return null;
    const rows = await sql `
    SELECT id, case_title, primary_citation, equivalent_citations, neutral_citation,
           court, year, bench_description, ratio, principles, statutory_citations, category, created_at, indexed_at
    FROM legal_cases
    WHERE LOWER(id) = ${q.toLowerCase()}
       OR LOWER(primary_citation) = ${q.toLowerCase()}
       OR LOWER(neutral_citation) = ${q.toLowerCase()}
       OR equivalent_citations::jsonb ? ${q}
    LIMIT 1`;
    const r = rows[0];
    if (!r)
        return null;
    // Defensive match verification (guards against mock environments returning entire catalog on miss)
    const qLower = q.toLowerCase();
    const matches = (r.id && r.id.toLowerCase() === qLower) ||
        (r.primary_citation && r.primary_citation.toLowerCase() === qLower) ||
        (r.neutral_citation && r.neutral_citation.toLowerCase() === qLower) ||
        (r.equivalent_citations &&
            Array.isArray(r.equivalent_citations) &&
            r.equivalent_citations.some((eq) => eq.toLowerCase() === qLower));
    if (!matches)
        return null;
    return r;
}
export async function searchCases(query, limit = 10) {
    await ensureLegalCasesSchema();
    const sql = getSql();
    if (!sql)
        return [];
    const trimmed = query.trim();
    if (!trimmed) {
        const rows = await sql `
      SELECT id, case_title, primary_citation, equivalent_citations, neutral_citation,
             court, year, bench_description, ratio, principles, statutory_citations, category, created_at, indexed_at
      FROM legal_cases
      LIMIT ${limit}`;
        return rows;
    }
    const terms = searchTerms(trimmed);
    const pattern = `%${trimmed.toLowerCase()}%`;
    if (!terms.length) {
        const rows = await sql `
      SELECT id, case_title, primary_citation, equivalent_citations, neutral_citation,
             court, year, bench_description, ratio, principles, statutory_citations, category, created_at, indexed_at
      FROM legal_cases
      WHERE LOWER(case_title) LIKE ${pattern}
         OR LOWER(ratio) LIKE ${pattern}
      LIMIT ${limit}`;
        return rows;
    }
    const rows = await sql `
    SELECT id, case_title, primary_citation, equivalent_citations, neutral_citation,
           court, year, bench_description, ratio, principles, statutory_citations, category, created_at, indexed_at,
           ts_rank_cd(tsv, q.query) AS rank
    FROM legal_cases
    CROSS JOIN (SELECT to_tsquery('english', ${terms.join(" | ")}) AS query) q
    WHERE tsv @@ q.query
       OR LOWER(case_title) LIKE ${pattern}
       OR LOWER(ratio) LIKE ${pattern}
    ORDER BY rank DESC, year DESC
    LIMIT ${limit}`;
    return rows;
}
