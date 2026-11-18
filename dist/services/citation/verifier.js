import { getSql } from "../db/postgres.js";
import { STATUTORY_CORPUS_SEED, PRECEDENT_CORPUS_SEED, } from "../legal/seeds/index.js";
export const ACT_NORMALIZATION = {
    bnss: { code: "BNSS_2023", title: "Bharatiya Nagarik Suraksha Sanhita, 2023" },
    bns: { code: "BNS_2023", title: "Bharatiya Nyaya Sanhita, 2023" },
    bsa: { code: "BSA_2023", title: "Bharatiya Sakshya Adhiniyam, 2023" },
    cpc: { code: "CPC_1908", title: "Code of Civil Procedure, 1908" },
    crpc: { code: "CRPC_1973", title: "Code of Criminal Procedure, 1973" },
    ipc: { code: "IPC_1860", title: "Indian Penal Code, 1860" },
    ica: { code: "ICA_1872", title: "Indian Contract Act, 1872" },
    nia: { code: "NIA_1881", title: "Negotiable Instruments Act, 1881" },
    "contract act": { code: "ICA_1872", title: "Indian Contract Act, 1872" },
    "indian contract act": { code: "ICA_1872", title: "Indian Contract Act, 1872" },
    "negotiable instruments act": { code: "NIA_1881", title: "Negotiable Instruments Act, 1881" },
    "ni act": { code: "NIA_1881", title: "Negotiable Instruments Act, 1881" },
};
export class CitationVerificationService {
    db;
    constructor(db) {
        this.db = db;
    }
    getProvisions() {
        if (this.db?.legalProvisions) {
            return Array.from(this.db.legalProvisions.values());
        }
        const sql = getSql();
        if (sql?._db?.legalProvisions) {
            return Array.from(sql._db.legalProvisions.values());
        }
        return STATUTORY_CORPUS_SEED.map((p) => ({
            id: p.id,
            act: p.act_title,
            act_code: p.act_code,
            section: p.section,
            section_num: p.section_num,
            title: p.title,
            text: p.text,
            ratio: p.ratio ?? null,
        }));
    }
    getCases() {
        if (this.db?.legalCases) {
            return Array.from(this.db.legalCases.values());
        }
        const sql = getSql();
        if (sql?._db?.legalCases) {
            return Array.from(sql._db.legalCases.values());
        }
        return PRECEDENT_CORPUS_SEED.map((c) => ({
            id: c.id,
            case_title: c.case_title,
            primary_citation: c.primary_citation,
            equivalent_citations: c.equivalent_citations,
            neutral_citation: c.neutral_citation,
            court: c.court,
            year: c.year,
            bench_description: c.bench_description,
            ratio: c.ratio,
            principles: c.principles,
        }));
    }
    normalizeAct(rawAct) {
        const lower = rawAct.toLowerCase().replace(/[^a-z\s]/g, "").trim();
        for (const [key, val] of Object.entries(ACT_NORMALIZATION)) {
            if (lower === key || lower.includes(key)) {
                return val;
            }
        }
        return null;
    }
    async verifyTextCitations(text, options) {
        const verified = [];
        const unverified = [];
        const provisions = this.getProvisions();
        const cases = this.getCases();
        // 1. Extract Statutory Citations: Pattern 1 (Section X of Act)
        let match;
        const p1 = /(?:Section|Sec\.?)\s*(\d+[A-Z]{0,2}(?:\(\d+\))?)\s*(?:,\s*)?(?:of\s+)?(?:the\s+)?(BNSS|BNS|BSA|CPC|CrPC|IPC|ICA|NIA|Indian Contract Act|Negotiable Instruments Act|Bharatiya Nagarik Suraksha Sanhita|Bharatiya Nyaya Sanhita|Bharatiya Sakshya Adhiniyam)(?:,\s*\d{4})?/gi;
        while ((match = p1.exec(text)) !== null) {
            const secNum = match[1];
            const actRaw = match[2];
            const actInfo = this.normalizeAct(actRaw);
            if (!actInfo) {
                unverified.push({
                    raw: match[0],
                    type: "statute",
                    reason: "unverified",
                    warning: `Unknown act: ${actRaw}`,
                });
                continue;
            }
            // Check homonym hazards
            const textLower = text.toLowerCase();
            if (actInfo.code === "BNSS_2023" && secNum === "482" && textLower.includes("quash")) {
                unverified.push({
                    raw: match[0],
                    type: "statute",
                    act: actInfo.code,
                    section: secNum,
                    reason: "homonym_mismatch",
                    warning: "BNSS 482 is Anticipatory Bail, not Quashing. Quashing under BNSS is Section 528.",
                });
                continue;
            }
            if (actInfo.code === "BNS_2023" && secNum === "302" && textLower.includes("murder")) {
                unverified.push({
                    raw: match[0],
                    type: "statute",
                    act: actInfo.code,
                    section: secNum,
                    reason: "homonym_mismatch",
                    warning: "BNS 302 is Snatching, not Murder. Murder under BNS is Section 103(1).",
                });
                continue;
            }
            // Check temporal jurisdiction bar (Article 20(1))
            if (options?.offenceDate && actInfo.code === "BNS_2023") {
                const offDate = new Date(options.offenceDate);
                const cutoff = new Date("2024-07-01");
                if (offDate < cutoff) {
                    unverified.push({
                        raw: match[0],
                        type: "statute",
                        act: actInfo.code,
                        section: secNum,
                        reason: "ex_post_facto_violation",
                        warning: "Article 20(1) ex-post facto bar: offence committed prior to July 1, 2024 must be charged under IPC 1860.",
                    });
                    continue;
                }
            }
            // Lookup in provisions
            let found = false;
            for (const p of provisions) {
                const pActCode = p.act_code || (p.act ? p.act.split(/[\s,]+/)[0].toUpperCase() : "");
                const pSecNum = p.section_num || p.section.replace(/^Section\s+/i, "");
                if ((pActCode.includes(actInfo.code.split("_")[0]) ||
                    p.act.toLowerCase().includes(actRaw.toLowerCase())) &&
                    pSecNum.toLowerCase() === secNum.toLowerCase()) {
                    found = true;
                    const status = pActCode.includes("IPC") && secNum === "124A" ? "held_in_abeyance" : "verified";
                    verified.push({
                        id: p.id,
                        citation: `Section ${secNum}, ${actInfo.title}`,
                        type: "statute",
                        act: actInfo.title,
                        act_code: actInfo.code,
                        section: `Section ${secNum}`,
                        section_num: secNum,
                        confidence: 1.0,
                        status,
                    });
                    break;
                }
            }
            if (!found) {
                unverified.push({
                    raw: match[0],
                    type: "statute",
                    act: actInfo.code,
                    section: secNum,
                    reason: "non_existent_section",
                    warning: `Section ${secNum} does not exist in ${actInfo.title}`,
                });
            }
        }
        // Pattern 2: Act Section X (e.g. BNSS 482, BNS 302)
        const p2 = /\b(BNSS|BNS|BSA|CPC|CrPC|IPC|ICA|NIA)\s+(?:Section|Sec\.?)?\s*(\d+[A-Z]{0,2}(?:\(\d+\))?)\b/gi;
        while ((match = p2.exec(text)) !== null) {
            const actRaw = match[1];
            const secNum = match[2];
            const actInfo = this.normalizeAct(actRaw);
            if (!actInfo)
                continue;
            if (verified.some((v) => v.act_code === actInfo.code && v.section_num === secNum))
                continue;
            if (unverified.some((u) => u.act === actInfo.code && u.section === secNum))
                continue;
            // Check homonym
            const textLower = text.toLowerCase();
            if (actInfo.code === "BNSS_2023" && secNum === "482" && textLower.includes("quash")) {
                unverified.push({
                    raw: match[0],
                    type: "statute",
                    act: actInfo.code,
                    section: secNum,
                    reason: "homonym_mismatch",
                    warning: "BNSS 482 is Anticipatory Bail, not Quashing. Quashing under BNSS is Section 528.",
                });
                continue;
            }
            let found = false;
            for (const p of provisions) {
                const pActCode = p.act_code || "";
                const pSecNum = p.section_num || "";
                if (pActCode.includes(actInfo.code.split("_")[0]) &&
                    pSecNum.toLowerCase() === secNum.toLowerCase()) {
                    found = true;
                    verified.push({
                        id: p.id,
                        citation: `Section ${secNum}, ${actInfo.title}`,
                        type: "statute",
                        act: actInfo.title,
                        act_code: actInfo.code,
                        section: `Section ${secNum}`,
                        section_num: secNum,
                        confidence: 1.0,
                        status: "verified",
                    });
                    break;
                }
            }
            if (!found) {
                unverified.push({
                    raw: match[0],
                    type: "statute",
                    act: actInfo.code,
                    section: secNum,
                    reason: "non_existent_section",
                    warning: `Section ${secNum} does not exist in ${actInfo.title}`,
                });
            }
        }
        // Pattern 3: CPC Order/Rule
        const p3 = /(Order\s+[IVXLCDM]+\s+Rule\s+\d+[A-Z]?)/gi;
        while ((match = p3.exec(text)) !== null) {
            const orderRuleStr = match[1];
            let found = false;
            for (const p of provisions) {
                if (p.act.includes("Civil Procedure") &&
                    (p.section.toLowerCase() === orderRuleStr.toLowerCase() ||
                        p.id.includes(orderRuleStr.toLowerCase().replace(/\s+/g, "-")))) {
                    found = true;
                    verified.push({
                        id: p.id,
                        citation: `${orderRuleStr}, Code of Civil Procedure, 1908`,
                        type: "statute",
                        act: "Code of Civil Procedure, 1908",
                        act_code: "CPC_1908",
                        section: orderRuleStr,
                        confidence: 1.0,
                        status: "verified",
                    });
                    break;
                }
            }
            if (!found) {
                unverified.push({
                    raw: match[0],
                    type: "statute",
                    reason: "non_existent_section",
                });
            }
        }
        // 2. Extract Judicial Citations: Neutral citations: YYYY INSC NNN
        const neutralP = /\b(\d{4})\s+INSC\s+(\d+)\b/gi;
        while ((match = neutralP.exec(text)) !== null) {
            const raw = match[0];
            const matchCase = cases.find((c) => c.neutral_citation?.toLowerCase() === raw.toLowerCase());
            if (matchCase) {
                verified.push({
                    id: matchCase.id,
                    citation: matchCase.primary_citation,
                    neutral_citation: matchCase.neutral_citation,
                    primary_citation: matchCase.primary_citation,
                    case_title: matchCase.case_title,
                    court: matchCase.court,
                    type: "case",
                    confidence: 1.0,
                    status: "verified",
                });
            }
            else {
                unverified.push({
                    raw,
                    type: "case",
                    reason: "synthetic_citation",
                    warning: `Neutral citation ${raw} not found in verified database`,
                });
            }
        }
        // Check reporter citations
        for (const testCase of cases) {
            const primary = testCase.primary_citation;
            if (text.includes(primary) && !verified.some((v) => v.id === testCase.id)) {
                verified.push({
                    id: testCase.id,
                    citation: testCase.primary_citation,
                    primary_citation: testCase.primary_citation,
                    neutral_citation: testCase.neutral_citation,
                    case_title: testCase.case_title,
                    court: testCase.court,
                    type: "case",
                    confidence: 1.0,
                    status: "verified",
                });
            }
            if (testCase.equivalent_citations) {
                for (const eq of testCase.equivalent_citations) {
                    if (text.includes(eq) && !verified.some((v) => v.id === testCase.id)) {
                        verified.push({
                            id: testCase.id,
                            citation: testCase.primary_citation,
                            primary_citation: testCase.primary_citation,
                            neutral_citation: testCase.neutral_citation,
                            case_title: testCase.case_title,
                            court: testCase.court,
                            type: "case",
                            confidence: 1.0,
                            status: "verified",
                        });
                    }
                }
            }
        }
        // Synthetic reporter test: e.g. [2029] 99 SCC 1234 or (2025) 18 SCC 9999
        const fakeMatches = text.match(/(?:\[20\d\d\]|\(20\d\d\))\s*\d+\s*SCC\s*\d+/gi) || [];
        for (const fake of fakeMatches) {
            if (!verified.some((v) => v.citation.includes(fake) || v.primary_citation?.includes(fake))) {
                unverified.push({
                    raw: fake,
                    type: "case",
                    reason: "synthetic_citation",
                    warning: `Synthetic citation detected: ${fake}`,
                });
            }
        }
        return {
            verified,
            unverified,
            cleanText: text,
        };
    }
}
export function createCitationVerifier(db) {
    return new CitationVerificationService(db);
}
export async function verifyTextCitations(text, options) {
    const verifier = new CitationVerificationService();
    return verifier.verifyTextCitations(text, options);
}
