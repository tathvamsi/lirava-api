import type { Citation } from "../chats/store.js";
import type { CaseNode } from "./index.js";

export type CaseCitation = Extract<Citation, { kind: "case" }>;

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "at", "be", "by", "for", "from", "how", "i", "in", "is", "it", "of", "on", "or", "our", "the", "to", "was", "what", "when", "where", "who", "with", "you",
]);

const words = (text: string) =>
  Array.from(text.toLowerCase().matchAll(/[\p{L}\p{N}]+/gu), (match) => match[0]).filter((word) => word.length > 1 && !STOP_WORDS.has(word));

/** What a person types when they do not know a value yet. It is not a name or a fact, so it must never be repeated as one. */
const PLACEHOLDER = /^(?:yet\s+to\s+(?:know|be\s+(?:known|decided|determined|identified|confirmed))|to\s+be\s+(?:known|decided|determined|identified|confirmed|added)|not\s+(?:yet\s+)?(?:known|available|decided|identified)|unknown|unidentified|tbd|tba|tbc|n\/?a|nil|none|pending|-+|—+|\?+)\.?$/i;

export const isPlaceholder = (value: string) => PLACEHOLDER.test(value.trim());

/** "Opposite party: Yet to Know" becomes "Opposite party: not recorded"; real values are left alone. */
export function cleanPlaceholder(title: string): string {
  const labelled = /^(.*?):\s*(.+)$/.exec(title.trim());
  if (labelled) return isPlaceholder(labelled[2]) ? `${labelled[1]}: not recorded` : title;
  return isPlaceholder(title) ? "not recorded" : title;
}

/** A date entry with only a generic name (just "Deadline") says when, but not what for. */
const BARE_DATE_TITLE = /^(?:next\s+)?(?:deadline|date|due\s+date)$/i;

type Picked = { node: CaseNode; title: string; section?: string; line: string };

/**
 * Selects the lawyer-confirmed facts that are most useful for this question, labels each one T1, T2… and returns both the
 * block for the model and a citation per label, so what the user can open as a source is exactly what the model was given.
 * Proposed and disputed entries are intentionally omitted: they are leads for the lawyer, not facts the assistant may
 * state as established.
 */
export function buildKnowledgeTreeSources(question: string, nodes: CaseNode[], maxChars = 2200): { text: string; citations: CaseCitation[] } {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const query = new Set(words(question));
  const confirmed = nodes.filter((node) => node.kind !== "section" && node.status === "confirmed");

  const score = (node: CaseNode) => {
    const section = node.parentId ? byId.get(node.parentId)?.title ?? "" : "";
    const titleWords = words(`${node.title} ${section}`);
    const bodyWords = words(node.body);
    return titleWords.reduce((total, word) => total + (query.has(word) ? 3 : 0), 0) + bodyWords.reduce((total, word) => total + (query.has(word) ? 1 : 0), 0);
  };

  const selected = confirmed
    .map((node, order) => ({ node, order, score: score(node) }))
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, 12)
    .map(({ node }) => node);

  const picked: Picked[] = [];
  let length = 0;
  for (const node of selected) {
    const section = node.parentId ? byId.get(node.parentId)?.title : undefined;
    const title = cleanPlaceholder(node.title);
    const body = node.body && !isPlaceholder(node.body) ? node.body : "";
    const purposeMissing = node.date && !body && BARE_DATE_TITLE.test(title.trim()) ? " — what it is for is not recorded" : "";
    const label = `T${picked.length + 1}`;
    const line = `- [${label}] ${section ? `${section} — ` : ""}${title}${node.date ? ` (${node.date})` : ""}${purposeMissing}${body ? `: ${body}` : ""}`;
    if (length + line.length > maxChars) break;
    picked.push({ node, title, section, line });
    length += line.length + 1;
  }

  if (!picked.length) return { text: "", citations: [] };

  const text =
    `CASE KNOWLEDGE TREE — confirmed lawyer-approved case details:\n${picked.map((p) => p.line).join("\n")}\n\n` +
    `Use these facts when they answer the question, and cite the label in square brackets, for example [T1], after each statement that depends on an entry. ` +
    `Cite only labels listed above. An entry marked "not recorded" is unknown: say it is not recorded, and never present it as a name or a fact. ` +
    `Do not treat these entries as legal authority, and do not contradict or invent beyond them.`;

  const citations: CaseCitation[] = picked.map(({ node, title, section }, index) => ({
    kind: "case",
    label: `T${index + 1}`,
    nodeId: node.id,
    title,
    ...(section ? { section } : {}),
    ...(node.body && !isPlaceholder(node.body) ? { body: node.body } : {}),
    ...(node.date ? { date: node.date } : {}),
    nodeKind: node.kind,
  }));

  return { text, citations };
}

/** The prompt block alone, for callers that do not need the citations. */
export function buildKnowledgeTreeContext(question: string, nodes: CaseNode[], maxChars = 2200): string {
  return buildKnowledgeTreeSources(question, nodes, maxChars).text;
}

/**
 * Drops the tree entries the answer never cited. Every retrieved document passage is shown as a source, but twelve tree
 * entries the model did not use would only bury the ones it did, so a tree entry is a source only when its label
 * appears in square brackets in the answer (alone, or in a list such as [T1, T3]).
 */
export function keepCitedTreeSources(citations: Citation[], answer: string): Citation[] {
  const cited = new Set<string>();
  for (const group of answer.matchAll(/\[([^\]]*)\]/g)) {
    for (const part of group[1].split(/[,;\s]+/)) if (/^T\d+$/.test(part)) cited.add(part);
  }
  return citations.filter((c) => c.kind !== "case" || cited.has(c.label));
}
