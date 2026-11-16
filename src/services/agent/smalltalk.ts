/**
 * Everyday messages that are not legal questions: greetings, "what is your name?", thanks, "what can you do?".
 *
 * They get a fixed reply (or, for "what can you do?", an answer with no statute search), so a casual message
 * never costs a model call, never gets a statute attached as a "source", and never gets a half-matching reply.
 * Anything that is not clearly one of these goes to the model as usual.
 */

export type SmallTalk = "greeting" | "identity" | "thanks" | "capability";

// A greeting at the start ("Hello, ...") is allowed in front of the real message.
const LEADING_GREETING = /^(hi|hello|hey|hii+|namaste|namaskar|greetings|good\s+(morning|afternoon|evening))\b[\s,.!:-]*/i;
const TRAILING = String.raw`[\s?.!]*$`;

const IDENTITY = new RegExp(
  String.raw`^(what(?:'s|\s+is|s)?\s+your\s+name|who\s+are\s+you|what\s+are\s+you|what\s+should\s+i\s+call\s+you|tell\s+me\s+your\s+name|your\s+name|(?:may|can)\s+i\s+know\s+your\s+name|what\s+do\s+(?:i|we)\s+call\s+you|are\s+you\s+(?:a\s+)?(?:bot|ai|human|robot|lirava))${TRAILING}`,
  "i",
);
const THANKS = new RegExp(String.raw`^(?:ok(?:ay)?[\s,]+)?(?:thanks|thank\s+you(?:\s+so\s+much|\s+very\s+much)?|thanks\s+a\s+lot|thx|ty|many\s+thanks)(?:[\s,]+lirava)?${TRAILING}`, "i");
const CAPABILITY = new RegExp(
  String.raw`^(what\s+can\s+you\s+do|what\s+do\s+you\s+do|what\s+are\s+you\s+(?:good|best)\s+(?:at|with|for)|how\s+can\s+you\s+help(?:\s+me)?|what\s+can\s+you\s+help\s+(?:me\s+)?with|help|what\s+are\s+your\s+(?:features|capabilities))${TRAILING}`,
  "i",
);

export function classifySmallTalk(text: string): SmallTalk | null {
  const raw = text.trim();
  if (!raw || raw.length > 80) return null;
  const rest = raw.replace(LEADING_GREETING, "").trim();
  if (rest === "" || /^[.!?]*$/.test(rest)) return LEADING_GREETING.test(raw) ? "greeting" : null;
  if (IDENTITY.test(rest)) return "identity";
  if (THANKS.test(rest)) return "thanks";
  if (CAPABILITY.test(rest)) return "capability";
  return null;
}

/** The fixed reply, or null when the message should go to the model. */
export function smallTalkReply(kind: SmallTalk | null): string | null {
  switch (kind) {
    case "greeting":
      return "Hello. I'm Lirava. How can I help with your legal matter today?";
    case "identity":
      return "I'm Lirava, an AI research assistant for Indian lawyers. I can look up statutes and case law, read your documents, and help you prepare notices, petitions and other drafts. What would you like to work on?";
    case "thanks":
      return "You're welcome. Tell me if there is anything else you need on this matter.";
    default:
      return null;
  }
}
