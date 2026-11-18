/**
 * Case-file extraction: pure logic with no database and no model calls, so it can be tested offline.
 *
 * The rule that protects lawyers from invented facts: every item the model reports must carry a quote,
 * and the quote must appear word for word in the document. An item whose quote cannot be found is dropped.
 * The page number is found by locating the quote, never taken from the model.
 */
/** Characters of document text sent to the model in one call (about 2,000 tokens). */
export const WINDOW_CHARS = 7000;
/** Most windows read per document, so one huge file cannot use up the whole build. */
export const MAX_WINDOWS_PER_DOC = 6;
const MIN_QUOTE_CHARS = 12;
const MAX_ITEMS = 25;
// ---------------- Reading text back out of stored chunks ----------------
/**
 * Stored chunks of one page overlap. Joins them back into the page's text, removing the repeated overlap.
 */
export function joinChunks(chunks) {
    let out = "";
    for (const chunk of chunks) {
        if (!out) {
            out = chunk;
            continue;
        }
        let joined = false;
        for (let k = Math.min(out.length, chunk.length, 400); k >= 20; k--) {
            if (out.endsWith(chunk.slice(0, k))) {
                out += chunk.slice(k);
                joined = true;
                break;
            }
        }
        if (!joined)
            out += ` ${chunk}`;
    }
    return out;
}
// ---------------- Windows ----------------
/** Splits a document into windows small enough for the model's context, keeping page markers. */
export function planWindows(pages, size = WINDOW_CHARS, max = MAX_WINDOWS_PER_DOC) {
    const windows = [];
    let text = "";
    let covered = [];
    const flush = () => {
        if (text.trim())
            windows.push({ text: text.trim(), pages: covered });
        text = "";
        covered = [];
    };
    for (const page of pages) {
        const body = page.text.replace(/\s+/g, " ").trim();
        if (!body)
            continue;
        for (let start = 0; start < body.length; start += size) {
            const piece = body.slice(start, start + size);
            const block = `[page ${page.page}]\n${piece}\n\n`;
            if (text && text.length + block.length > size + 200)
                flush();
            text += block;
            if (!covered.includes(page.page))
                covered.push(page.page);
        }
    }
    flush();
    return windows.slice(0, max);
}
// ---------------- Prompt ----------------
export const EXTRACTION_SYSTEM = "You read one part of a legal document and extract facts for a lawyer's case file. " +
    "Use ONLY the text given. Never use outside knowledge and never guess. If something is not in the text, leave it out. " +
    "Return one JSON object and nothing else.";
/** A tiny worked example. Small models leave the lists empty without one. */
const EXAMPLE_TEXT = "Notice dated 5 January 2025. My client Mr P. Rao lent Rs. 2,00,000 to Ms K. Nair on 10 December 2024 by cheque no. 551102. " +
    "The cheque was returned unpaid on 3 January 2025. You are called upon to pay Rs. 2,00,000 within fifteen days.";
const EXAMPLE_JSON = JSON.stringify({
    docType: "notice",
    docDate: "5 January 2025",
    parties: [
        { name: "Mr P. Rao", role: "lender", quote: "My client Mr P. Rao lent Rs. 2,00,000" },
        { name: "Ms K. Nair", role: "borrower", quote: "to Ms K. Nair on 10 December 2024" },
    ],
    events: [
        { date: "10 December 2024", what: "Rs. 2,00,000 lent by cheque", quote: "lent Rs. 2,00,000 to Ms K. Nair on 10 December 2024" },
        { date: "3 January 2025", what: "Cheque returned unpaid", quote: "The cheque was returned unpaid on 3 January 2025" },
    ],
    facts: [{ text: "Cheque number 551102 was issued", quote: "by cheque no. 551102" }],
    claims: [{ text: "Payment of Rs. 2,00,000 demanded within fifteen days", quote: "pay Rs. 2,00,000 within fifteen days" }],
});
export function extractionPrompt(documentName, windowText) {
    return (`Fill in a case-file record from the text of a legal document. Every list must contain every matching item in the text.\n\n` +
        `EXAMPLE TEXT:\n${EXAMPLE_TEXT}\nEXAMPLE OUTPUT:\n${EXAMPLE_JSON}\n\n` +
        `RULES:\n` +
        `- "quote" is copied exactly, word for word, from the text (5 to 25 words). An item without an exact quote is discarded.\n` +
        `- docType is one of: notice, reply, order, judgment, plaint, complaint, petition, application, affidavit, agreement, letter, other.\n` +
        `- docDate is the date the document itself bears, written as in the text, or "" if none.\n` +
        `- parties: every person or organisation named, with the role the text gives them.\n` +
        `- events: everything that happened on a stated date. Copy the date as written in the text. Skip events with no date.\n` +
        `- facts: amounts, cheque or contract numbers, places and other important facts. One short sentence each.\n` +
        `- claims: what the document demands, denies, alleges or asks for.\n` +
        `- Use only this text. Use empty lists only when the text has nothing for them. At most 12 items per list.\n\n` +
        `Document: ${documentName}\nTEXT:\n${windowText}\n\nOUTPUT (JSON only):`);
}
// ---------------- Parsing and checking ----------------
/** Finds the JSON object in a model reply, tolerating code fences and stray words. Returns null if there is none. */
export function parseWindowJson(raw) {
    if (!raw)
        return null;
    const unfenced = raw.replace(/```(?:json)?/gi, "");
    const start = unfenced.indexOf("{");
    const end = unfenced.lastIndexOf("}");
    if (start < 0 || end <= start)
        return null;
    try {
        const value = JSON.parse(unfenced.slice(start, end + 1));
        return value && typeof value === "object" && !Array.isArray(value) ? value : null;
    }
    catch {
        return null;
    }
}
/** Lower-case, one space between words, straight quotes: what is compared when checking a quote. */
export function normalize(text) {
    return text
        .toLowerCase()
        .replace(/[‘’‛]/g, "'")
        .replace(/[“”„]/g, '"')
        .replace(/[–—]/g, "-")
        .replace(/\s+/g, " ")
        .trim();
}
export const normalizePages = (pages) => pages.map((p) => ({ page: p.page, text: normalize(p.text) }));
/** The page a quote appears on, or null when it does not appear word for word (or is too short to mean anything). */
export function findQuotePage(quote, pages) {
    if (typeof quote !== "string")
        return null;
    const needle = normalize(quote).replace(/^["'\s]+|["'\s.…]+$/g, "");
    if (needle.length < MIN_QUOTE_CHARS)
        return null;
    for (const page of pages)
        if (page.text.includes(needle))
            return page.page;
    return null;
}
export function validDate(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
        return null;
    const [y, m, d] = value.split("-").map(Number);
    const date = new Date(Date.UTC(y, m - 1, d));
    if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d)
        return null;
    if (y < 1900 || y > 2100)
        return null;
    return value;
}
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const monthNumber = (word) => {
    const token = word.replace(/\.$/, "");
    const index = token.length >= 3 ? MONTHS.findIndex((m) => m.startsWith(token)) : -1;
    return index < 0 ? null : index + 1;
};
/**
 * A date as a lawyer writes it ("14 March 2026", "14th March, 2026", "March 14, 2026", "14/03/2026", day first)
 * or as ISO, turned into YYYY-MM-DD. Anything that is not a real calendar date gives null.
 * Models copy dates the way the document writes them, so converting is done here, not left to the model.
 */
export function parseDate(value) {
    if (typeof value !== "string")
        return null;
    const text = value.trim().toLowerCase().replace(/(\d)(?:st|nd|rd|th)\b/g, "$1").replace(/,/g, " ").replace(/\s+/g, " ");
    const iso = validDate(text);
    if (iso)
        return iso;
    let day = null;
    let month = null;
    let year = null;
    let m = /^(\d{1,2}) ([a-z]{3,9}\.?) (\d{4})$/.exec(text);
    if (m)
        [day, month, year] = [Number(m[1]), monthNumber(m[2]), Number(m[3])];
    else if ((m = /^([a-z]{3,9}\.?) (\d{1,2}) (\d{4})$/.exec(text)))
        [day, month, year] = [Number(m[2]), monthNumber(m[1]), Number(m[3])];
    else if ((m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(text)))
        [day, month, year] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (day === null || month === null || year === null)
        return null;
    return validDate(`${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`);
}
/** A name without titles and punctuation, so "M/s Delta Traders" and "Delta Traders" are the same party. */
export function partyKey(name) {
    return normalize(name)
        .replace(/\bm\/s\b/g, " ")
        .replace(/\b(mr|mrs|ms|miss|shri|smt|sri|dr|adv|advocate)\b\.?/g, " ")
        .replace(/[^a-z0-9 ]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}
const clip = (value, max) => (typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "");
const list = (value) => Array.isArray(value) ? value.filter((x) => x && typeof x === "object").slice(0, MAX_ITEMS) : [];
const DOC_TYPES = new Set(["notice", "reply", "order", "judgment", "plaint", "complaint", "petition", "application", "affidavit", "agreement", "letter", "other"]);
/**
 * Checks every item against its document and combines everything into one case file.
 * Items without a findable quote are counted in stats.dropped and left out.
 */
export function mergeCaseFile(parts) {
    const out = { documents: [], parties: [], chronology: [], facts: [], claims: [], stats: { kept: 0, dropped: 0 } };
    const seen = { party: new Set(), event: new Set(), fact: new Set(), claim: new Set() };
    for (const part of parts) {
        let docType = "";
        let docDate = "";
        const source = (page) => ({ documentId: part.doc.id, name: part.doc.name, page });
        for (const raw of part.windows) {
            const type = clip(raw.docType, 20).toLowerCase();
            if (!docType && DOC_TYPES.has(type))
                docType = type;
            if (!docDate)
                docDate = parseDate(raw.docDate) ?? "";
            for (const item of list(raw.parties)) {
                const name = clip(item.name, 120);
                const page = findQuotePage(item.quote, part.pages);
                if (!name || page === null) {
                    out.stats.dropped++;
                    continue;
                }
                const key = partyKey(name) || normalize(name);
                if (seen.party.has(key))
                    continue;
                seen.party.add(key);
                out.parties.push({ name, role: clip(item.role, 60), source: source(page), quote: clip(item.quote, 300) });
                out.stats.kept++;
            }
            for (const item of list(raw.events)) {
                const what = clip(item.what, 240);
                const date = parseDate(item.date);
                const page = findQuotePage(item.quote, part.pages);
                if (!what || !date || page === null) {
                    out.stats.dropped++;
                    continue;
                }
                const key = `${date}|${normalize(what).slice(0, 60)}`;
                if (seen.event.has(key))
                    continue;
                seen.event.add(key);
                out.chronology.push({ date, what, source: source(page), quote: clip(item.quote, 300) });
                out.stats.kept++;
            }
            for (const [kind, bucket, target] of [
                ["fact", list(raw.facts), out.facts],
                ["claim", list(raw.claims), out.claims],
            ]) {
                for (const item of bucket) {
                    const text = clip(item.text, 300);
                    const page = findQuotePage(item.quote, part.pages);
                    if (!text || page === null) {
                        out.stats.dropped++;
                        continue;
                    }
                    const key = normalize(text).slice(0, 80);
                    if (seen[kind].has(key))
                        continue;
                    seen[kind].add(key);
                    target.push({ text, source: source(page), quote: clip(item.quote, 300) });
                    out.stats.kept++;
                }
            }
        }
        out.documents.push({ id: part.doc.id, name: part.doc.name, docType: docType || "other", docDate, pages: part.doc.pages });
    }
    out.chronology.sort((a, b) => a.date.localeCompare(b.date));
    return out;
}
