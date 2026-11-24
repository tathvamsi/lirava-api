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

const LANGUAGE_QUESTION = /which language should i write this in\?/i;

/** How each language is named in a short reply (English name, native name, and the common alternate spellings). */
const LANGUAGE_WORDS: Array<[DocumentLanguage, RegExp]> = [
  ["en", /\benglish\b|अंग्रेज़ी|अंग्रेजी|ಇಂಗ್ಲಿಷ್|இங்கிலீஷ்|ஆங்கிலம்|ఇంగ్లీష్|इंग्रजी/i],
  ["hi", /\bhindi\b|हिन्दी|हिंदी|ಹಿಂದಿ/i],
  ["kn", /\bkannada\b|ಕನ್ನಡ|कन्नड/i],
  ["ta", /\btamil\b|தமிழ்|तमिळ|तमिल/i],
  ["te", /\btelugu\b|తెలుగు|तेलुगू/i],
  ["mr", /\bmarathi\b|मराठी/i],
];

/** The language a piece of text asks for, by its English or native name, or null when it names none. */
export function detectLanguage(text: string): DocumentLanguage | null {
  return LANGUAGE_WORDS.find(([, re]) => re.test(text))?.[0] ?? null;
}

export interface LanguageAnswer {
  language: DocumentLanguage;
  /** The document request the question was about. */
  original: string;
}

/**
 * When the assistant has just asked "Which language should I write this in?" and the user's short reply names a language,
 * returns the language and the request it belongs to, so the reply is read as "go ahead" and not as a new, empty message.
 * A long reply is a new request, not an answer, and returns null.
 */
export function languageAnswer(userText: string, history: Array<{ role: string; content: string }>): LanguageAnswer | null {
  if (userText.trim().length === 0 || userText.length > 80) return null;
  const lastAssistant = history.map((t, i) => ({ t, i })).reverse().find((x) => x.t.role === "assistant");
  if (!lastAssistant || !LANGUAGE_QUESTION.test(lastAssistant.t.content)) return null;
  const found = LANGUAGE_WORDS.find(([, re]) => re.test(userText));
  if (!found) return null;
  const request = history.slice(0, lastAssistant.i).reverse().find((t) => t.role === "user");
  if (!request?.content.trim()) return null;
  return { language: found[0], original: request.content.trim() };
}

/** The task the model works from after a language answer: the original request, the language, and an instruction to write now. */
export function languageAnsweredTask(a: LanguageAnswer): string {
  const l = DOCUMENT_LANGUAGES[a.language];
  return `${a.original}\n\nWrite it in ${l.name} (${l.native}).\n\n(Write the full document now. I have answered your language question: do not ask me anything else first. Where a fact is unknown, put a placeholder such as [NAME] or [DATE] and list at the end what I should fill in.)`;
}

/**
 * The prompt section that carries the language rule. `saved` is the user's saved default, if any.
 * Always present, because the "ask first" rule is what applies when nothing is saved.
 */
export function languageSection(saved: unknown, opts: { documentRequest?: boolean } = {}): string {
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
  // The user has not asked for a document: the question is for documents only, and a small model that is told about it
  // will ask it anyway ("What is the IT Act?" answered with "Which language should I write this in?"). So it is not mentioned.
  if (opts.documentRequest === false) {
    return [
      "LANGUAGE: answer in the language the user wrote in. Do not ask which language to use: this is a question, not a request for a document.",
      KEEP_CHECKABLE,
      TRANSLATION_NOTE,
    ].join("\n");
  }
  return [
    "DOCUMENT LANGUAGE: the user has not said which language they want documents in.",
    `When the user asks you to write, draft, prepare, translate or rewrite a document (a petition, notice, reply, affidavit, application, agreement, a summary for a client, or a selected document from the case file) and the message does not name a language, do not start writing. Ask one short question first, and nothing else: "Which language should I write this in? ${OPTIONS}." Then wait for the answer. When the user replies with a language, write the whole document at once in that language: never ask the question again and never ask anything else first.`,
    'A message that names a language (for example "draft a bail application in Kannada") already answers the question: do not ask, and write in that language.',
    "This question is only for documents. Ordinary legal questions are answered at once, in the language the user wrote in.",
    KEEP_CHECKABLE,
    TRANSLATION_NOTE,
  ].join("\n");
}
