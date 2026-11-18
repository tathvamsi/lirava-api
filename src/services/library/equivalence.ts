/**
 * Catches a wrong "old section = new section" claim, such as "Section 482 BNSS (now Section 482 CrPC)".
 *
 * Both sections can exist, so each would be "found" on its own, yet the claim that they are the same provision can be false:
 * BNSS 482 is anticipatory bail, CrPC 482 is the High Court's inherent powers (which became BNSS 528).
 * A claim is flagged only on firm grounds:
 *   1. the claim contradicts a known old-to-new mapping (for example CrPC 438 became BNSS 482, so "CrPC 438 (now BNSS 483)" is wrong); or
 *   2. the two sections' titles, from the loaded Acts, share no word of four letters or more.
 * Anything else is left alone: a claim that cannot be shown wrong is not called wrong.
 */
import { CANONICAL_CONCORDANCE_DATA } from "../legal/concordance.js";
import type { ParsedCite } from "./types.js";

type Statute = Extract<ParsedCite, { kind: "statute" }>;

const OLD = new Set(["IPC", "CRPC", "IEA"]);
const NEW = new Set(["BNS", "BNSS", "BSA"]);

/** The words between two citations that say "this is the same provision as that one" (old and new law). */
const LINK =
  /^\s*[,;(\[—–-]?\s*(?:which\s+(?:is\s+now|was|replaced|replaces|corresponds\s+to)\s+|now\s+|formerly\s+|earlier\s+|previously\s+|erstwhile\s+|replaced\s+by\s+|replacing\s+|replaces\s+|corresponding\s+to\s+|corresponds\s+to\s+|equivalent\s+to\s+|same\s+as\s+|old\s+(?:law\s+)?|new\s+(?:law\s+)?)(?:the\s+)?(?:old\s+|new\s+)?(?:law\s+)?(?:provision\s+)?\W*$/i;

const STOP = new Set(["section", "sections", "provisions", "provision", "person", "persons", "certain", "other", "otherwise", "under", "such", "case", "cases", "court", "courts", "order", "orders"]);
const words = (s: string) => new Set(s.toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/).filter((w) => w.length >= 4 && !STOP.has(w)));

const base = (section: string) => section.replace(/\(.*$/, "").toUpperCase();
const actOf = (code: string) => code.replace(/_\d{4}$/, "").toUpperCase();
const shown = (act: string) => (act === "CRPC" ? "CrPC" : act);

/** old "ACT:section" -> new "ACT:section" from the known mappings, and back. */
const FORWARD = new Map<string, string>();
const BACKWARD = new Map<string, string>();
for (const r of CANONICAL_CONCORDANCE_DATA) {
  const o = `${actOf(r.old_act)}:${base(r.old_section)}`;
  const n = `${actOf(r.new_act)}:${base(r.new_section)}`;
  if (!FORWARD.has(o)) FORWARD.set(o, n);
  if (!BACKWARD.has(n)) BACKWARD.set(n, o);
}

export interface EquivalenceClaim {
  /** Positions in the list of citations of the two sections the text says are the same. */
  first: number;
  second: number;
}

/** Pairs of statute citations that sit next to each other with words between them that equate an old and a new section. */
export function findEquivalenceClaims(text: string, cites: ParsedCite[]): EquivalenceClaim[] {
  const out: EquivalenceClaim[] = [];
  for (let i = 0; i + 1 < cites.length; i++) {
    const a = cites[i];
    const b = cites[i + 1];
    if (a.kind !== "statute" || b.kind !== "statute") continue;
    const oldNew = (OLD.has(a.act_code) && NEW.has(b.act_code)) || (NEW.has(a.act_code) && OLD.has(b.act_code));
    if (!oldNew) continue;
    if (LINK.test(text.slice(a.span[1], b.span[0]))) out.push({ first: i, second: i + 1 });
  }
  return out;
}

/** Why the claim is wrong, in plain words, or null when it cannot be shown wrong. */
export function equivalenceProblem(first: { cite: Statute; title?: string }, second: { cite: Statute; title?: string }): string | null {
  const label = (c: Statute, t?: string) => `${shown(c.act_code)} ${c.section}${t ? ` (“${t}”)` : ""}`;
  const [oldS, newS] = OLD.has(first.cite.act_code) ? [first, second] : [second, first];

  const mappedNew = FORWARD.get(`${oldS.cite.act_code}:${base(oldS.cite.section)}`);
  if (mappedNew && mappedNew !== `${newS.cite.act_code}:${base(newS.cite.section)}`) {
    const [act, sec] = mappedNew.split(":");
    return `${label(oldS.cite)} became ${shown(act)} ${sec}, not ${label(newS.cite)}.`;
  }
  const mappedOld = BACKWARD.get(`${newS.cite.act_code}:${base(newS.cite.section)}`);
  if (mappedOld && mappedOld !== `${oldS.cite.act_code}:${base(oldS.cite.section)}`) {
    const [act, sec] = mappedOld.split(":");
    return `${label(newS.cite)} replaced ${shown(act)} ${sec}, not ${label(oldS.cite)}.`;
  }

  if (first.title && second.title) {
    const a = words(first.title);
    const b = words(second.title);
    if (a.size && b.size && ![...a].some((w) => b.has(w))) return `${label(first.cite, first.title)} and ${label(second.cite, second.title)} are different provisions.`;
  }
  return null;
}
