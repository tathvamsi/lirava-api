/**
 * Tells what kind of document an upload is (FIR, charge sheet, a section 164 statement, a bail application, ...)
 * and fingerprints its text so the same document uploaded twice is noticed.
 *
 * Plain keyword rules, no model: it is instant, works offline and never invents a type. A document that matches
 * nothing is "other". The lawyer can correct a wrong guess, and the case file reads a corrected type as fact.
 */
import { createHash } from "node:crypto";

export const DOC_KINDS = [
  "fir",
  "charge_sheet",
  "statement_164",
  "statement_161",
  "deposition",
  "medical",
  "forensic",
  "panchnama",
  "complaint",
  "notice",
  "bail_application",
  "remand",
  "order",
  "judgment",
  "affidavit",
  "other",
] as const;
export type DocKind = (typeof DOC_KINDS)[number];

export const DOC_KIND_LABEL: Record<DocKind, string> = {
  fir: "FIR",
  charge_sheet: "Charge sheet",
  statement_164: "Statement before a Magistrate (s.164 CrPC / s.183 BNSS)",
  statement_161: "Police statement (s.161 CrPC / s.180 BNSS)",
  deposition: "Court deposition",
  medical: "Medical or post-mortem report",
  forensic: "Forensic report",
  panchnama: "Seizure memo or panchnama",
  complaint: "Complaint",
  notice: "Notice",
  bail_application: "Bail application",
  remand: "Remand application or order",
  order: "Court order",
  judgment: "Judgment",
  affidavit: "Affidavit",
  other: "Other",
};

/** The order the case file reads in: the record of what happened first, argument and orders after. */
export function kindPriority(kind: string): number {
  const i = (DOC_KINDS as readonly string[]).indexOf(kind);
  return i === -1 ? DOC_KINDS.length : i;
}

export const isDocKind = (value: unknown): value is DocKind => typeof value === "string" && (DOC_KINDS as readonly string[]).includes(value);

interface Rule {
  kind: DocKind;
  /** Found in the file name: strong evidence (two points). */
  name: RegExp;
  /** A title that settles it by itself, found near the top (two points). */
  strong?: RegExp;
  /** Found near the top of the text: each rule that matches adds one point. */
  text: RegExp[];
}

const rules: Rule[] = [
  {
    kind: "fir",
    name: /\bf\.?i\.?r\b|first[\s_-]*information/i,
    strong: /first\s+information\s+report|प्रथम\s+सूचना\s+रिपोर्ट|ಪ್ರಥಮ\s+ವರ್ತಮಾನ/i,
    text: [/first\s+information\s+report/i, /\bF\.?I\.?R\.?\s*(?:no|number|\.)/i, /प्रथम\s+सूचना/, /ಪ್ರಥಮ\s+ವರ್ತಮಾನ/, /information\s+(?:received\s+)?under\s+section\s+(?:154|173)/i],
  },
  {
    kind: "charge_sheet",
    name: /charge[\s_-]*sheet|final[\s_-]*report/i,
    strong: /charge[\s-]*sheet|final\s+report\s+under\s+section\s+173|police\s+report\s+under\s+section\s+193|आरोप\s*पत्र|ದೋಷಾರೋಪಣ/i,
    text: [/charge[\s-]*sheet/i, /final\s+report\s+under\s+section\s+173/i, /police\s+report\s+under\s+section\s+193/i, /आरोप\s*पत्र/, /ದೋಷಾರೋಪಣ/],
  },
  {
    kind: "statement_164",
    name: /\b164\b/i,
    text: [/section\s+164\b|\b164\s*(?:of\s+the\s+)?cr\.?p\.?c/i, /section\s+183\s+(?:of\s+)?(?:the\s+)?bnss/i, /recorded\s+before\s+(?:me|the\s+(?:learned\s+)?magistrate)/i, /confession(?:al)?\s+statement/i, /धारा\s*164/, /ಕಲಂ\s*164/],
  },
  {
    kind: "statement_161",
    name: /\b161\b/i,
    text: [/section\s+161\b|\b161\s*(?:of\s+the\s+)?cr\.?p\.?c/i, /section\s+180\s+(?:of\s+)?(?:the\s+)?bnss/i, /statement\s+(?:of\s+\w+(?:\s+\w+)?\s+)?(?:recorded|taken)\s+by\s+(?:the\s+)?(?:police|investigating|i\.?o)/i, /धारा\s*161/, /ಕಲಂ\s*161/],
  },
  {
    kind: "deposition",
    name: /deposition|\bp\.?w[-\s]?\d|\bd\.?w[-\s]?\d|cross[\s_-]*exam/i,
    text: [/examination[\s-]*in[\s-]*chief/i, /cross[\s-]*examination/i, /\bP\.?W\.?[\s-]?\d+\b/, /\bD\.?W\.?[\s-]?\d+\b/, /deposed\s+on\s+oath|sworn\s+(?:and\s+)?examined/i],
  },
  {
    kind: "medical",
    name: /post[\s_-]*mortem|\bmlc\b|medical|wound|injury[\s_-]*(?:report|certificate)/i,
    strong: /post[\s-]*mortem\s+(?:report|examination)|wound\s+certificate|medico[\s-]*legal\s+(?:certificate|report)/i,
    text: [/post[\s-]*mortem/i, /medico[\s-]*legal/i, /wound\s+certificate|injury\s+report/i, /cause\s+of\s+death/i, /\bM\.?L\.?C\.?\b/],
  },
  {
    kind: "forensic",
    name: /\bfsl\b|forensic|ballistic|dna[\s_-]*report/i,
    text: [/forensic\s+science/i, /\bF\.?S\.?L\.?\b/, /ballistic|DNA\s+(?:profil|report|analysis)/i, /report\s+of\s+(?:the\s+)?(?:chemical|serolog)/i],
  },
  {
    kind: "panchnama",
    name: /panch[\s_-]*nama|seizure|mahazar|recovery[\s_-]*memo/i,
    text: [/panch(?:a)?nama/i, /seizure\s+(?:memo|list)|memo\s+of\s+seizure/i, /mahazar/i, /recovery\s+memo|discovery\s+(?:panchnama|statement)/i],
  },
  {
    kind: "bail_application",
    name: /\bbail\b|anticipatory/i,
    text: [/bail\s+application/i, /application\s+for\s+(?:regular\s+|anticipatory\s+|interim\s+)?bail/i, /anticipatory\s+bail/i, /section\s+(?:437|438|439|480|482|483)\b.{0,60}(?:cr\.?p\.?c|bnss)/i, /\bB\.?A\.?\s*(?:no|number)\b/i],
  },
  {
    kind: "remand",
    name: /remand/i,
    text: [/remand\s+(?:application|report|order)/i, /police\s+custody|judicial\s+custody/i, /produced\s+before\s+(?:the\s+)?(?:learned\s+)?(?:magistrate|court)/i],
  },
  {
    kind: "complaint",
    name: /complaint/i,
    text: [/\bcomplaint\s+(?:under|case|no|before)/i, /memo\s+of\s+complaint|criminal\s+complaint/i, /\bC\.?C\.?\s*(?:no|number)\b/i],
  },
  {
    kind: "notice",
    name: /notice|demand[\s_-]*letter/i,
    text: [/legal\s+notice|statutory\s+notice|demand\s+notice/i, /notice\s+under\s+section\s+\d+/i, /\bhereby\s+(?:call\s+upon|demand|give\s+(?:you\s+)?notice)/i],
  },
  {
    kind: "affidavit",
    name: /affidavit/i,
    text: [/\baffidavit\b/i, /solemnly\s+(?:affirm|state)|do\s+hereby\s+(?:solemnly\s+)?(?:affirm|swear|state\s+on\s+oath)/i, /deponent/i],
  },
  {
    kind: "judgment",
    name: /judg(?:e)?ment/i,
    text: [/\bjudg(?:e)?ment\b/i, /(?:convicted|acquitted)\s+(?:of|under)/i, /we\s+(?:allow|dismiss)\s+(?:the\s+)?(?:appeal|petition)/i, /\bINSC\b|\bS\.?C\.?R\.?\b/],
  },
  {
    kind: "order",
    name: /\border\b|orders?[\s_-]*sheet|daily[\s_-]*order/i,
    text: [/\border\s+(?:dated|sheet)/i, /\bit\s+is\s+(?:hereby\s+)?ordered\b/i, /^\s*ORDER\s*$/m, /heard\s+(?:the\s+)?(?:learned\s+)?(?:counsel|advocate)/i, /next\s+date\s+of\s+hearing|posted\s+to|adjourned\s+to/i],
  },
];

export interface Classification {
  kind: DocKind;
  label: string;
  /** How many independent signs agreed. 0 for "other". */
  score: number;
}

const HEAD_CHARS = 4000;

/** Guesses the document type from its file name and the first pages of text. */
export function classifyDocument(name: string, text: string): Classification {
  const head = text.slice(0, HEAD_CHARS);
  let best: { kind: DocKind; score: number } = { kind: "other", score: 0 };
  for (const rule of rules) {
    let score = rule.name.test(name) ? 2 : 0;
    if (rule.strong?.test(head)) score += 2;
    for (const re of rule.text) if (re.test(head)) score++;
    // The earlier rule wins a tie: the record of events outranks the paperwork about it.
    if (score > best.score) best = { kind: rule.kind, score };
  }
  // One weak sign in the text alone is not enough to call it.
  if (best.score < 2) return { kind: "other", label: DOC_KIND_LABEL.other, score: 0 };
  return { kind: best.kind, label: DOC_KIND_LABEL[best.kind], score: best.score };
}

/** A fingerprint of a document's words, blind to case, spacing and punctuation, so a re-saved copy still matches. A fresh scan is read differently by OCR and will not. */
export function contentFingerprint(pages: string[]): string | null {
  const words = pages
    .join(" ")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (words.length < 30) return null; // too short to say two files are the same
  return createHash("sha256").update(words.join(" ")).digest("hex").slice(0, 32);
}
