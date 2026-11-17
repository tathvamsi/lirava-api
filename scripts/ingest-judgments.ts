/**
 * Loads the judgment records written by scripts/judgments/extract_sc_metadata.py into the library tables.
 *
 *   npx tsx scripts/ingest-judgments.ts            checks the file and says what it would write (nothing is written)
 *   npx tsx scripts/ingest-judgments.ts --apply    writes to the database named by DATABASE_URL
 *
 * Safe to run again: a judgment is replaced by the same judgment, never duplicated.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../src/config.js";
import { keysFromCitationString } from "../src/services/library/cite-parse.js";
import { upsertLibraryJudgments, type LibraryJudgmentRow } from "../src/services/library/pg-store.js";

const FILE = join(import.meta.dirname, "..", "data", "judgments", "sc.jsonl");
const apply = process.argv.includes("--apply");

function load(): LibraryJudgmentRow[] {
  const rows: LibraryJudgmentRow[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const [i, line] of readFileSync(FILE, "utf8").split("\n").entries()) {
    if (!line.trim()) continue;
    const r = JSON.parse(line);
    const where = `sc.jsonl:${i + 1}`;
    if (!r.id || !r.title || !r.year || !r.dataset || !r.licence) problems.push(`${where} is missing a required field`);
    else if (!r.neutral_citation && !r.scr_citation) problems.push(`${where} has no citation`);
    else if (seen.has(r.id)) problems.push(`${where} repeats ${r.id}`);
    else if ([r.neutral_citation, r.scr_citation].some((c) => c && keysFromCitationString(c).length === 0)) problems.push(`${where} has a citation the parser cannot read: ${r.neutral_citation} / ${r.scr_citation}`);
    else {
      seen.add(r.id);
      rows.push({
        id: r.id,
        title: r.title,
        petitioner: r.petitioner || null,
        respondent: r.respondent || null,
        court: r.court,
        year: r.year,
        decision_date: r.decision_date || null,
        bench: r.bench || null,
        disposal: r.disposal || null,
        neutral_citation: r.neutral_citation || null,
        scr_citation: r.scr_citation || null,
        cnr: r.cnr || null,
        pdf_path: r.pdf_path || null,
        languages: Array.isArray(r.languages) && r.languages.length ? r.languages.join(",") : null,
        dataset: r.dataset,
        licence: r.licence,
      });
    }
  }
  if (problems.length) {
    console.error(`${problems.length} problem(s), nothing written:\n  ${problems.slice(0, 20).join("\n  ")}`);
    process.exit(1);
  }
  return rows;
}

const rows = load();
const years = rows.map((r) => r.year);
console.log(`${rows.length} judgments ready, ${Math.min(...years)}..${Math.max(...years)}`);

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
  const { judgments, keys } = await upsertLibraryJudgments(rows);
  console.log(`Done: ${judgments} judgments and ${keys} citation keys written.`);
  process.exit(0);
}
