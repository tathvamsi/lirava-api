import { searchStatutes } from "./qdrant.js";
import { searchProvisions } from "./provisions.js";
import { searchCases } from "./cases.js";
import { withEnglishHints } from "./indic-terms.js";
import { searchTerms } from "../documents/index.js";
import { extractCitations } from "../library/cite-parse.js";
import { PgLibraryStore } from "../library/pg-store.js";

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
  entityType: "provision" | "precedent";
  act: string;
  section: string;
  title: string;
  text: string;
  ratio?: string | null;
  source?: string | null;
  score: number;
  /** Where it came from: read exactly by section number, found by meaning (vector), by words (lexical) or a landmark case. */
  origin?: "exact" | "vector" | "lexical" | "case";
}

/** A search match scoring under this is a coincidence of wording, not an answer. Measured: real matches score 0.52 and up, noise 0.43 to 0.50. */
const MIN_VECTOR_SCORE = Number(process.env.RAG_MIN_VECTOR_SCORE || 0.5);
/** A vector match from here up is kept on its own; between the minimum and this it needs shared wording too. */
const STRONG_VECTOR_SCORE = Number(process.env.RAG_STRONG_VECTOR_SCORE || 0.6);

/** Words that say what the user wants done, not what the law is about, so they prove nothing about relevance. */
const REQUEST_WORDS = new Set(
  "draft write explain tell give please summarise summarize make help need want show list describe define mean means meaning say says about india indian law legal laws what does how can court courts section sections act acts case cases order rule rules code whether".split(" "),
);

/** How many distinct subject words of the question (by their first 5 letters) appear in the candidate's title and text. */
function overlap(c: { title?: string; section?: string; text?: string }, terms: string[]): number {
  const hay = `${c.title ?? ""} ${c.section ?? ""} ${(c.text ?? "").slice(0, 3000)}`.toLowerCase();
  let n = 0;
  for (const t of terms) if (hay.includes(t.slice(0, 5))) n++;
  return n;
}

/**
 * Keeps only candidates that are really about the question. A search always returns its four nearest results, however far
 * away they are, and attaching them gave answers unrelated "sources" (CPC injunction rules under a bail question, a
 * written-statement timeline under a translation). So: a section named in the question always stays; a vector match needs a
 * real score, or a weaker score plus shared wording; a word match needs at least two of the question's subject words; and when
 * a named section is present, only a strong extra is kept. The weakest are then trimmed against the best.
 */
export function selectRelevant(candidates: Candidate[], question: string): Candidate[] {
  const terms = searchTerms(question).filter((t) => !REQUEST_WORDS.has(t));
  const exact = candidates.filter((c) => c.origin === "exact");
  const kept: Candidate[] = [];
  for (const c of candidates) {
    if (c.origin === "exact") continue;
    const o = overlap(c, terms);
    const needTwo = terms.length >= 2;
    if (c.origin === "vector") {
      // Strong by meaning alone, or fair by meaning and sharing at least two of the question's subject words.
      if (c.score >= STRONG_VECTOR_SCORE || (c.score >= MIN_VECTOR_SCORE && o >= (needTwo ? 2 : 1))) kept.push(c);
    } else if (o >= (needTwo ? 2 : 1)) {
      // A word match is worth less than a meaning match: scored by how many of the question's words it holds.
      kept.push({ ...c, score: Math.min(0.4 + 0.05 * o, 0.65) });
    }
  }
  kept.sort((a, b) => b.score - a.score);
  const best = kept[0]?.score ?? 0;
  const trimmed = kept.filter((c) => c.score >= best - 0.1);
  if (exact.length) return [...exact, ...trimmed.filter((c) => c.score >= 0.55).slice(0, 1)];
  return trimmed;
}
const MAX_CANDIDATES = 4;

/**
 * Hybrid retrieval engine. Executes semantic vector search in Qdrant and lexical full-text
 * search across PostgreSQL legal provisions and landmark cases in parallel.
 * Results are deduplicated and formatted into authoritative courtroom context under a length budget.
 * Gracefully degrades if either Qdrant or PostgreSQL is offline.
 */
/**
 * A section the question names ("What does BNS 348 say?", "explain Section 482 BNSS") is read from the library by number, not
 * left to a search that matches meaning. A search for "BNS 348" returns whatever sounds close (quashing and inherent powers), and a
 * small model that is not shown the section answers from memory and gets it wrong. These come first and are marked as exact.
 */
async function exactProvisions(question: string): Promise<Candidate[]> {
  const store = new PgLibraryStore();
  const out: Candidate[] = [];
  const seen = new Set<string>();
  for (const cite of extractCitations(question)) {
    if (cite.kind !== "statute" || out.length >= 3) continue;
    const key = `${cite.act_code}|${cite.section}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const p = await store.findProvision(cite.act_code, cite.section.replace(/\(.*$/, "")).catch(() => null);
    if (!p?.text) continue;
    out.push({ origin: "exact", entityType: "provision", act: p.act_code, section: `Section ${p.section_num}`, title: p.title, text: p.text.slice(0, 1800), source: p.source ?? undefined, score: 1 });
  }
  return out;
}

export async function retrieveLegalContext(query: string, maxChars = 1400): Promise<RetrievedLegalContext | null> {
  // A question in Kannada, Hindi, Marathi, Tamil or Telugu is searched with the English terms for its legal words added,
  // because the library and the embeddings are English (see indic-terms.ts). English questions are unchanged.
  const trimmed = withEnglishHints(query.trim());
  if (!trimmed) return null;

  const [vectorResult, provisionsResult, casesResult] = await Promise.allSettled([
    searchStatutes(trimmed, 4),
    searchProvisions(trimmed, MAX_CANDIDATES),
    searchCases(trimmed, 2),
  ]);

  // Sections named in the question, read exactly from the library, come before anything the search finds.
  const exact = await exactProvisions(query).catch(() => [] as Candidate[]);
  const candidates: Candidate[] = [...exact];

  // 1. Process dense semantic vector hits from Qdrant
  if (vectorResult.status === "fulfilled") {
    for (const r of vectorResult.value) {
      if (r.score < MIN_VECTOR_SCORE || !r.payload) continue;
      const p = r.payload;
      const isPrecedent =
        p.entity_type === "precedent" ||
        (p.act && p.act.toLowerCase().includes("precedent")) ||
        p.category === "judicial_precedent";

      candidates.push({
        origin: "vector",
        entityType: isPrecedent ? "precedent" : "provision",
        act: p.act || (isPrecedent ? "Supreme Court of India Precedent" : "Statute"),
        section: p.section || (isPrecedent ? (p.primary_citation || "") : "Section"),
        title: p.title || p.case_title || "",
        text: p.statutoryText || p.text || "",
        ratio: p.ratio,
        source: p.source,
        score: r.score,
      });
    }
  }

  // 2. Process lexical FTS provisions from PostgreSQL
  if (provisionsResult.status === "fulfilled") {
    for (const r of provisionsResult.value) {
      candidates.push({
        origin: "lexical",
        entityType: "provision",
        act: r.act,
        section: r.section,
        title: r.title,
        text: r.text,
        ratio: r.ratio,
        source: r.source,
        score: (r as any).rank ? Math.min(0.5 + (r as any).rank * 0.1, 0.95) : 0.5,
      });
    }
  } else {
    console.warn("[legal-rag] provision search failed:", (provisionsResult.reason as Error)?.message);
  }

  // 3. Process lexical FTS cases from PostgreSQL
  if (casesResult.status === "fulfilled") {
    for (const c of casesResult.value) {
      candidates.push({
        origin: "case",
        entityType: "precedent",
        act: c.court || "Supreme Court of India",
        section: c.primary_citation,
        title: `${c.case_title}, ${c.primary_citation}`,
        text: c.ratio + (c.principles && c.principles.length ? `\nPrinciples: ${c.principles.join("; ")}` : ""),
        ratio: c.ratio,
        source: c.neutral_citation
          ? `Judicial Citation: ${c.primary_citation} / ${c.neutral_citation}`
          : `Judicial Citation: ${c.primary_citation}`,
        score: 0.5,
      });
    }
  }

  // 4. Deduplicate candidates (preferring earlier vector hits)
  const seen = new Set<string>();
  const unique = candidates.filter((c) => {
    let key = "";
    if (c.entityType === "precedent") {
      key = `case:${c.title || c.section}`.toLowerCase().replace(/[^a-z0-9]/g, "");
    } else {
      key = `prov:${c.act}|${c.section}`.toLowerCase().replace(/[^a-z0-9|]/g, "");
    }
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Only what is really about the question is attached; nothing found means no sources, not four weak ones.
  const relevant = selectRelevant(unique, query);
  if (!relevant.length) return null;

  const chosen = relevant.slice(0, MAX_CANDIDATES);
  const parts = chosen.map((c) => {
    if (c.entityType === "precedent") {
      return [
        `[JUDICIAL PRECEDENT]: ${c.title || c.act}`,
        c.ratio ? `JUDICIAL RATIO / CORE PRINCIPLE: ${c.ratio}` : "",
        c.text ? `DETAILS: ${c.text}` : "",
        c.source ? `SOURCE: ${c.source}` : "",
      ]
        .filter(Boolean)
        .join("\n");
    }

    return [
      c.score === 1 && c.entityType === "provision"
        ? `[EXACT TEXT of ${c.act} ${c.section}, read directly from the statute library. Explain it from this text and do not add to it]: ${c.title || ""}`
        : `[PROVISION]: ${c.act} - ${c.section}${c.title ? `: ${c.title}` : ""}`,
      c.text ? `TEXT: ${c.text}` : "",
      c.ratio ? `JUDICIAL RATIO / CORE PRINCIPLE: ${c.ratio}` : "",
      c.source ? `SOURCE: ${c.source}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  });

  // An exact section is never cut short by the budget meant for search results.
  if (exact.length) maxChars = Math.max(maxChars, 2800);
  let contextText = `### STATUTORY PROVISIONS (from Lirava's statute library; verify against the official text before relying on them):\n${parts.join("\n\n---\n\n")}`;
  if (contextText.length > maxChars) {
    contextText = contextText.slice(0, maxChars) + "\n...[truncated for length]";
  }

  return {
    documentTitle: chosen[0].act || "Statutory Legal Corpus",
    contextText,
    sources: chosen.map((c) => ({
      act: c.act,
      section: c.section,
      title: c.title,
      score: c.score,
      source: c.source ?? undefined,
    })),
  };
}
