/**
 * Decides, before anything is searched, whether a message needs the legal knowledge base.
 *
 * A legal question searches the statute library and the user's own documents. A general or casual message
 * ("what is the capital of France", "write a poem", "thanks") searches nothing, so it is faster and no
 * unrelated statute is ever attached to it as a "source".
 *
 * A wrong "no" is worse than a wasted search for a legal tool, so the gate only says no when nothing in the
 * message, the chat so far, or the context (an attached file, a case) points to law. Set RETRIEVAL_GATE=off to
 * switch the gate off and search for every message that is not small talk.
 */
import { classifySmallTalk } from "./smalltalk.js";
// Word starts, so "arrested", "arresting" and "arrest" all count. Statutes and courts first, then procedure,
// parties, subjects and offences. Deliberately wide: a missed legal word means a missed source.
const LEGAL_STEMS = [
    // laws and courts
    "bns", "bnss", "bsa", "ipc", "crpc", "cpc", "nia\\b", "ni act", "penal code", "evidence act", "sakshya", "nyaya sanhita", "suraksha sanhita",
    "negotiable instrument", "limitation act", "constitution", "article\\s+\\d", "section\\s+\\d", "sec\\.?\\s*\\d", "order\\s+[ivxlcdm]+\\b", "rule\\s+\\d",
    "statut", "act,?\\s+(?:19|20)\\d\\d", "court", "tribunal", "judge", "judg(?:e)?ment", "verdict", "bench", "supreme", "high court", "magistrate",
    "sessions", "precedent", "ratio", "obiter", "case law", "caselaw", "citation", "nclt", "nclat", "rti\\b", "consumer", "arbitrat", "mediat", "conciliat",
    "insolvency", "ibc\\b", "rera", "pocso", "ndps", "uapa", "pmla", "gst", "income tax", "itr\\b",
    // procedure
    "arrest", "bail", "fir\\b", "f\\.i\\.r", "charge\\s?sheet", "remand", "cognizab", "cognizance", "anticipatory", "quash", "petition", "plaint", "written statement",
    "injunct", "decree", "appeal", "revision", "writ\\b", "habeas", "mandamus", "certiorari", "limitation", "jurisdict", "summon", "warrant", "subpoena",
    "surety", "bond\\b", "trial", "hearing", "adjourn", "interim", "ex parte", "res judicata", "locus", "stay order", "affidavit", "vakalatnama", "power of attorney",
    "legal notice", "notice", "evidence", "witness", "testimon", "confession", "hearsay", "cross-?examin", "prosecut", "investigat", "police", "custody", "detention",
    // parties and professions
    "accused", "complainant", "respondent", "petitioner", "appellant", "plaintiff", "defendant", "defence", "defense", "litigat", "lawsuit", "advocate", "lawyer",
    "counsel", "attorney", "legal", "\\blaws?\\b", "liab", "indemn",
    // subjects
    "contract", "agreement", "tort", "damages", "cheque", "dishono", "tenan", "landlord", "evict", "lease", "property", "probate", "succession", "inherit",
    "divorce", "maintenance", "alimony", "marriage", "dowry", "domestic violence", "guardian", "adopt", "sale deed", "gift deed", "will and testament", "partnership",
    "trademark", "copyright", "patent", "defam", "privacy", "fundamental right", "clause", "provision", "indictment",
    // offences and outcomes
    "offen[cs]e", "punish", "sentenc", "imprison", "convict", "acquit", "murder", "homicide", "culpable", "theft", "robbery", "dacoity", "cheat", "fraud", "forger", "forged",
    "assault", "rape", "kidnap", "extort", "bribe", "corrupt", "conspir", "abet", "riot", "trespass", "nuisance", "mischief", "narcotic", "harass", "stalk", "threat",
    "mens rea", "actus reus", "vicarious", "negligen",
];
const LEGAL_SIGNAL = new RegExp(`(?:^|[^a-z])(?:${LEGAL_STEMS.join("|")})`, "i");
export const hasLegalSignal = (text) => LEGAL_SIGNAL.test(text);
/** Hindi and other scripts have no English legal words to match, so they are treated as possibly legal. */
function mostlyNonLatin(text) {
    const letters = text.match(/\p{L}/gu) ?? [];
    if (letters.length < 4)
        return false;
    const nonLatin = letters.filter((c) => c.charCodeAt(0) > 0x24f).length;
    return nonLatin / letters.length > 0.3;
}
const wordCount = (text) => text.trim().split(/\s+/).filter(Boolean).length;
export function decideRetrieval(input) {
    const text = input.text.trim();
    const none = (reason) => ({ statutes: false, documents: false, reason });
    const all = (reason) => ({ statutes: true, documents: true, reason });
    // Greetings, "what is your name?", thanks and "what can you do?" never need the knowledge base.
    if (classifySmallTalk(text))
        return none("small-talk");
    if (process.env.RETRIEVAL_GATE === "off")
        return all("gate-off");
    if (hasLegalSignal(text))
        return all("legal");
    if (input.hasAttachments)
        return all("attachments");
    if (input.inMatter)
        return all("matter");
    if (mostlyNonLatin(text))
        return all("non-english");
    // A short follow-up in a legal chat ("and what if he was a minor?") belongs to the same subject.
    if (wordCount(text) >= 4 && (input.recent ?? []).slice(-4).some(hasLegalSignal))
        return all("follow-up");
    return none("general");
}
