/**
 * Decides which mined parallel-citation pairs (see scripts/judgments/mine_parallel_cites.ts) may become citation keys.
 *
 * A pair says "this SCR (or INSC) citation and this SCC (or AIR...) citation are the same case", because a judgment printed them
 * side by side. A wrong pair would let a wrong citation verify, so a pair is dropped unless every check passes:
 *   1. the SCR/INSC citation resolves to exactly one case in the library;
 *   2. when a case name was printed beside the pair, it shares a word with the library's title for that case;
 *   3. the pair was printed at least `minCount` times (one stray typo in one judgment is not enough);
 *   4. a case never ends up with two competing citations of the same series, unless one clearly dominates;
 *   5. no citation ends up claimed by two different cases.
 * Pure: no database and no network, so the rules can be tested.
 */

export interface MinedEdge {
  anchor: string;
  other: string;
  count: number;
  files: string[];
  names: string[];
}
export interface ResolvedCase {
  id: string;
  title: string;
}
/** A case, "ambiguous" when more than one case holds the key, or null when none does. */
export type Resolver = (anchorKey: string) => ResolvedCase | "ambiguous" | null;

export type RejectReason = "anchor_unknown" | "anchor_ambiguous" | "name_mismatch" | "too_few_sightings" | "conflict_same_case" | "conflict_same_citation";
export interface Accepted {
  key: string;
  caseId: string;
  count: number;
}
export interface Selection {
  accepted: Accepted[];
  rejected: Record<RejectReason, number>;
  /** A few rejected pairs per reason, for a human to look at. */
  examples: Partial<Record<RejectReason, MinedEdge[]>>;
}

const STOP = new Set(["state", "union", "india", "another", "others", "anr", "ors", "versus", "of", "the", "and", "through", "its", "secretary", "ltd", "limited", "pvt", "private", "company", "government", "govt", "from", "with", "under", "case", "law", "cited"]);
const tokens = (s: string) =>
  new Set(
    s
      .toLowerCase()
      .replace(/[^a-z\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length >= 4 && !STOP.has(t)),
  );

/** True when the printed name and the library title share no word at all, so they are probably different cases. */
export function namesDisagree(printed: string[], title: string): boolean {
  const wanted = tokens(title);
  const usable = printed.map(tokens).filter((t) => t.size > 0);
  if (!usable.length || !wanted.size) return false; // nothing to compare: not a reason to reject
  return usable.every((t) => ![...t].some((w) => wanted.has(w)));
}

const series = (key: string) => key.split(":")[0];

export function selectPairs(edges: MinedEdge[], resolve: Resolver, options: { minCount?: number } = {}): Selection {
  const minCount = options.minCount ?? 2;
  const rejected: Record<RejectReason, number> = { anchor_unknown: 0, anchor_ambiguous: 0, name_mismatch: 0, too_few_sightings: 0, conflict_same_case: 0, conflict_same_citation: 0 };
  const examples: Selection["examples"] = {};
  const reject = (reason: RejectReason, e: MinedEdge) => {
    rejected[reason]++;
    const list = (examples[reason] ??= []);
    if (list.length < 5) list.push(e);
  };

  // Steps 1-3, one edge at a time.
  const passed: Array<{ edge: MinedEdge; caseId: string }> = [];
  for (const e of edges) {
    const r = resolve(e.anchor);
    if (r === null) reject("anchor_unknown", e);
    else if (r === "ambiguous") reject("anchor_ambiguous", e);
    else if (namesDisagree(e.names, r.title)) reject("name_mismatch", e);
    else if (e.count < minCount) reject("too_few_sightings", e);
    else passed.push({ edge: e, caseId: r.id });
  }

  // Step 4: one citation per series for a case. Where several compete, one must clearly dominate.
  const perCaseSeries = new Map<string, Array<{ edge: MinedEdge; caseId: string }>>();
  for (const p of passed) {
    const k = `${p.caseId}|${series(p.edge.other)}`;
    perCaseSeries.set(k, [...(perCaseSeries.get(k) ?? []), p]);
  }
  const afterCase: Array<{ edge: MinedEdge; caseId: string }> = [];
  for (const group of perCaseSeries.values()) {
    const distinct = new Map<string, { edge: MinedEdge; caseId: string; count: number }>();
    for (const g of group) {
      const seen = distinct.get(g.edge.other);
      distinct.set(g.edge.other, { ...g, count: (seen?.count ?? 0) + g.edge.count });
    }
    const ranked = [...distinct.values()].sort((a, b) => b.count - a.count);
    if (ranked.length === 1 || ranked[0].count >= 3 * ranked[1].count) afterCase.push({ edge: { ...ranked[0].edge, count: ranked[0].count }, caseId: ranked[0].caseId });
    else for (const r of ranked) reject("conflict_same_case", r.edge);
  }

  // Step 5: a citation belongs to one case only.
  const owners = new Map<string, Set<string>>();
  for (const a of afterCase) owners.set(a.edge.other, new Set([...(owners.get(a.edge.other) ?? []), a.caseId]));
  const accepted: Accepted[] = [];
  for (const a of afterCase) {
    if ((owners.get(a.edge.other)?.size ?? 0) > 1) reject("conflict_same_citation", a.edge);
    else accepted.push({ key: a.edge.other, caseId: a.caseId, count: a.edge.count });
  }
  return { accepted, rejected, examples };
}
