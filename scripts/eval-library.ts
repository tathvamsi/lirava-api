/**
 * Measures the citation checker against the REAL library (the database in DATABASE_URL) using the gold set.
 * Read-only: it only looks citations up. Cases marked scope=memory (which depend on the fixture library) are skipped.
 *
 * Usage:  node --import tsx scripts/eval-library.ts [--show-failures]
 * Exit code 1 if anything was verified that must not be, or any case did not get the expected verdict.
 */
import "dotenv/config";
import { PgLibraryStore } from "../src/services/library/pg-store.js";
import { loadGold, runGold, summarise } from "../tests/gold-runner.js";

const fixture = loadGold();
const cases = fixture.cases.filter((c) => c.scope !== "memory");
const store = new PgLibraryStore();
const results = await runGold(cases, store);
const s = summarise(results);

console.log(`Gold set against the real library: ${s.passed}/${s.total} as expected (${fixture.cases.length - cases.length} fixture-only cases skipped)`);
console.log(`  false verifications (must be 0): ${s.falseVerified}`);
console.log(`  false alarms:                    ${s.falseAlarms}`);
console.log(`  missed verifications:            ${s.missedVerifications}`);
console.log("");
for (const [c, v] of s.byCategory) console.log(`  ${c.padEnd(30)} ${String(v.pass).padStart(3)}/${v.n}${v.pass === v.n ? "" : "   <-- differs"}`);

const failed = results.filter((r) => !r.pass);
if (failed.length) {
  console.log(`\n${failed.length} case(s) differ:`);
  for (const r of failed.slice(0, process.argv.includes("--show-failures") ? 200 : 15)) {
    console.log(`- ${r.gold.id} [${r.gold.category}] ${r.gold.text}\n    expected ${JSON.stringify(r.gold.expect)}\n    got      ${JSON.stringify(r.actual.map((a) => ({ status: a.status, reason: a.reason })))}`);
  }
}
process.exit(s.falseVerified > 0 || failed.length > 0 ? 1 : 0);
