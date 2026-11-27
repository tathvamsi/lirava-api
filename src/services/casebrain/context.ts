import type { CaseNode } from "./index.js";

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "at", "be", "by", "for", "from", "how", "i", "in", "is", "it", "of", "on", "or", "our", "the", "to", "was", "what", "when", "where", "who", "with", "you",
]);

const words = (text: string) =>
  Array.from(text.toLowerCase().matchAll(/[\p{L}\p{N}]+/gu), (match) => match[0]).filter((word) => word.length > 1 && !STOP_WORDS.has(word));

/**
 * Selects the lawyer-confirmed facts that are most useful for this question.
 * Proposed and disputed entries are intentionally omitted: they are leads for the lawyer,
 * not facts the assistant may state as established.
 */
export function buildKnowledgeTreeContext(question: string, nodes: CaseNode[], maxChars = 2200): string {
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

  if (!selected.length) return "";

  const lines: string[] = [];
  let length = 0;
  for (const node of selected) {
    const section = node.parentId ? byId.get(node.parentId)?.title : undefined;
    const entry = `- ${section ? `${section} — ` : ""}${node.title}${node.date ? ` (${node.date})` : ""}${node.body ? `: ${node.body}` : ""}`;
    if (length + entry.length > maxChars) break;
    lines.push(entry);
    length += entry.length + 1;
  }

  return lines.length
    ? `CASE KNOWLEDGE TREE — confirmed lawyer-approved case details:\n${lines.join("\n")}\n\nUse these facts when they answer the question. Do not treat them as legal authority, and do not contradict or invent beyond them.`
    : "";
}
