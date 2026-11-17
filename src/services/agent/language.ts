/**
 * The language a lawyer wants a document written in. Lawyers in Karnataka, Tamil Nadu, Andhra Pradesh and Telangana,
 * Maharashtra and the Hindi belt often file in the court's language, so the assistant must not assume English.
 *
 * The rule is: when the user asks for a document (to be written, drafted, translated or rewritten) and has neither
 * named a language in the message nor saved a default, ask once before writing anything.
 */

export const DOCUMENT_LANGUAGES = {
  en: { name: "English", native: "English" },
  hi: { name: "Hindi", native: "हिन्दी" },
  kn: { name: "Kannada", native: "ಕನ್ನಡ" },
  ta: { name: "Tamil", native: "தமிழ்" },
  te: { name: "Telugu", native: "తెలుగు" },
  mr: { name: "Marathi", native: "मराठी" },
} as const;

export type DocumentLanguage = keyof typeof DOCUMENT_LANGUAGES;

export const isDocumentLanguage = (v: unknown): v is DocumentLanguage => typeof v === "string" && Object.hasOwn(DOCUMENT_LANGUAGES, v);

const OPTIONS = Object.values(DOCUMENT_LANGUAGES)
  .map((l) => `${l.name} (${l.native})`)
  .join(", ");

/** What stays in English or Latin letters whatever the language, so that it can be checked against the library. */
const KEEP_CHECKABLE =
  'Whatever the language, write every case citation exactly as printed in the sources (for example "2023 INSC 1043" or "[2023] 16 S.C.R. 872"), and write section numbers with the Act, using the Act\'s English name or short form (for example "Section 103 BNS"), so that they can be checked. Do not translate or transliterate a citation. Case names may be written in the document\'s language with the English name in brackets the first time.';

const TRANSLATION_NOTE =
  "If you translate a passage of a statute or judgment, say that it is an unofficial translation and that the English text governs. Do not present your own translation as the Court's or the Government's.";

/**
 * The prompt section that carries the language rule. `saved` is the user's saved default, if any.
 * Always present, because the "ask first" rule is what applies when nothing is saved.
 */
export function languageSection(saved: unknown): string {
  if (isDocumentLanguage(saved)) {
    const l = DOCUMENT_LANGUAGES[saved];
    return [
      `DOCUMENT LANGUAGE: the user's saved language for documents is ${l.name} (${l.native}).`,
      `When you write, draft, translate or rewrite a document, use ${l.name} unless the user's message names a different language; if it does, use that language for this document only.`,
      "Ordinary questions are answered in the language the user wrote in.",
      KEEP_CHECKABLE,
      TRANSLATION_NOTE,
    ].join("\n");
  }
  return [
    "DOCUMENT LANGUAGE: the user has not said which language they want documents in.",
    `When the user asks you to write, draft, prepare, translate or rewrite a document (a petition, notice, reply, affidavit, application, agreement, a summary for a client, or a selected document from the case file) and the message does not name a language, do not start writing. Ask one short question first, and nothing else: "Which language should I write this in? ${OPTIONS}." Then wait for the answer.`,
    'A message that names a language (for example "draft a bail application in Kannada") already answers the question: do not ask, and write in that language.',
    "This question is only for documents. Ordinary legal questions are answered at once, in the language the user wrote in.",
    KEEP_CHECKABLE,
    TRANSLATION_NOTE,
  ].join("\n");
}
