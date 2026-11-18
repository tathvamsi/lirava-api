import { searchStatutes } from "./qdrant.js";
import { searchProvisions } from "./provisions.js";
import { searchCases } from "./cases.js";
const MIN_VECTOR_SCORE = 0.35;
const MAX_CANDIDATES = 4;
/**
 * Hybrid retrieval engine. Executes semantic vector search in Qdrant and lexical full-text
 * search across PostgreSQL legal provisions and landmark cases in parallel.
 * Results are deduplicated and formatted into authoritative courtroom context under a length budget.
 * Gracefully degrades if either Qdrant or PostgreSQL is offline.
 */
export async function retrieveLegalContext(query, maxChars = 1400) {
    const trimmed = query.trim();
    if (!trimmed)
        return null;
    const [vectorResult, provisionsResult, casesResult] = await Promise.allSettled([
        searchStatutes(trimmed, 4),
        searchProvisions(trimmed, MAX_CANDIDATES),
        searchCases(trimmed, 2),
    ]);
    const candidates = [];
    // 1. Process dense semantic vector hits from Qdrant
    if (vectorResult.status === "fulfilled") {
        for (const r of vectorResult.value) {
            if (r.score < MIN_VECTOR_SCORE || !r.payload)
                continue;
            const p = r.payload;
            const isPrecedent = p.entity_type === "precedent" ||
                (p.act && p.act.toLowerCase().includes("precedent")) ||
                p.category === "judicial_precedent";
            candidates.push({
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
                entityType: "provision",
                act: r.act,
                section: r.section,
                title: r.title,
                text: r.text,
                ratio: r.ratio,
                source: r.source,
                score: r.rank ? Math.min(0.5 + r.rank * 0.1, 0.95) : 0.5,
            });
        }
    }
    else {
        console.warn("[legal-rag] provision search failed:", provisionsResult.reason?.message);
    }
    // 3. Process lexical FTS cases from PostgreSQL
    if (casesResult.status === "fulfilled") {
        for (const c of casesResult.value) {
            candidates.push({
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
    const seen = new Set();
    const unique = candidates.filter((c) => {
        let key = "";
        if (c.entityType === "precedent") {
            key = `case:${c.title || c.section}`.toLowerCase().replace(/[^a-z0-9]/g, "");
        }
        else {
            key = `prov:${c.act}|${c.section}`.toLowerCase().replace(/[^a-z0-9|]/g, "");
        }
        if (seen.has(key))
            return false;
        seen.add(key);
        return true;
    });
    if (!unique.length)
        return null;
    const chosen = unique.slice(0, MAX_CANDIDATES);
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
            `[PROVISION]: ${c.act} - ${c.section}${c.title ? `: ${c.title}` : ""}`,
            c.text ? `TEXT: ${c.text}` : "",
            c.ratio ? `JUDICIAL RATIO / CORE PRINCIPLE: ${c.ratio}` : "",
            c.source ? `SOURCE: ${c.source}` : "",
        ]
            .filter(Boolean)
            .join("\n");
    });
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
