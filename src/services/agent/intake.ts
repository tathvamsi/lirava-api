/**
 * What a lawyer must have in hand before a bail petition can be drafted: who it is for, which court, what the case is,
 * and the arrest and custody position. The list is fixed, not invented by the model. It is checked against what the
 * matter, the case file and the request already say, and only what is missing is asked, in one message. The reply
 * is carried back to the original request so the draft is written at once; anything still unknown becomes a placeholder.
 */
import { classifyOutput } from "./output-mode.js";
import { withEnglishHints } from "../legal/indic-terms.js";
import { DOCUMENT_LANGUAGES, detectLanguage, isDocumentLanguage, type DocumentLanguage } from "./language.js";
import type { CaseFileContent } from "../casefile/extract.js";

export type IntakeKind = "bail" | "anticipatory_bail";

export interface IntakeMatter {
  title: string;
  client: string;
  court: string;
  notes: string;
  intake: { brief?: string; caseType?: string; oppositeParty?: string; outcome?: string; keyDates?: Array<{ label: string; date: string }> } | null;
}

export interface IntakeContext {
  request: string;
  /** Earlier turns of this chat, oldest first. */
  history: Array<{ role: string; content: string }>;
  matter: IntakeMatter | null;
  caseFile: CaseFileContent | null;
  /** The user's saved document language, if any. */
  savedLanguage?: unknown;
}

interface Field {
  id: "accused" | "court" | "case" | "custody" | "language";
  /** What to ask for, in the words a lawyer would use. */
  ask: string;
}

export interface IntakePlan {
  kind: IntakeKind;
  /** What the file already gives, as short lines to show the lawyer and to put in the draft's task. */
  known: string[];
  missing: Field[];
}

/** Starts every checklist message, and is how the reply to one is recognised. */
export const INTAKE_HEADER = "Before I draft the";
const STILL_HEADER = "I still need these details to draft the";

const FIELD_ASK: Record<Field["id"], string> = {
  accused: "**The accused.** The full name of the person this application is for, as it must appear on the petition (and father's or husband's name and age, if you have them).",
  court: "**The court.** Which court the application goes to (for example: Sessions Court, Bidar; or High Court of Karnataka), and the case or crime number if one exists.",
  case: "**The case.** The FIR number and date, the police station, the sections charged, and in a few lines what the case is about: who is alleged to have done what.",
  custody: "**Arrest and custody.** The date of arrest, whether he or she is still in custody, and whether bail has been refused or sought before.",
  language: `**Language.** Which language the petition should be written in: ${Object.values(DOCUMENT_LANGUAGES).map((l) => l.name).join(", ")}.`,
};

/** A request for a bail petition or application; anything else is left to the ordinary flow. */
export function intakeKindOf(request: string): IntakeKind | null {
  if (classifyOutput(request) !== "document") return null;
  const text = withEnglishHints(request); // a request in Kannada, Hindi, Marathi, Tamil or Telugu is read through its English hints
  if (!/\bbail\b|\banticipatory\b|\bpre[\s-]*arrest\b/i.test(text)) return null;
  return /anticipatory|pre[\s-]*arrest|section\s+(?:438|482)\b/i.test(text) ? "anticipatory_bail" : "bail";
}

const ACCUSED_ROLE = /accused|client|applicant|petitioner|defendant|detenu|detainee/i;
const NAME_IN_TEXT = /\b(?:client|accused|applicant|petitioner)\s*(?:is\s+|named\s+|,\s*)?(?:mr\.?|mrs\.?|ms\.?|shri|smt\.?|sri|kum\.?)?\s*[A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,})?/;
const COURT_IN_TEXT = /\b(?:sessions|high|magistrate|district|special|jmfc|civil|family)\s+court\b|\bcourt\s+of\b|\bhon'?ble\b/i;
const CASE_IN_TEXT = /\bF\.?I\.?R\.?\b.{0,40}\d|\bcrime\s*(?:no|number)\b|\bcr\.?\s*no\b|\bcase\s*no\b|\bunder\s+sections?\s+\d+|\bsections?\s+\d+.{0,30}\b(?:bns|ipc|ndps|pmla|nia|pocso)\b/i;
const CUSTODY_IN_TEXT = /\barrest|\bcustody|\bremand|\bapprehen|\bjail\b|\bdetain/i;

/** What the lawyer has already written in this chat (their own messages, not the assistant's). */
const userWords = (c: IntakeContext) => [...c.history.filter((t) => t.role === "user").map((t) => t.content), c.request].join("\n");

function accusedKnown(c: IntakeContext): string | null {
  if (c.matter?.client?.trim()) return c.matter.client.trim();
  const party = c.caseFile?.parties.find((p) => ACCUSED_ROLE.test(p.role));
  if (party) return `${party.name} (${party.role})`;
  return NAME_IN_TEXT.test(userWords(c)) ? "named in your message" : null;
}

function courtKnown(c: IntakeContext): string | null {
  if (c.matter?.court?.trim()) return c.matter.court.trim();
  return COURT_IN_TEXT.test(userWords(c)) ? "named in your message" : null;
}

function caseKnown(c: IntakeContext): string | null {
  const m = c.matter;
  if (m?.intake?.brief && m.intake.brief.trim().length >= 40) return m.intake.brief.trim().slice(0, 300);
  if (m?.notes && m.notes.trim().length >= 60) return m.notes.trim().slice(0, 300);
  if (c.caseFile && (c.caseFile.facts.length >= 2 || c.caseFile.chronology.length >= 2)) return `${c.caseFile.facts.length} facts and ${c.caseFile.chronology.length} dated events in the case file`;
  return CASE_IN_TEXT.test(userWords(c)) ? "given in your message" : null;
}

function custodyKnown(c: IntakeContext): string | null {
  const dated = c.matter?.intake?.keyDates?.find((d) => CUSTODY_IN_TEXT.test(d.label));
  if (dated) return `${dated.label}: ${dated.date}`;
  const event = c.caseFile?.chronology.find((e) => CUSTODY_IN_TEXT.test(e.what));
  if (event) return `${event.what} (${event.date})`;
  return CUSTODY_IN_TEXT.test(userWords(c)) ? "given in your message" : null;
}

function languageKnown(c: IntakeContext): string | null {
  if (isDocumentLanguage(c.savedLanguage)) return DOCUMENT_LANGUAGES[c.savedLanguage].name;
  const named = detectLanguage(userWords(c));
  return named ? DOCUMENT_LANGUAGES[named].name : null;
}

/** What a bail petition needs, what the file already has, and what is still missing. Null when the request is not for one. */
export function planIntake(c: IntakeContext): IntakePlan | null {
  const kind = intakeKindOf(c.request);
  if (!kind) return null;
  const checks: Array<[Field["id"], string, string | null]> = [
    ["accused", "Accused (the petition is for)", accusedKnown(c)],
    ["court", "Court", courtKnown(c)],
    ["case", "The case", caseKnown(c)],
    ["custody", "Arrest and custody", custodyKnown(c)],
    ["language", "Language", languageKnown(c)],
  ];
  const known = checks.filter(([, , v]) => v).map(([, label, v]) => `${label}: ${v}`);
  const missing = checks.filter(([, , v]) => !v).map(([id]): Field => ({ id, ask: FIELD_ASK[id] }));
  return { kind, known, missing };
}

const KIND_NAME: Record<IntakeKind, string> = { bail: "bail application", anticipatory_bail: "anticipatory bail application" };

/** The single message asking for what is missing. */
export function intakeMessage(plan: IntakePlan, opts: { again?: boolean } = {}): string {
  const lead = opts.again
    ? `${STILL_HEADER} ${KIND_NAME[plan.kind]}. A petition with no name, court or case facts cannot be filed.`
    : `${INTAKE_HEADER} ${KIND_NAME[plan.kind]}, I need a few details that are not in your file yet.`;
  const have = plan.known.length ? `\n\nAlready on your file:\n${plan.known.map((k) => `- ${k}`).join("\n")}` : "";
  const list = plan.missing.map((f, i) => `${i + 1}. ${f.ask}`).join("\n\n");
  return `${lead}${have}\n\nPlease send:\n\n${list}\n\nSend what you have in one message, in any order. Anything you leave out will be a [PLACEHOLDER] in the draft for you to fill.`;
}

export interface IntakeReply {
  kind: IntakeKind;
  /** The request the checklist was about. */
  original: string;
  /** How many checklist messages were sent for it. */
  asked: number;
}

const isChecklist = (t: { role: string; content: string }) => t.role === "assistant" && /Please send:/.test(t.content) && (t.content.includes(INTAKE_HEADER) || t.content.includes(STILL_HEADER));

const requestWords = (s: string) => s.toLowerCase().replace(/[^a-z0-9ऀ-෿\s]/g, " ").split(/\s+/).filter(Boolean).join(" ");

/** True when the reply says too little to be details: a repeat of the request, or a few words. */
export function isThinReply(reply: string, original: string): boolean {
  const r = requestWords(reply);
  return r.length < 25 || r === requestWords(original) || (intakeKindOf(reply) !== null && !/\d/.test(reply) && reply.length < 100);
}

/** If the assistant's last message was the checklist, returns the request it was about and how often it was sent. `current` is the message just received. */
export function intakeReplyTo(history: Array<{ role: string; content: string }>, current?: string): IntakeReply | null {
  const lastAssistant = history.map((t, i) => ({ t, i })).reverse().find((x) => x.t.role === "assistant");
  if (!lastAssistant || !isChecklist(lastAssistant.t)) return null;
  const kind: IntakeKind = /anticipatory bail application/.test(lastAssistant.t.content) ? "anticipatory_bail" : "bail";
  let original: string | null = null;
  let asked = 0;
  for (let i = lastAssistant.i; i >= 0; i--) {
    const t = history[i];
    if (isChecklist(t)) asked++;
    else if (t.role === "user" && intakeKindOf(t.content)) original = t.content.trim();
    else if (t.role === "assistant") break; // an ordinary answer ends the run of checklists
  }
  // The chat history leaves out a question that is repeated word for word, so a lawyer who sends the request again has
  // removed the first copy: the message in hand is then the request.
  if (!original && current && intakeKindOf(current)) original = current.trim();
  return original ? { kind, original, asked } : null;
}

/** The task the model works from: the request, everything known, the lawyer's details, and an order to write it now. */
export function intakeTask(input: { original: string; known: string[]; details?: string; language?: DocumentLanguage | null }): string {
  const parts = [input.original.trim()];
  if (input.known.length) parts.push(`From the case file:\n${input.known.map((k) => `- ${k}`).join("\n")}`);
  if (input.details?.trim()) parts.push(`Details given by the lawyer:\n${input.details.trim()}`);
  if (input.language) parts.push(`Write it in ${DOCUMENT_LANGUAGES[input.language].name} (${DOCUMENT_LANGUAGES[input.language].native}).`);
  parts.push(
    "(Write the full bail application now, in the form filed in an Indian court. Use the name, court, case number, FIR, sections, dates and facts above exactly as given, and write nothing that contradicts them. Where a fact is not given, put a clear [PLACEHOLDER] and list at the end what the lawyer should fill in. Do not ask any question first, and do not state a section or case you were not given.)",
  );
  return parts.join("\n\n");
}

/**
 * What the matter's hand-over form and the case file say, as text for the model: the brief, the other side, the dates,
 * and the parties, dated events and facts read from the documents. Every line is something the lawyer supplied or the
 * documents state; the model is told to use it and not to contradict it.
 */
export function matterFactsBrief(matter: IntakeMatter | null, caseFile: CaseFileContent | null, maxChars = 2200): string {
  const lines: string[] = [];
  const i = matter?.intake;
  if (i?.brief?.trim()) lines.push(`Brief: ${i.brief.trim().slice(0, 600)}`);
  if (i?.caseType?.trim()) lines.push(`Type of case: ${i.caseType.trim()}`);
  if (i?.oppositeParty?.trim()) lines.push(`Other side: ${i.oppositeParty.trim()}`);
  if (i?.outcome?.trim()) lines.push(`Outcome wanted: ${i.outcome.trim()}`);
  for (const d of i?.keyDates?.slice(0, 8) ?? []) lines.push(`Date: ${d.label}: ${d.date}`);
  if (caseFile) {
    for (const p of caseFile.parties.slice(0, 10)) lines.push(`Party: ${p.name} (${p.role})`);
    for (const e of caseFile.chronology.slice(0, 15)) lines.push(`Event ${e.date}: ${e.what}`);
    for (const f of caseFile.facts.slice(0, 12)) lines.push(`Fact: ${f.text}`);
  }
  if (!lines.length) return "";
  const text = lines.join("\n");
  return `FROM THE CASE FILE (the lawyer's own entries and what the documents state; use these exactly):\n${text.length > maxChars ? `${text.slice(0, maxChars)}...` : text}`;
}
