import { readFileSync } from "node:fs";
import { MemoryLibraryStore } from "../src/services/library/memory-store.js";
import { verifyAnswer } from "../src/services/library/verify.js";
import type { LibraryStore } from "../src/services/library/types.js";

/**
 * Runs the gold set (tests/fixtures/gold-citations.json, built by scripts/build-gold.ts) through the citation checker.
 * Shared by tests/library-gold.test.ts (fixture library, no database) and scripts/eval-library.ts (the real library).
 */

export interface GoldExpect {
  status: "verified" | "partial" | "unverified";
  reason: string;
  warn?: string;
}
export interface GoldCase {
  id: string;
  category: string;
  text: string;
  offenceDate?: string;
  scope?: "memory";
  expect: GoldExpect[];
}
export interface GoldFixture {
  library: {
    cases: Array<{ id: string; title: string; court: string; year: number; citations: string[] }>;
    provisions: Array<{ act_code: string; section_num: string; title: string; repealed: boolean }>;
  };
  cases: GoldCase[];
}
export interface GoldResult {
  gold: GoldCase;
  actual: Array<{ raw: string; status: string; reason: string; warning?: string }>;
  pass: boolean;
  /** A verdict "verified" where the gold set says it must not be. The one failure that is never acceptable. */
  falseVerified: boolean;
  /** More verdicts than the gold set expects (for example a date or a number mistaken for a citation). */
  falseAlarm: boolean;
  /** Something that should have verified did not. */
  missedVerification: boolean;
}

export const loadGold = (path = "tests/fixtures/gold-citations.json"): GoldFixture => JSON.parse(readFileSync(path, "utf8"));

export function fixtureStore(fixture: GoldFixture): MemoryLibraryStore {
  const store = new MemoryLibraryStore();
  for (const c of fixture.library.cases) store.addCase({ id: c.id, title: c.title, court: c.court, year: c.year, citation_text: c.citations.join("; ") }, c.citations);
  for (const p of fixture.library.provisions) store.addProvision({ id: `${p.act_code}:${p.section_num}`, act_code: p.act_code, section_num: p.section_num, title: p.title, repealed: p.repealed });
  return store;
}

export async function runGold(cases: GoldCase[], store: LibraryStore): Promise<GoldResult[]> {
  const out: GoldResult[] = [];
  for (const gold of cases) {
    const { verdicts } = await verifyAnswer(gold.text, store, { offenceDate: gold.offenceDate });
    const actual = verdicts.map((v) => ({ raw: v.raw, status: v.status, reason: v.reason, warning: v.warning }));
    const sameCount = actual.length === gold.expect.length;
    const sameEach = sameCount && gold.expect.every((e, i) => actual[i].status === e.status && actual[i].reason === e.reason && (!e.warn || (actual[i].warning ?? "").includes(e.warn)));
    out.push({
      gold,
      actual,
      pass: sameEach,
      falseVerified: actual.some((a, i) => a.status === "verified" && gold.expect[i]?.status !== "verified"),
      falseAlarm: actual.length > gold.expect.length,
      missedVerification: gold.expect.some((e, i) => e.status === "verified" && actual[i]?.status !== "verified"),
    });
  }
  return out;
}

export function summarise(results: GoldResult[]) {
  const byCategory = new Map<string, { n: number; pass: number }>();
  for (const r of results) {
    const c = byCategory.get(r.gold.category) ?? { n: 0, pass: 0 };
    c.n++;
    if (r.pass) c.pass++;
    byCategory.set(r.gold.category, c);
  }
  return {
    total: results.length,
    passed: results.filter((r) => r.pass).length,
    falseVerified: results.filter((r) => r.falseVerified).length,
    falseAlarms: results.filter((r) => r.falseAlarm).length,
    missedVerifications: results.filter((r) => r.missedVerification).length,
    byCategory,
  };
}
