import type { Citation } from "../chats/store.js";
import type { DocumentHit } from "./index.js";

/** Total characters of document excerpts placed in a prompt. Small models have small windows. */
export const DEFAULT_DOCUMENT_CONTEXT_CHARS = Number(process.env.RAG_DOC_CHARS || 2600);

const where = (hit: DocumentHit) => `${hit.unit === "section" ? "section" : "page"} ${hit.page}`;

/**
 * Turns retrieved passages into (a) a block for the model, with a label such as [D1] per passage,
 * and (b) the citations shown to the user under the answer. Both come from the same passages, so
 * what the user sees as a source is exactly what the model was given.
 */
export function buildDocumentContext(
  hits: DocumentHit[],
  maxChars = DEFAULT_DOCUMENT_CONTEXT_CHARS,
): { text: string; /** The excerpts (may be shortened to fit a prompt). */ body?: string; /** How to use them (always kept whole). */ rules?: string; citations: Citation[] } {
  if (!hits.length) return { text: "", citations: [] };

  const perHit = Math.max(300, Math.floor(maxChars / hits.length));
  const citations: Citation[] = [];
  const blocks: string[] = [];
  let used = 0;

  hits.forEach((hit, index) => {
    const remaining = maxChars - used;
    if (remaining < 200) return;
    const excerpt = hit.text.length > Math.min(perHit, remaining) ? `${hit.text.slice(0, Math.min(perHit, remaining)).trimEnd()}…` : hit.text;
    const label = `D${citations.length + 1}`;
    blocks.push(`[${label}] ${hit.name}, ${where(hit)}:\n"${excerpt}"`);
    citations.push({ kind: "document", label, fileId: hit.documentId, name: hit.name, page: hit.page, unit: hit.unit, excerpt });
    used += excerpt.length;
    void index;
  });

  const body = `USER DOCUMENT EXCERPTS (from the user's own files for this matter):\n${blocks.join("\n\n")}`;
  const rules =
    `HOW TO USE THEM:\n- For facts about this matter, rely on these excerpts and cite the label in square brackets, for example [D1], after each statement that depends on one.\n` +
    `- If the excerpts do not contain the answer, say so plainly. Do not guess what the documents say.\n` +
    `- Do not cite a label that is not listed above.`;
  const text = `${body}\n\n${rules}`;

  return { text, body, rules, citations };
}

export function statuteCitations(
  sources: Array<{ act?: string; section?: string; title?: string; source?: string }> | undefined,
): Citation[] {
  return (sources ?? []).map((source, index) => ({
    kind: "statute" as const,
    label: `S${index + 1}`,
    title: source.title || `${source.act ?? "Statute"} ${source.section ?? ""}`.trim(),
    act: source.act,
    section: source.section,
    source: source.source,
  }));
}
