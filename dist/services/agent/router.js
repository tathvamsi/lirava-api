export const SUB_AGENTS = {
    vakil: {
        name: "Vakil",
        role: "Senior Courtroom Drafting Counsel",
        focus: "Court-margin pleadings, bail applications, statutory demand notices, plaints, written statements & affidavits",
    },
    nyaya: {
        name: "Nyaya",
        role: "Senior Legal Researcher & Constitutional Jurist",
        focus: "Statutory interpretation, Supreme Court precedents, ratio decidendi extraction, BNS/BNSS/BSA transition analysis",
    },
    pramaan: {
        name: "Pramaan",
        role: "Forensic Case Scrutiny Specialist & Evidence Auditor",
        focus: "Contradiction matrices, Section 63 BSA / 65B IEA compliance, chronological timelines & cross-examination frameworks",
    },
    docket: {
        name: "Docket",
        role: "Chamber Practice Manager & Limitation Coordinator",
        focus: "Statutory limitation calculations, cause list coordination, hearing preparation briefs & filing compliance",
    },
    soli: {
        name: "Soli Master",
        role: "Chamber Lead Counsel & Multi-Disciplinary Director",
        focus: "Integrated litigation strategy, multi-specialty legal synthesis & chamber advisory",
    },
};
/**
 * Deterministic intent analyzer and sub-agent routing classifier.
 * Evaluates the user's task prompt and attached document context to deploy
 * the optimal specialist counsel.
 */
export function routeLegalTask(prompt, attachmentCount = 0) {
    const q = prompt.toLowerCase();
    // 1. Evidence Scrutiny & Forensic Audit (Pramaan)
    const evidenceKeywords = [
        "contradiction", "discrepanc", "inconsisten", "loophole",
        "timeline", "chronolog", "fir audit", "charge-sheet", "chargesheet",
        "section 180", "section 183", "section 161", "section 164",
        "section 65b", "section 63 bsa", "electronic evidence", "call details", "cdr",
        "cross-examination", "cross examination", "panchnama", "chain of custody",
        "scrutiniz", "audit the case", "audit the attached", "audit case"
    ];
    const evidenceScore = evidenceKeywords.filter(k => q.includes(k)).length + (attachmentCount > 0 && q.includes("audit") ? 2 : 0);
    // 2. Courtroom Drafting & Pleadings (Vakil)
    const draftingKeywords = [
        "draft", "drafting", "petition", "pleading", "bail application",
        "regular bail", "anticipatory bail", "quashing", "section 528",
        "legal notice", "statutory notice", "demand notice", "section 138",
        "plaint", "written statement", "affidavit", "rejoinder", "interim application",
        "prayer clause", "verification", "cause title", "agreement", "lease deed",
        "power of attorney", "generate pdf", "generate docx", "format as court paper"
    ];
    const draftingScore = draftingKeywords.filter(k => q.includes(k)).length;
    // 3. Statutory & Precedent Legal Research (Nyaya)
    const researchKeywords = [
        "case law", "precedent", "ratio decidendi", "supreme court", "high court",
        "landmark", "judgment", "ruling", "constitutional", "article 21", "article 32",
        "article 226", "interpretation", "difference between", "bns vs ipc",
        "bnss vs crpc", "bsa vs iea", "substantive changes", "overruled",
        "res integra", "bench strength", "constitution bench", "statutory framework",
        "legislative intent", "comparative analysis"
    ];
    const researchScore = researchKeywords.filter(k => q.includes(k)).length;
    // 4. Chamber Practice & Limitation Deadlines (Docket)
    const chamberKeywords = [
        "limitation", "limitation period", "delay condonation", "condone delay",
        "cause list", "hearing date", "next date of hearing", "ndh",
        "filing deadline", "filing window", "cure period", "diary number",
        "matter synopsis", "client intake", "chamber brief", "hearing checklist",
        "how many days to file", "time barred", "statute of limitations", "within 90 days", "within 30 days"
    ];
    // Weight limitation and deadline inquiries higher because procedural deadlines are critical
    const chamberScore = chamberKeywords.filter(k => q.includes(k)).length * 1.5;
    // Determine winner by highest scoring intent
    const scores = [
        { target: "pramaan", score: evidenceScore, reason: "Evidence scrutiny, contradiction matrix, or witness audit intent detected" },
        { target: "vakil", score: draftingScore, reason: "Court drafting, petition, or pleading formulation intent detected" },
        { target: "nyaya", score: researchScore, reason: "Statutory interpretation, judicial precedent, or ratio research intent detected" },
        { target: "docket", score: chamberScore, reason: "Limitation period, cause list, or procedural deadline intent detected" },
    ];
    scores.sort((a, b) => b.score - a.score);
    const best = scores[0];
    if (best.score > 0) {
        const agent = SUB_AGENTS[best.target];
        return {
            target: best.target,
            name: agent.name,
            role: agent.role,
            reason: best.reason,
            confidence: Math.min(1.0, 0.6 + best.score * 0.15),
        };
    }
    // Fallback defaults based on subtle cues
    if (q.includes("bail") || q.includes("notice") || q.includes("quash")) {
        return {
            target: "vakil",
            name: SUB_AGENTS.vakil.name,
            role: SUB_AGENTS.vakil.role,
            reason: "Pleading and court relief drafting context",
            confidence: 0.7,
        };
    }
    if (q.includes("section") || q.includes("act") || q.includes("offence") || q.includes("punishment")) {
        return {
            target: "nyaya",
            name: SUB_AGENTS.nyaya.name,
            role: SUB_AGENTS.nyaya.role,
            reason: "Statutory analysis and legal interpretation context",
            confidence: 0.7,
        };
    }
    // General Chamber Master
    return {
        target: "soli",
        name: SUB_AGENTS.soli.name,
        role: SUB_AGENTS.soli.role,
        reason: "Multi-disciplinary legal inquiry and comprehensive strategic guidance",
        confidence: 0.85,
    };
}
