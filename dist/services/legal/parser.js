/**
 * Legal Statute, Order/Rule, and Bare Act Parser for Soli/Lirava.
 *
 * Implements:
 * 1. Monotonic section splitting with large gap recovery (>5 sections, e.g. Contract Act 1872 Sections 76-123).
 * 2. Lettered statutory sections (e.g. 41A, 143A, 304B, 376DA).
 * 3. CPC dual hierarchy: substantive sections (1-158) + First Schedule Orders (I-LI) and Rules.
 * 4. Structural extraction of sub-clauses, provisos, explanations, and illustrations.
 */
export const CANONICAL_ACTS = {
    BNSS: {
        code: "BNSS",
        title: "Bharatiya Nagarik Suraksha Sanhita, 2023",
        year: 2023,
        category: "criminal_procedure",
    },
    BNSS_2023: {
        code: "BNSS",
        title: "Bharatiya Nagarik Suraksha Sanhita, 2023",
        year: 2023,
        category: "criminal_procedure",
    },
    BNS: {
        code: "BNS",
        title: "Bharatiya Nyaya Sanhita, 2023",
        year: 2023,
        category: "penal_code",
    },
    BNS_2023: {
        code: "BNS",
        title: "Bharatiya Nyaya Sanhita, 2023",
        year: 2023,
        category: "penal_code",
    },
    BSA: {
        code: "BSA",
        title: "Bharatiya Sakshya Adhiniyam, 2023",
        year: 2023,
        category: "evidence",
    },
    BSA_2023: {
        code: "BSA",
        title: "Bharatiya Sakshya Adhiniyam, 2023",
        year: 2023,
        category: "evidence",
    },
    CPC: {
        code: "CPC",
        title: "Code of Civil Procedure, 1908",
        year: 1908,
        category: "civil_procedure",
    },
    CPC_1908: {
        code: "CPC",
        title: "Code of Civil Procedure, 1908",
        year: 1908,
        category: "civil_procedure",
    },
    CRPC: {
        code: "CRPC",
        title: "Code of Criminal Procedure, 1973",
        year: 1974,
        category: "criminal_procedure",
    },
    CRPC_1973: {
        code: "CRPC",
        title: "Code of Criminal Procedure, 1973",
        year: 1974,
        category: "criminal_procedure",
    },
    IPC: {
        code: "IPC",
        title: "Indian Penal Code",
        year: 1860,
        category: "penal_code",
    },
    IPC_1860: {
        code: "IPC",
        title: "Indian Penal Code",
        year: 1860,
        category: "penal_code",
    },
    ICA: {
        code: "ICA",
        title: "Indian Contract Act, 1872",
        year: 1872,
        category: "commercial",
    },
    ICA_1872: {
        code: "ICA",
        title: "Indian Contract Act, 1872",
        year: 1872,
        category: "commercial",
    },
    CONTRACT_ACT_1872: {
        code: "ICA",
        title: "Indian Contract Act, 1872",
        year: 1872,
        category: "commercial",
    },
    NIA: {
        code: "NIA",
        title: "Negotiable Instruments Act, 1881",
        year: 1881,
        category: "commercial",
    },
    NIA_1881: {
        code: "NIA",
        title: "Negotiable Instruments Act, 1881",
        year: 1881,
        category: "commercial",
    },
    NI_ACT_1881: {
        code: "NIA",
        title: "Negotiable Instruments Act, 1881",
        year: 1881,
        category: "commercial",
    },
};
const ROMAN_MAP = {
    I: 1,
    V: 5,
    X: 10,
    L: 50,
    C: 100,
    D: 500,
    M: 1000,
};
export function romanToArabic(roman) {
    const upper = roman.toUpperCase().trim();
    let total = 0;
    let current = 0;
    for (let i = upper.length - 1; i >= 0; i--) {
        const val = ROMAN_MAP[upper[i]] || 0;
        if (val < current) {
            total -= val;
        }
        else {
            total += val;
            current = val;
        }
    }
    return total;
}
/**
 * Extracts sub-clauses, provisos, explanations, and illustrations from a section text.
 */
export function extractStructuralElements(body) {
    const sub_clauses = [];
    const provisos = [];
    const explanations = [];
    const illustrations = [];
    let mainText = body;
    // 1. Partition Illustrations
    let illustrationText = "";
    const illMatch = /(?:^|\n|\.\s*)(?:Illustrations?[:.—–-]?\s*)([\s\S]*)$/i.exec(mainText);
    if (illMatch) {
        illustrationText = illMatch[1];
        mainText = mainText.slice(0, illMatch.index);
    }
    // 2. Partition Explanations
    let explanationText = "";
    const expMatch = /(?:^|\n|[:;.]\s*)(Explanation(?:\s*\d+|\s*[IVX]+)?\s*[.—–-][\s\S]*)$/i.exec(mainText);
    if (expMatch) {
        explanationText = expMatch[1];
        mainText = mainText.slice(0, expMatch.index);
    }
    // 3. Partition Provisos
    const provisoRegex = /(?:^|\n|[:;]\s*|\.\s*)(Provided\s+(?:further\s+|also\s+)?that\s+[\s\S]*?)(?=(?:[:;]?\s*Provided|$))/gi;
    let pMatch;
    while ((pMatch = provisoRegex.exec(mainText)) !== null) {
        const text = pMatch[1].trim().replace(/\s+/g, " ");
        if (text.length > 10)
            provisos.push(text);
    }
    let coreText = mainText;
    const firstProvisoIndex = mainText.search(/(?:[:;]\s*|\n\s*|\.\s*)Provided\s+(?:further\s+|also\s+)?that/i);
    if (firstProvisoIndex !== -1) {
        coreText = mainText.slice(0, firstProvisoIndex);
    }
    // 4. Extract Sub-clauses from core text
    const subClauseRegex = /(?:^|\n|[\s—–-]|:\s*)(?<!\b(?:clause|sub-section|section|rule|para|order)\s*)(\((?:\d{1,2}|[a-z]|[ivx]{1,4})\))\s+([^(]+?(?=(?:\s*\(\d+|\s*\([a-z]\)|$)))/gi;
    let scMatch;
    while ((scMatch = subClauseRegex.exec(coreText)) !== null) {
        const text = scMatch[2].trim().replace(/\s+/g, " ");
        if (text.length > 2) {
            sub_clauses.push({ num: scMatch[1], text });
        }
    }
    // 5. Decompose Explanations
    if (explanationText) {
        const expRegex = /(Explanation(?:\s*\d+|\s*[IVX]+)?\s*[.—–-][\s\S]*?)(?=(?:\s*Explanation|$))/gi;
        let em;
        while ((em = expRegex.exec(explanationText)) !== null) {
            const text = em[1].trim().replace(/\s+/g, " ");
            if (text.length > 5)
                explanations.push(text);
        }
    }
    // 6. Decompose Illustrations
    if (illustrationText) {
        const illRegex = /(\([a-z]\)\s+[\s\S]*?)(?=(?:\s*\([a-z]\)|$))/gi;
        let im;
        while ((im = illRegex.exec(illustrationText)) !== null) {
            const text = im[1].trim().replace(/\s+/g, " ");
            if (text.length > 5)
                illustrations.push(text);
        }
        if (!illustrations.length && illustrationText.trim().length > 5) {
            illustrations.push(illustrationText.trim().replace(/\s+/g, " "));
        }
    }
    return { sub_clauses, provisos, explanations, illustrations };
}
/**
 * Splits raw statute text into individual sections.
 * Resolves the repealed section gap issue (>5 sections jump, e.g. Contract Act 1872 Sec 76-123).
 * Supports lettered sections (e.g. 41A, 143A, 304B, 376DA).
 */
export function splitIntoSections(raw, options) {
    const maxSec = options?.maxSectionNumber ?? 1000;
    const lines = raw.replace(/\r\n?/g, "\n").split("\n").map((line) => line.trim());
    const starts = [];
    let last = 0;
    for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        if (!line)
            continue;
        // Detect repealed section spans (e.g., "[Sections 76 to 123 Repealed...]" or "76-123. [Repealed]")
        const rep = /^(?:\[|\()?SECTIONS?\s*(\d{1,4})\s*(?:[-–—]|to)\s*(\d{1,4})\s*[.)\]]?\s*.*?(?:repealed|omitted|rep\.)/i.exec(line) ||
            /^(\d{1,4})\s*(?:[-–—]|to)\s*(\d{1,4})\s*[.)]?\s*(?:\[|\()?.*?(?:repealed|omitted|rep\.)/i.exec(line);
        if (rep) {
            const from = Number(rep[1]);
            const to = Number(rep[2]);
            if (from >= last) {
                last = Math.max(last, to);
                continue;
            }
        }
        const m = /^(?:Section\s+|Sec\.\s+)?(\d{1,4})([A-Za-z]{0,3})\s*[.:)\-—–]\s*(\S.*)?$/i.exec(line);
        if (!m)
            continue;
        const n = Number(m[1]);
        const letters = (m[2] || "").toUpperCase();
        const rest = m[3] || "";
        if (n > maxSec)
            continue;
        // Reject internal definitions or list bullet points (e.g. 1. "applicant" means...;)
        const isInternalItem = /^"[^"]+"\s+means\b/i.test(rest) ||
            line.endsWith(";") ||
            line.endsWith(",") ||
            line.endsWith("; and") ||
            line.endsWith("; or");
        if (isInternalItem)
            continue;
        const hasHeadingSeparator = /^[^\n—–-]+[—–-]/.test(rest);
        const hasExplicitPrefix = /^(?:Section\s+|Sec\.\s+)/i.test(line);
        const hasQuotesTitle = /^"[^"]+"/.test(rest);
        const looksLikeSection = hasHeadingSeparator || hasExplicitPrefix || hasQuotesTitle || rest.length === 0;
        const isNext = n === last + 1 ||
            (letters && n === last) ||
            (n > last && n <= last + 5) ||
            (n > last && looksLikeSection) ||
            (letters && n > last && looksLikeSection);
        if (!isNext && last !== 0)
            continue;
        if (last === 0 && n > 3 && !hasExplicitPrefix && !hasHeadingSeparator)
            continue;
        last = Math.max(last, n);
        starts.push({ index, section: `${m[1]}${letters}`, rest });
    }
    const sections = [];
    starts.forEach((start, i) => {
        const end = i + 1 < starts.length ? starts[i + 1].index : lines.length;
        const bodyLines = lines.slice(start.index + 1, end);
        const rawBody = [start.rest, ...bodyLines]
            .filter((l) => l && !/^(CHAPTER\s+[IVXLC\d]+|PART\s+[IVXLC\d]+|\d+\s*$)/i.test(l))
            .join(" ")
            .replace(/\s+/g, " ")
            .trim();
        if (rawBody.length < 10)
            return;
        const headingMatch = /^(.{3,200}?)(?:\.\s*[—–-]|\.\s|\s[—–-]\s|(?=\s*\(\d+\))|$)/.exec(rawBody);
        const heading = headingMatch ? headingMatch[1].trim().replace(/[.:—–-]+$/, "") : rawBody.slice(0, 120);
        const draft = {
            section: start.section,
            section_num: start.section,
            title: heading.trim(),
            text: rawBody,
        };
        if (options?.extractStructuralElements) {
            const struct = extractStructuralElements(rawBody);
            draft.sub_clauses = struct.sub_clauses;
            draft.provisos = struct.provisos;
            draft.explanations = struct.explanations;
            draft.illustrations = struct.illustrations;
        }
        sections.push(draft);
    });
    return sections;
}
/**
 * Parses First Schedule of Code of Civil Procedure, 1908 (Orders I-LI and Rules 1-N).
 */
export function parseCpcOrders(raw, options) {
    const lines = raw.replace(/\r\n?/g, "\n").split("\n").map((line) => line.trim());
    let currentOrderRoman = "";
    let currentOrderNum = 0;
    const ruleStarts = [];
    lines.forEach((line, index) => {
        if (!line)
            return;
        const orderMatch = /^(?:THE\s+FIRST\s+SCHEDULE\s+)?ORDER\s+([IVXLCDM]+|\d+)(?:\s*[:.—–-]\s*|\s+)?(.*)$/i.exec(line);
        if (orderMatch) {
            const orderSpec = orderMatch[1];
            if (/^\d+$/.test(orderSpec)) {
                currentOrderNum = Number(orderSpec);
                currentOrderRoman = orderSpec;
            }
            else {
                currentOrderRoman = orderSpec.toUpperCase();
                currentOrderNum = romanToArabic(currentOrderRoman);
            }
            return;
        }
        if (!currentOrderNum)
            return;
        const ruleMatch = /^(?:Rule\s+)?(\d{1,3})([A-Za-z]{0,2})\s*[.:)\-—–]\s*(\S.*)?$/i.exec(line);
        if (ruleMatch) {
            const rNum = Number(ruleMatch[1]);
            const rLetters = (ruleMatch[2] || "").toUpperCase();
            const rest = ruleMatch[3] || "";
            const ruleKey = `${rNum}${rLetters}`;
            ruleStarts.push({
                orderRoman: currentOrderRoman,
                orderNum: currentOrderNum,
                ruleNum: ruleKey,
                lineIndex: index,
                rest,
            });
        }
    });
    const drafts = [];
    ruleStarts.forEach((start, i) => {
        const end = i + 1 < ruleStarts.length ? ruleStarts[i + 1].lineIndex : lines.length;
        const bodyLines = lines.slice(start.lineIndex + 1, end);
        const rawBody = [start.rest, ...bodyLines]
            .filter((l) => l && !/^(ORDER\s+[IVXLC\d]+|THE\s+FIRST\s+SCHEDULE|\d+\s*$)/i.test(l))
            .join(" ")
            .replace(/\s+/g, " ")
            .trim();
        if (rawBody.length < 10)
            return;
        const headingMatch = /^(.{3,200}?)(?:\.\s*[—–-]|\.\s|\s[—–-]\s|(?=\s*\(\d+\))|$)/.exec(rawBody);
        const heading = headingMatch ? headingMatch[1].trim().replace(/[.:—–-]+$/, "") : rawBody.slice(0, 120);
        const draft = {
            section: `Order ${start.orderRoman} Rule ${start.ruleNum}`,
            section_num: `O${start.orderNum}_R${start.ruleNum}`,
            title: heading.trim(),
            text: rawBody,
            orderRoman: start.orderRoman,
            orderNum: start.orderNum,
            ruleNum: start.ruleNum,
        };
        if (options?.extractStructuralElements) {
            const struct = extractStructuralElements(rawBody);
            draft.sub_clauses = struct.sub_clauses;
            draft.provisos = struct.provisos;
            draft.explanations = struct.explanations;
            draft.illustrations = struct.illustrations;
        }
        drafts.push(draft);
    });
    return drafts;
}
/**
 * Unified Bare Act parser supporting all standard acts and CPC dual hierarchy.
 */
export function parseBareAct(raw, actCode, options) {
    const normCode = actCode.toUpperCase().trim();
    const meta = CANONICAL_ACTS[normCode] || {
        code: normCode,
        title: options?.actTitle || `${normCode} Act`,
        year: options?.year || 2024,
        category: options?.category || "general",
    };
    const actTitle = options?.actTitle || meta.title;
    const year = options?.year || meta.year;
    const category = options?.category || meta.category;
    const actSlug = meta.code.toLowerCase();
    // CPC dual hierarchy: Sections 1-158 + Orders I-LI and Rules
    if (meta.code === "CPC" || /ORDER\s+[IVXLC\d]+/i.test(raw)) {
        const scheduleMatch = /(?:THE\s+FIRST\s+SCHEDULE|\bORDER\s+I\b)/i.exec(raw);
        let sectionText = raw;
        let orderText = "";
        if (scheduleMatch) {
            sectionText = raw.slice(0, scheduleMatch.index);
            orderText = raw.slice(scheduleMatch.index);
        }
        else if (/\bORDER\s+[IVXLCDM]+\b/i.test(raw)) {
            orderText = raw;
            sectionText = "";
        }
        const provisions = [];
        if (sectionText.trim().length > 50) {
            const sections = splitIntoSections(sectionText, { ...options, extractStructuralElements: true });
            for (const s of sections) {
                provisions.push({
                    id: `${actSlug}-${year}-sec-${s.section.toLowerCase()}`,
                    act_code: meta.code,
                    act_title: actTitle,
                    year,
                    section: `Section ${s.section}`,
                    section_num: s.section,
                    title: s.title,
                    text: s.text,
                    category,
                    sub_clauses: s.sub_clauses,
                    provisos: s.provisos,
                    explanations: s.explanations,
                    illustrations: s.illustrations,
                });
            }
        }
        if (orderText.trim().length > 50) {
            const orderDrafts = parseCpcOrders(orderText, { ...options, extractStructuralElements: true });
            for (const od of orderDrafts) {
                const oNum = od.orderNum ?? 1;
                const rNum = od.ruleNum ?? "1";
                provisions.push({
                    id: `${actSlug}-${year}-o${oNum}-r${rNum.toLowerCase()}`,
                    act_code: meta.code,
                    act_title: actTitle,
                    year,
                    section: od.section,
                    section_num: `O${oNum}_R${rNum}`,
                    title: od.title,
                    text: od.text,
                    category,
                    sub_clauses: od.sub_clauses,
                    provisos: od.provisos,
                    explanations: od.explanations,
                    illustrations: od.illustrations,
                });
            }
        }
        return provisions;
    }
    // Standard Bare Acts
    const drafts = splitIntoSections(raw, { ...options, extractStructuralElements: true });
    return drafts.map((d) => ({
        id: `${actSlug}-${year}-sec-${d.section.toLowerCase()}`,
        act_code: meta.code,
        act_title: actTitle,
        year,
        section: `Section ${d.section}`,
        section_num: d.section,
        title: d.title,
        text: d.text,
        category,
        sub_clauses: d.sub_clauses,
        provisos: d.provisos,
        explanations: d.explanations,
        illustrations: d.illustrations,
    }));
}
