import { searchStatutes } from "./qdrant.js";
import { searchProvisions } from "./provisions.js";

export interface RetrievedLegalContext {
  documentTitle?: string;
  contextText: string;
  sources: Array<{
    act?: string;
    section?: string;
    title?: string;
    score?: number;
    source?: string;
  }>;
}

interface Candidate {
  act: string;
  section: string;
  title: string;
  text: string;
  ratio?: string | null;
  source?: string | null;
  score: number;
}

const MIN_VECTOR_SCORE = 0.42;
const MAX_PROVISIONS = 4;

/**
 * Statute retrieval. Two searches run side by side and are merged:
 *  1. semantic search in Qdrant (needs the embedding server), and
 *  2. full-text search over the provisions stored in PostgreSQL (always available, including the
 *     Acts an administrator has loaded).
 * Either may fail or find nothing; the other still answers. Returns null, never an error, when
 * nothing relevant is found, so callers can say so instead of guessing.
 */
export async function retrieveLegalContext(query: string, maxChars = 1400): Promise<RetrievedLegalContext | null> {
  const trimmed = query.trim();
  if (!trimmed) return null;

  const [vector, text] = await Promise.allSettled([searchStatutes(trimmed, 3), searchProvisions(trimmed, MAX_PROVISIONS)]);

  const candidates: Candidate[] = [];
  if (vector.status === "fulfilled") {
    for (const r of vector.value) {
      if (r.score < MIN_VECTOR_SCORE || !r.payload) continue;
      candidates.push({
        act: r.payload.act || "Statute",
        section: r.payload.section || "Section",
        title: r.payload.title || "",
        text: r.payload.statutoryText || r.payload.text || "",
        ratio: r.payload.ratio,
        source: r.payload.source,
        score: r.score,
      });
    }
  }
  if (text.status === "fulfilled") {
    for (const r of text.value) {
      candidates.push({ act: r.act, section: r.section, title: r.title, text: r.text, ratio: r.ratio, source: r.source, score: 0.5 });
    }
  } else {
    console.warn("[legal-rag] provision search failed:", (text.reason as Error)?.message);
  }

  // The same provision can come from both searches: keep one copy, preferring the semantic match.
  const seen = new Set<string>();
  const unique = candidates.filter((c) => {
    const key = `${c.act}|${c.section}`.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (!unique.length) return null;

  const chosen = unique.slice(0, MAX_PROVISIONS);
  const parts = chosen.map((c) =>
    [
      `[PROVISION]: ${c.act} - ${c.section}${c.title ? `: ${c.title}` : ""}`,
      c.text ? `TEXT: ${c.text}` : "",
      c.ratio ? `JUDICIAL RATIO / CORE PRINCIPLE: ${c.ratio}` : "",
      c.source ? `SOURCE: ${c.source}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
  );

  let contextText = `### STATUTORY PROVISIONS (from Lirava's statute library; verify against the official text before relying on them):\n${parts.join("\n\n---\n\n")}`;
  if (contextText.length > maxChars) contextText = contextText.slice(0, maxChars) + "\n...[truncated for length]";

  return {
    documentTitle: chosen[0].act || "Statutory Legal Corpus",
    contextText,
    sources: chosen.map((c) => ({ act: c.act, section: c.section, title: c.title, score: c.score, source: c.source ?? undefined })),
  };
}
