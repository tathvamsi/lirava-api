import { getDb } from "../db/index.js";
import { searchStatutes, type LegalSearchResult } from "./qdrant.js";

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

/**
 * Unified Legal RAG Retrieval Engine.
 * 1. Executes semantic vector cosine search against Qdrant (`soli_legal_corpus`).
 * 2. Cross-references local SQLite ingested documents if present.
 * 3. Formats an authoritative legal context block for LLM prompt injection.
 */
export async function retrieveLegalContext(
  query: string,
  maxChars = 1400
): Promise<RetrievedLegalContext | null> {
  const trimmed = query.trim();
  if (!trimmed) return null;

  try {
    // 1. Vector Search against Qdrant Legal Corpus
    const vectorResults = await searchStatutes(trimmed, 3);
    const validVectorResults = vectorResults.filter((r) => r.score >= 0.42);

    // 2. Check local SQLite ingested documents (fallback/supplement)
    const localDocResult = retrieveIngestedLegalContext(trimmed, 800);

    if (validVectorResults.length === 0 && !localDocResult) {
      return null;
    }

    const contextParts: string[] = [];
    const sources: RetrievedLegalContext["sources"] = [];

    // Format vector-retrieved statutory chunks
    if (validVectorResults.length > 0) {
      contextParts.push("### STATUTORY AUTHORITIES & PRECEDENTS (VERBATIM CORPUS RETRIEVAL):");

      for (const res of validVectorResults) {
        const payload = res.payload;
        if (!payload) continue;

        sources.push({
          act: payload.act,
          section: payload.section,
          title: payload.title,
          score: res.score,
          source: payload.source,
        });

        const part = [
          `[PROVISION]: ${payload.act || "Statute"} - ${payload.section || "Section"}: ${payload.title || ""}`,
          payload.statutoryText ? `TEXT: ${payload.statutoryText}` : payload.text ? `TEXT: ${payload.text}` : "",
          payload.ratio ? `JUDICIAL RATIO / CORE PRINCIPLE: ${payload.ratio}` : "",
          payload.source ? `OFFICIAL SOURCE: ${payload.source}` : "",
        ]
          .filter(Boolean)
          .join("\n");

        contextParts.push(part);
      }
    }

    // Format local ingested document if matched
    if (localDocResult) {
      contextParts.push(
        `### INGESTED CHAMBER DOCUMENT: "${localDocResult.documentTitle}"\n${localDocResult.contextText}`
      );
      sources.push({
        title: localDocResult.documentTitle,
        source: "Local Chamber Vault",
      });
    }

    let fullContext = contextParts.join("\n\n---\n\n");
    if (fullContext.length > maxChars) {
      fullContext = fullContext.slice(0, maxChars) + "\n...[truncated for token economy]";
    }

    return {
      documentTitle: validVectorResults[0]?.payload?.act || localDocResult?.documentTitle || "Statutory Legal Corpus",
      contextText: fullContext,
      sources,
    };
  } catch (err: any) {
    console.warn(`\x1b[33m[legal-rag] ⚠️ Error during unified legal retrieval:\x1b[0m ${err.message}`);
    return null;
  }
}

/**
 * Legacy Token-matching retrieval from SQLite legal_documents / document_chunks table.
 */
export function retrieveIngestedLegalContext(
  query: string,
  maxChars = 900
): { documentTitle: string; contextText: string } | null {
  try {
    const db = getDb();
    const q = query.toLowerCase();

    // Common stop words to extract high-signal search tokens
    const stopWords = new Set([
      "can", "you", "explain", "me", "about", "the", "and", "or", "in", "of",
      "for", "to", "a", "an", "is", "act", "what", "tell", "give", "please",
      "show", "details", "statute", "law", "provisions", "how", "does", "which",
      "please", "analyze", "under"
    ]);

    const rawTokens = q
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 2 && !stopWords.has(t));

    if (!rawTokens.length) return null;

    // Check if legal_documents table exists in dots.db
    const tableExists = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='legal_documents'")
      .get();
    if (!tableExists) return null;

    // 1. Fetch ready documents
    const docs = db
      .prepare("SELECT id, title, file_name FROM legal_documents WHERE status = 'ready'")
      .all() as Array<{ id: string; title: string; file_name: string }>;

    if (!docs.length) return null;

    // 2. Score candidate documents
    const distinctiveKeywords = new Set([
      "nammava", "eva", "marriage", "intercaste", "caste", "honour", "tradition", "boycott"
    ]);

    const docScores = docs
      .map((d) => {
        const titleLower = d.title.toLowerCase();
        const fnLower = (d.file_name || "").toLowerCase();
        let matches = 0;
        let hasDistinctive = false;

        for (const t of rawTokens) {
          if (titleLower.includes(t) || fnLower.includes(t)) {
            matches++;
            if (distinctiveKeywords.has(t)) hasDistinctive = true;
          }
        }
        return { doc: d, matches, hasDistinctive };
      })
      .filter((s) => s.matches >= 2 || s.hasDistinctive);

    if (!docScores.length) {
      return null;
    }

    docScores.sort((a, b) => b.matches - a.matches);
    const targetDoc = docScores[0].doc;

    const chunks = db
      .prepare(
        `SELECT id, document_id, chunk_index, content
         FROM document_chunks
         WHERE document_id = ?
         ORDER BY chunk_index ASC`
      )
      .all(targetDoc.id) as Array<{
        id: string;
        document_id: string;
        chunk_index: number;
        content: string;
      }>;

    if (!chunks.length) return null;

    // 3. Score chunks by token presence and structural primacy
    const scored = chunks
      .map((c) => {
        const textLower = c.content.toLowerCase();
        let score = 0;
        for (const t of rawTokens) {
          if (textLower.includes(t)) score += 3;
        }

        if (c.chunk_index <= 2) score += 5;
        if (textLower.includes("sections:") || textLower.includes("statement of objects")) {
          score += 4;
        }

        return { ...c, score };
      })
      .filter((c) => c.score > 0);

    scored.sort((a, b) => b.score - a.score || a.chunk_index - b.chunk_index);

    if (!scored.length) return null;

    // 4. Assemble compact snippet budget
    let totalLen = 0;
    const selectedChunks: string[] = [];
    for (const c of scored) {
      if (totalLen + c.content.length > maxChars && selectedChunks.length >= 1) break;
      selectedChunks.push(c.content.trim());
      totalLen += c.content.length;
      if (selectedChunks.length >= 2) break;
    }

    return {
      documentTitle: targetDoc.title,
      contextText: selectedChunks.join("\n\n---\n\n"),
    };
  } catch (err) {
    console.warn("[legal-rag] Error retrieving document context:", err);
    return null;
  }
}
