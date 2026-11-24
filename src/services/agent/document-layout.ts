/**
 * What a finished draft is called and how it is laid out, decided by plain rules after the model has written it.
 * The small model writes a petition as a block of text with a cut-off court heading for a title; neither is trusted.
 */
import { titleOf, type OutputMode } from "./output-mode.js";

// ---------------- A proper title ----------------

/** What a lawyer would call the paper. First match wins, so the specific kinds come before the general ones. */
const KINDS: Array<[RegExp, string]> = [
  [/anticipatory\s+bail|pre[\s-]*arrest\s+bail|section\s+(?:438|482)\b/i, "Application for Anticipatory Bail"],
  [/\bbail\b/i, "Application for Regular Bail"],
  [/habeas\s+corpus/i, "Writ Petition (Habeas Corpus)"],
  [/\bquash(?:ing)?\b|section\s+528\b/i, "Petition to Quash Proceedings"],
  [/\bwrit\b/i, "Writ Petition"],
  [/reply\s+(?:to\s+)?(?:the\s+)?(?:legal\s+|demand\s+)?notice|notice\s+reply/i, "Reply to Legal Notice"],
  [/demand\s+notice|legal\s+notice|\bnotice\b/i, "Legal Notice"],
  [/written\s+statement/i, "Written Statement"],
  [/\bplaint\b/i, "Plaint"],
  [/\baffidavit\b/i, "Affidavit"],
  [/\brejoinder\b/i, "Rejoinder"],
  [/\bcomplaint\b/i, "Complaint"],
  [/\brevision\b/i, "Criminal Revision Petition"],
  [/\bappeal\b/i, "Appeal Memorandum"],
  [/vakalatnama/i, "Vakalatnama"],
  [/power\s+of\s+attorney/i, "Power of Attorney"],
  [/settlement/i, "Settlement Agreement"],
  [/\bagreement\b|\bcontract\b|\bdeed\b/i, "Agreement"],
  [/\bsynopsis\b/i, "Synopsis and List of Dates"],
  [/\bsubmissions?\b|\barguments?\b/i, "Written Submissions"],
  [/\bopinion\b/i, "Legal Opinion"],
  [/\bpetition\b/i, "Petition"],
  [/\bapplication\b/i, "Application"],
];

const PLAN_KINDS: Array<[RegExp, string]> = [
  [/bail/i, "Bail Strategy"],
  [/\bstrateg/i, "Case Strategy"],
  [/\bchecklist\b/i, "Checklist"],
  [/\btimeline\b|\bschedule\b/i, "Case Timeline"],
];

/** A court heading, a placeholder, a cut-off fragment or a sentence is never a good title. */
export function badTitle(t: string): boolean {
  const s = t.trim();
  return (
    !s ||
    s.length > 80 ||
    /\[|\]|\.\.\.$|…$/.test(s) ||
    /^(?:in the (?:court|hon)|before|between|to,|from:|date:|ref|sub:|by (?:registered|speed|hand))/i.test(s) ||
    s.split(/\s+/).length > 14
  );
}

/** The matter's name, short enough to sit after the kind of paper. */
function shortMatter(title: string | null | undefined): string {
  const t = (title ?? "").replace(/^sample matter:\s*/i, "").replace(/\s+/g, " ").trim();
  return t.length > 48 ? `${t.slice(0, 45).trimEnd()}...` : t;
}

/**
 * The name shown on the card, in the library and on the download: what the paper is and which matter it belongs to
 * ("Application for Regular Bail: Sharma Traders v. Kapoor"). A sound "# " heading the model wrote is kept; the request
 * decides next; the document's own opening decides last; it is never the opening words of the text.
 */
export function documentTitle(input: { content: string; mode: OutputMode; request?: string; matterTitle?: string | null }): string {
  const { content, mode } = input;
  const heading = /^#{1,3}\s+(.+)$/m.exec(content)?.[1]?.replace(/[*_`#]/g, "").replace(/\s+/g, " ").trim();
  if (heading && !badTitle(heading)) return heading;

  const matter = shortMatter(input.matterTitle);
  const table = mode === "plan" ? PLAN_KINDS : KINDS;
  const head = content.split("\n").slice(0, 30).join(" ").slice(0, 1500);
  const kind = table.find(([re]) => re.test(input.request ?? ""))?.[1] ?? table.find(([re]) => re.test(head))?.[1] ?? (mode === "plan" ? "Case Plan" : null);
  if (kind) return matter ? `${kind}: ${matter}` : kind;

  const legacy = titleOf(content, mode);
  if (!badTitle(legacy)) return legacy;
  return matter ? `Legal document: ${matter}` : "Legal document";
}

// ---------------- Layout ----------------

const LABEL_NAMES = "Grounds|Prayers?|Facts of the Case|Facts|Synopsis|List of Dates|Verification";
/** Section labels a petition runs together on one line when the model forgets its line breaks. */
const LABELS = new RegExp(`\\s+(?=(?:${LABEL_NAMES}|Respectfully submitted|Place|Date|Advocate for the (?:Petitioner|Applicant|Accused))\\s*:)`, "g");
const LABEL_START = new RegExp(`^(${LABEL_NAMES})\\s*:\\s*`, "i");

/** Splits "Grounds: 1. First. 2. Second. 3. Third" into one numbered paragraph per line, when the numbers really run 1, 2, 3. */
function splitNumbered(line: string): string[] {
  const parts = line.split(/(?<=[.;:!?)\]])\s+(?=\d{1,2}[.)]\s+\S)/);
  const first = /^(.*?[:.])\s+(1[.)]\s+\S[\s\S]*)$/.exec(parts[0]);
  if (first) parts.splice(0, 1, first[1], first[2]);
  const nums = parts.map((p) => /^(\d{1,2})[.)]\s/.exec(p)?.[1]).filter((n): n is string => n !== undefined).map(Number);
  const sequential = nums.length >= 2 && nums.every((n, i) => n === i + 1);
  return sequential ? parts : [line];
}

/**
 * Puts a document's paragraphs back. The editor and the preview read Markdown, where one line break inside a paragraph is
 * not a break, so a draft written line by line ran together into a single block. Every line becomes its own paragraph;
 * table rows and bullet lists stay together; headings and rules are left alone; section labels and numbered paragraphs that
 * were run together on one line are pulled apart and the labels made bold.
 */
export function tidyDocument(text: string): string {
  const out: string[] = [];
  const blank = () => {
    if (out.length && out[out.length - 1] !== "") out.push("");
  };
  /** A bullet and a table row each stay with their own kind, and a table never joins a list. */
  const listKind = (l: string) => (/^\s*\|/.test(l) ? "table" : /^\s*[-*+]\s+/.test(l) ? "bullet" : null);
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let inFence = false;

  for (const raw of lines) {
    const line = raw.replace(/[ \t]+$/g, "");
    if (/^```/.test(line.trim())) {
      inFence = !inFence;
      blank();
      out.push(line);
      if (!inFence) blank();
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }
    if (!line.trim()) {
      blank();
      continue;
    }
    if (/^#{1,6}\s/.test(line) || /^-{3,}$/.test(line.trim())) {
      blank();
      out.push(line);
      blank();
      continue;
    }
    // Consecutive list items and table rows stay together.
    const prev = out[out.length - 1];
    if (listKind(line) && prev !== undefined && prev !== "" && listKind(line) === listKind(prev)) {
      out.push(line);
      continue;
    }
    const pieces = line.length > 400 ? line.replace(LABELS, "\n").split("\n").flatMap((p) => (p.length > 250 ? splitNumbered(p) : [p])) : [line];
    for (const piece of pieces) {
      blank();
      out.push(piece.replace(LABEL_START, (_m, label: string) => `**${label}:** `));
    }
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
