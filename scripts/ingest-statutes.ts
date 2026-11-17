/**
 * Loads the statute sections written by scripts/statutes/extract_open_india_law.py into the library table.
 *
 *   npx tsx scripts/ingest-statutes.ts            checks the files and says what it would write (nothing is written)
 *   npx tsx scripts/ingest-statutes.ts --apply    writes to the database named by DATABASE_URL
 *
 * Safe to run again: a section is replaced by the same section, never duplicated.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../src/config.js";
import { upsertLibraryProvisions, type LibraryProvisionRow } from "../src/services/library/pg-store.js";

const DIR = join(import.meta.dirname, "..", "data", "statutes");
const apply = process.argv.includes("--apply");

function load(): LibraryProvisionRow[] {
  const rows: LibraryProvisionRow[] = [];
  const problems: string[] = [];
  for (const file of readdirSync(DIR).filter((f) => f.endsWith(".jsonl") && !f.endsWith(".rejects.jsonl")).sort()) {
    const seen = new Set<string>();
    for (const [i, line] of readFileSync(join(DIR, file), "utf8").split("\n").entries()) {
      if (!line.trim()) continue;
      const r = JSON.parse(line);
      const where = `${file}:${i + 1}`;
      if (!r.act_code || !r.section_num || !r.title || !r.text || !r.text_sha256) problems.push(`${where} is missing a required field`);
      else if (!/^[A-Z]+$/.test(r.act_code) || !/^\d+[A-Z]{0,2}$/.test(r.section_num)) problems.push(`${where} has an unexpected act code or section number: ${r.act_code} ${r.section_num}`);
      else if (seen.has(r.section_num)) problems.push(`${where} repeats section ${r.section_num}`);
      else {
        seen.add(r.section_num);
        rows.push({
          act_code: r.act_code,
          section_num: r.section_num,
          act_title: r.act_title,
          year: r.year ?? null,
          act_status: r.act_status,
          in_force: Boolean(r.in_force),
          title: r.title,
          chapter: r.chapter || null,
          text: r.text,
          text_sha256: r.text_sha256,
          source_url: r.source_url ?? null,
          source_publisher: r.source_publisher ?? null,
          dataset: r.dataset,
          licence: r.licence,
        });
      }
    }
  }
  if (problems.length) {
    console.error(`${problems.length} problem(s), nothing written:\n  ${problems.slice(0, 20).join("\n  ")}`);
    process.exit(1);
  }
  return rows;
}

const rows = load();
const perAct = new Map<string, number>();
for (const r of rows) perAct.set(r.act_code, (perAct.get(r.act_code) ?? 0) + 1);
console.log(`${rows.length} sections ready:`, Object.fromEntries(perAct));

if (!apply) {
  console.log("Dry run: nothing written. Add --apply to write to the database named by DATABASE_URL.");
} else if (!config.databaseUrl) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
} else {
  const host = (() => {
    try {
      return new URL(config.databaseUrl).hostname;
    } catch {
      return "(unreadable)";
    }
  })();
  console.log(`Writing to the database at ${host} ...`);
  const written = await upsertLibraryProvisions(rows);
  console.log(`Done: ${written} sections written.`);
  process.exit(0);
}
