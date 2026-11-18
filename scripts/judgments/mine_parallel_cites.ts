/**
 * Finds the Court's own parallel citations in judgment text, so that SCC and AIR citations can be tied to the records we hold.
 *
 * Supreme Court Reports judgments print a cited case once with all its citations side by side, joined by a colon, for example
 *     State of Goa v. Sanjay Thakran [2007] 3 SCR 507 : (2007) 3 SCC 755
 *     H.R.S. Murthy v. Collector, AIR 1965 SC 177 : (1964) 6 SCR 666
 * Where one of those is a citation we already hold (SCR, or INSC) and another is SCC, AIR, SCC OnLine or SCALE, the printing itself says they
 * are the same case. Nothing is guessed: a pair is only taken from a colon-joined group, and ambiguous pairs are dropped later (see ingest).
 *
 * Uses the library's own citation parser, so the keys are exactly the ones the verifier looks up.
 *
 * Usage:  node --import tsx scripts/judgments/mine_parallel_cites.ts <text_dir> <out.jsonl>
 * Output: one line per distinct pair: { anchor, other, count, files: [..up to 5 judgment ids..], names: [..up to 3 case names..] }
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalKey, extractCitations } from "../../src/services/library/cite-parse.js";
import type { ParsedCite } from "../../src/services/library/types.js";

const [dir, outFile] = process.argv.slice(2);
if (!dir || !outFile) {
  console.error("Usage: node --import tsx scripts/judgments/mine_parallel_cites.ts <text_dir> <out.jsonl>");
  process.exit(1);
}

type Edge = { anchor: string; other: string; count: number; files: Set<string>; names: Set<string> };
const edges = new Map<string, Edge>();

/** The last "X v. Y" in the stretch of text just before a citation group. */
function nameBefore(text: string, at: number): string | null {
  const slice = text.slice(Math.max(0, at - 160), at);
  const re = /([A-Z][\w.&'’ -]{1,60}?)\s+(?:v\.?|vs\.?)\s+([A-Z][\w.&'’, -]{1,60}?)(?=\s*[,(\[:]|\s*$)/g;
  let last: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(slice))) last = `${m[1].trim()} v. ${m[2].trim()}`;
  return last;
}

const isAnchor = (c: ParsedCite) => (c.kind === "reporter" && c.series === "SCR") || (c.kind === "neutral" && c.scheme === "INSC");
const isOther = (c: ParsedCite) => c.kind === "reporter" && ["SCC", "SCCOL", "AIR", "SCALE"].includes(c.series);

function* textFiles(root: string): Generator<{ id: string; path: string }> {
  for (const entry of readdirSync(root)) {
    const p = join(root, entry);
    if (statSync(p).isDirectory()) yield* textFiles(p);
    else if (entry.endsWith(".txt")) yield { id: `scj:${entry.slice(0, -4).replace(/_EN$/, "")}`, path: p };
  }
}

let files = 0;
let groups = 0;
for (const { id, path } of textFiles(dir)) {
  files++;
  // One line of text: citations wrap across lines and carry footnote numbers in front of them.
  const text = readFileSync(path, "utf8").replace(/\s+/g, " ");
  const cites = extractCitations(text).filter((c) => c.kind === "reporter" || c.kind === "neutral");
  let i = 0;
  while (i < cites.length) {
    const group = [cites[i]];
    while (i + 1 < cites.length && /^\s*:\s*$/.test(text.slice(group[group.length - 1].span[1], cites[i + 1].span[0]))) group.push(cites[++i]);
    i++;
    if (group.length < 2) continue;
    const anchors = group.filter(isAnchor);
    const others = group.filter(isOther);
    if (!anchors.length || !others.length) continue;
    groups++;
    const name = nameBefore(text, group[0].span[0]);
    for (const a of anchors) {
      for (const o of others) {
        const key = `${canonicalKey(a)}|${canonicalKey(o)}`;
        const e = edges.get(key) ?? { anchor: canonicalKey(a), other: canonicalKey(o), count: 0, files: new Set<string>(), names: new Set<string>() };
        e.count++;
        if (e.files.size < 5) e.files.add(id);
        if (name && e.names.size < 3) e.names.add(name);
        edges.set(key, e);
      }
    }
  }
  if (files % 2000 === 0) console.error(`${files} files, ${edges.size} pairs so far`);
}

writeFileSync(outFile, [...edges.values()].map((e) => JSON.stringify({ anchor: e.anchor, other: e.other, count: e.count, files: [...e.files], names: [...e.names] })).join("\n") + "\n");
console.log(`${files} judgments read; ${groups} parallel-citation groups; ${edges.size} distinct pairs written to ${outFile}`);
