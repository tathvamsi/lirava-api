/**
 * Where a piece of work goes. A plan or strategy opens as an artifact (a structured plan the user can follow and
 * tick off); a notice, draft, petition, agreement or set of arguments opens in the document editor, where the
 * user can change the wording. The choice is made from the request itself with plain rules, because the small
 * model that writes the answer cannot be trusted to choose. A question, an explanation or a chat reply is neither.
 */
import { withEnglishHints } from "../legal/indic-terms.js";

export type OutputMode = "document" | "plan";

/** Things a lawyer files, sends or signs. */
const DOCUMENT_NOUN =
  /\b(legal notice|demand notice|notice|petition|plaint|written statement|affidavit|agreement|contract|deed|memorandum|memo of|application|vakalatnama|power of attorney|undertaking|settlement|complaint|appeal|revision|counter|reply|rejoinder|rebuttal|submissions?|arguments?|synopsis|brief|opinion|letter|draft)\b/i;

/** Things a lawyer plans with. */
const PLAN_NOUN = /\b(plan|strategy|strategies|roadmap|game ?plan|checklist|timeline|action items?|approach|schedule|steps to|way forward|battle plan|case plan)\b/i;

/** A request has to ask for the work to be produced; "what is a notice?" is a question. */
const ASKS_FOR_WORK = /\b(draft|prepare|write|create|make|give me|build|put together|frame|compose|generate|need|want|help me (?:with|draft|write|prepare|plan)|plan|outline|map out|work out|suggest|come up with|set out)\b/i;

const QUESTION_START = /^\s*(what|why|how|when|who|which|is|are|can|does|do|should|explain|tell me|define)\b/i;

export function classifyOutput(request: string): OutputMode | null {
  // A request in Kannada, Hindi, Marathi, Tamil or Telugu is read with the English terms for its legal words added (indic-terms.ts).
  const text = withEnglishHints(request.trim());
  if (text.length < 8 || text.length > 1500) return null;
  if (!ASKS_FOR_WORK.test(text)) return null;
  // "What is a legal notice?" or "Explain the bail strategy" asks for knowledge, not for a piece of work.
  if (QUESTION_START.test(text) && !/\b(draft|prepare|write|create|make|give me|plan)\b/i.test(text)) return null;
  const wantsPlan = PLAN_NOUN.test(text);
  const wantsDocument = DOCUMENT_NOUN.test(text);
  // "A plan to reply to the notice" is a plan; "draft a reply" is a document. The thing asked for is the noun
  // nearest the front, so compare where each kind first appears.
  if (wantsPlan && wantsDocument) {
    const plan = text.search(PLAN_NOUN);
    const doc = text.search(DOCUMENT_NOUN);
    return plan <= doc ? "plan" : "document";
  }
  if (wantsPlan) return "plan";
  if (wantsDocument) return "document";
  return null;
}

/** Added to the answering prompt so the reply has the shape its mode needs. */
export function modeDirective(mode: OutputMode): string {
  if (mode === "plan") {
    return `OUTPUT MODE: PLAN. The user asked for a plan or strategy. It will open in a separate plan panel, so write only the plan, with no greeting and no closing remarks. Start with a single "# " title line, then these "## " sections in order: Objective (one or two sentences), Key facts and issues (short bullets), Strategy (numbered steps; say who does each and by when where known), Risks and how to handle them, Next actions (a checklist, each line written as "- [ ] action"). Keep every bullet to one or two lines.`;
  }
  return `OUTPUT MODE: DOCUMENT. The user asked for a legal document. It will open in a document editor, so write only the document itself, from its own heading to its signature block, with no greeting, no explanation before it and no notes after it. Begin with a "# " title line that names the paper, never the court heading (for example "# Application for Regular Bail" or "# Legal Notice for Recovery of Money"), then the document in full, laid out the way it is filed in an Indian court: the court heading ("IN THE COURT OF ..."), the case number line, the parties ("BETWEEN ... AND ..."), the title of the application with its section, "MOST RESPECTFULLY SHEWETH:", then numbered paragraphs ("1.", "2.", ...), then "PRAYER", then place, date and the advocate's signature block. Put every heading, every numbered paragraph and every prayer on its own line with a blank line between them. Never run several paragraphs together on one line. Use [PLACEHOLDERS] for facts you were not given and never invent a fact, an Act or a section.`;
}

const PREAMBLE = /^(?:I('ll| will| have| am pleased to)|Here is|Here's|Certainly|Sure|Below is|As requested|Please find|Attached is|Understood)/i;
const TRAILING = /^(?:---+\s*)?(?:#{1,4}\s*)?(?:\*\*)?(?:Key Legal Points|Key Points|Notes?|Important Notes?|Filing Instructions|Next Steps|Please note|You can fill in|Please fill|Please ensure|Would you like|Let me know|Feel free|Hope this helps|\[Note)/i;

/** The document or plan alone: no lead-in sentence before it, no chatter after it. */
export function cleanOutput(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let start = 0;
  while (start < lines.length && (!lines[start].trim() || PREAMBLE.test(lines[start].trim()))) start++;
  let end = lines.length;
  // Chatter is trimmed only from the last third, so a "Notes" heading inside the document is left alone.
  const earliest = Math.floor(lines.length * 0.66);
  for (let i = Math.max(start, earliest); i < lines.length; i++) {
    if (TRAILING.test(lines[i].trim())) {
      end = i;
      break;
    }
  }
  const cleaned = lines.slice(start, end).join("\n").trim();
  return cleaned.length >= 100 ? cleaned : text.trim();
}

/** The title of a document or plan: its first heading, else its first line, else a name from the mode. */
export function titleOf(content: string, mode: OutputMode): string {
  const head = content.split("\n").slice(0, 14);
  const heading = /^#{1,3}\s+(.+)$/m.exec(content)?.[1];
  // Without a "# " title, a notice opens with dispatch lines ("BY REGISTERED POST...") before its real heading, so
  // look for the line that names the document, and only then fall back to the first line.
  const named = head.map((l) => l.replace(/[*_`#]/g, "").trim()).find((l) => l.length <= 120 && /\b(notice|petition|application|agreement|affidavit|plaint|deed|reply|memorandum|contract|undertaking|complaint|appeal|opinion|synopsis|strategy|plan)\b/i.test(l) && !/^(by|via|through|to|from|sub|ref)\b/i.test(l));
  const first = named || content.split("\n").find((l) => l.trim())?.trim();
  const raw = (heading || first || (mode === "plan" ? "Plan" : "Legal document")).replace(/[*_`#]/g, "").replace(/\s+/g, " ").trim();
  return raw.length > 90 ? `${raw.slice(0, 87)}...` : raw;
}
