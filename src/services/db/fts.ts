import type postgres from "postgres";

/**
 * Makes sure a table's generated `tsv` search column uses English stemming ("cancel" finds "cancellation").
 * Tables created by an earlier version used no stemming; they are upgraded in place the first time.
 */
export async function ensureEnglishTsv(sql: postgres.Sql, table: string, expression: string): Promise<void> {
  const [row] = await sql`
    SELECT pg_get_expr(d.adbin, d.adrelid) AS expr
    FROM pg_attrdef d
    JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
    WHERE d.adrelid = ${table}::regclass AND a.attname = 'tsv'`;
  if (row && !String(row.expr).includes("english")) {
    await sql.unsafe(
      `DROP INDEX IF EXISTS ${table}_tsv_idx;
       ALTER TABLE ${table} DROP COLUMN tsv;
       ALTER TABLE ${table} ADD COLUMN tsv TSVECTOR GENERATED ALWAYS AS (${expression}) STORED;
       CREATE INDEX ${table}_tsv_idx ON ${table} USING GIN (tsv);`,
    );
  }
}
