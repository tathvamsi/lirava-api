/**
 * What the user sees when the AI model cannot be reached or gives no answer. It says so and nothing else: no canned legal text,
 * so nothing that looks like advice, and nothing a document could be built from.
 */
export const MODEL_UNAVAILABLE_MESSAGE =
  "**The AI model is not available right now, so I could not answer this.** Nothing has been written for your question, and no legal text has been substituted for it. Your message is saved in this chat. Please try again in a few minutes.";

/** Older chats hold the previous canned fallback; this is its start, so it can still be recognised and left out of summaries. */
/** Shown ahead of any answer produced without the AI model, so a canned reference is never mistaken for AI analysis of the user's question. */
export const OFFLINE_NOTICE =
  "> **The AI model is not available right now.** The text below is a general reference summary from Lirava's built-in statute library. It is not an analysis of your specific question. Please verify against the bare Act before relying on it.\n\n";
