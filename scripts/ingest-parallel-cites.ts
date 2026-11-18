/**
 * Adds the SCC / AIR / SCC OnLine / SCALE citations learned from the Court's own printed parallel citations
 * (scripts/judgments/mine_parallel_cites.ts) to the library, so those citations can verify.
 *
 *   node --import tsx scripts/ingest-parallel-cites.ts [edges.jsonl] [--min-count=2]            dry run: says what it would add
 *   node --import tsx scripts/ingest-parallel-cites.ts [edges.jsonl] [--min-count=2] --apply    writes to the database named by DATABASE_URL
 *
 * Every added key is marked source = 'parallel' with the number of times it was printed, so it can be listed or removed:
 *   DELETE FROM library_cite_keys WHERE source = 'parallel';
 * Safe to run again: a key already stored is left alone.
 */
import "dotenv/config";
import { readFileSync, writeFileSync } from "node:fs";
import { getSql } from "../src/services/db/postgres.js";
import { ensureLibrarySchema } from "../src/services/library/pg-store.js";
import { selectPairs, type MinedEdge, type Resolver } from "../src/services/library/parallel-cites.js";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const minCount = Number(args.find((a) => a.startsWith("--min-count="))?.slice("--min-count=".length) ?? 2);
const file = args.find((a) => !a.startsWith("--")) ?? "data/judgments/parallel-cites.jsonl";
if (!Number.isInteger(minCount) || minCount < 1) {
  console.error("--min-count must be a whole number of 1 or more");
  process.exit(1);
}

const edges: MinedEdge[] = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
console.log(`${edges.length} mined pairs read from ${file}; keeping those printed at least ${minCount} time(s)`);

const sql = getSql();
if (!sql) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}
await ensureLibrarySchema();

// Every SCR / INSC key of the Supreme Court judgments we hold, with the case it points to.
const rows = await sql<Array<{ key: string; id: string; title: string }>>`
  SELECT k.key, j.id, j.title FROM library_cite_keys k JOIN library_judgments j ON j.id = k.case_id
  WHERE k.key LIKE 'SCR:%' OR k.key LIKE 'INSC:%'`;
const byKey = new Map<string, Array<{ id: string; title: string }>>();
for (const r of rows) byKey.set(r.key, [...(byKey.get(r.key) ?? []), { id: r.id, title: r.title }]);
const resolve: Resolver = (key) => {
  const hit = byKey.get(key);
  if (!hit?.length) return null;
  return hit.length > 1 ? "ambiguous" : hit[0];
};

const { accepted, rejected, examples } = selectPairs(edges, resolve, { minCount });

// A citation the library already holds for some case is never reassigned.
const existing = new Map<string, Set<string>>();
for (let i = 0; i < accepted.length; i += 2000) {
  const part = accepted.slice(i, i + 2000);
  const found = await sql<Array<{ key: string; case_id: string }>>`SELECT key, case_id FROM library_cite_keys WHERE key IN ${sql(part.map((a) => a.key))}`;
  for (const f of found) existing.set(f.key, new Set([...(existing.get(f.key) ?? []), f.case_id]));
}
const toAdd = accepted.filter((a) => !existing.has(a.key));
const alreadyThere = accepted.filter((a) => existing.get(a.key)?.has(a.caseId)).length;
const heldByOther = accepted.filter((a) => existing.has(a.key) && !existing.get(a.key)!.has(a.caseId)).length;

const bySeries = new Map<string, number>();
for (const a of toAdd) bySeries.set(a.key.split(":")[0], (bySeries.get(a.key.split(":")[0]) ?? 0) + 1);
const dist = { once: edges.filter((e) => e.count === 1).length, twice: edges.filter((e) => e.count === 2).length, three_plus: edges.filter((e) => e.count >= 3).length };

const report = [
  `Mined pairs: ${edges.length} (printed once: ${dist.once}, twice: ${dist.twice}, three or more: ${dist.three_plus})`,
  `Accepted by the rules: ${accepted.length}`,
  `  already in the library for that case: ${alreadyThere}; the key already belongs to another case (left alone): ${heldByOther}`,
  `  new keys to add: ${toAdd.length}  ${JSON.stringify(Object.fromEntries(bySeries))}`,
  `Rejected: ${JSON.stringify(rejected)}`,
  ...Object.entries(examples).flatMap(([reason, list]) => [`  e.g. ${reason}:`, ...(list ?? []).slice(0, 3).map((e) => `    ${e.anchor} <-> ${e.other} x${e.count} ${JSON.stringify(e.names.slice(0, 1))}`)]),
].join("\n");
console.log(report);
writeFileSync("data/judgments/parallel-cites-report.txt", report + "\n");

if (!apply) {
  console.log("\nDry run: nothing written. Add --apply to write to the database named by DATABASE_URL.");
  process.exit(0);
}
const host = (() => {
  try {
    return new URL(process.env.DATABASE_URL ?? "").hostname;
  } catch {
    return "(unreadable)";
  }
})();
console.log(`\nWriting ${toAdd.length} keys to the database at ${host} ...`);
for (let i = 0; i < toAdd.length; i += 1000) {
  const batch = toAdd.slice(i, i + 1000).map((a) => ({ key: a.key, case_id: a.caseId, source: "parallel", sightings: a.count }));
  await sql`INSERT INTO library_cite_keys ${sql(batch, "key", "case_id", "source", "sightings")} ON CONFLICT (key, case_id) DO NOTHING`;
}
console.log(`Done: ${toAdd.length} keys written.`);
process.exit(0);
