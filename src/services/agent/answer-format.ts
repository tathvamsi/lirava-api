/**
 * The shape every answer to a question is written in: a bottom line first, the answer, what the sources leave open (gaps),
 * and one next move when there is one. The web app reads these labelled paragraphs and shows them as blocks (the front end's
 * lib/answerFormat.ts holds the reader; keep the labels in step). They are plain text in the saved message, so no database change is
 * needed, and an answer that ignores the format is still readable and is shown as written.
 *
 * The model that answers is small and does not follow long rules reliably, so this is short and has one example.
 */
import type { OutputMode } from "./output-mode.js";

export const ANSWER_FORMAT = `ANSWER FORMAT. Write every answer to a question in this shape. Use these exact English labels, each starting its own paragraph, even when the answer is in another language:

Bottom line: one or two sentences giving the direct answer, with the source label such as [D1] or [S1] after any point a source supports. Start the answer with this and nothing else.

Then the answer itself, as short as the question allows (a lookup needs a few lines, a legal analysis can run longer). Do not repeat the bottom line.

Gaps: only when the sources above leave something relevant to this question open, for example a stage, date, order or document that is not in them, or when the sources do not really cover what was asked and you are answering from general knowledge. Say what is missing. Never fill a gap from memory and never invent one. If there is no gap, leave Gaps out: do not write "none".

Next move: only when one concrete action follows: say what, who does it and by when if known. If there is no clear next step, leave Next move out: do not write "None".

Example:
Bottom line: The FIR was registered on 16 August 2025 under BNSS section 173 [D1].

The informant is the wife of the deceased and names one accused [D1].

Gaps: No charge-sheet or bail order is in the documents.

Next move: Ask the investigating officer for the case diary.

Do not use this format for a greeting, thanks, or a question you are asking the user.`;

/** The instruction to add to the prompt, or null when the answer is a document or plan (those are saved as work, not read as an answer). */
export function answerFormatSection(outputMode: OutputMode | null): string | null {
  return outputMode ? null : ANSWER_FORMAT;
}
