/**
 * Interactive clarifying questions. When a missing fact would change the advice or the draft, the agent asks the
 * user instead of guessing. The model that answers is small and does not reliably follow a "ask with a card" style
 * rule, so asking is its own short step before the answer: one JSON-only call that decides whether something
 * essential is missing. If so, the reply is a fenced `ask` block (JSON) that the app shows as a card the user
 * answers with a click; the choices come back as an ordinary message. The block is plain text in the saved
 * message, so no database change is needed.
 */
import { getLlmClient } from "./client.js";
import { llmModel } from "./providers.js";
import type { ChatTurn } from "./context-budget.js";

/** Marker the user's reply starts with when it answers a card (the app writes it, see the front end's clarify.ts). */
export const ANSWERS_PREFIX = "Here are my answers";

/** Added when the user's last message answers a card: it must be used, not followed by another round of questions. */
export const CLARIFY_ANSWERED = `The user's message answers the questions you just asked. Use those answers and give the full answer or draft now. Do NOT ask for more details, do NOT say you cannot proceed, and do NOT ask the user to run a search or share a section. A draft does not need a retrieved source to exist: write it in the standard Indian format, and cite only the provisions that appear in the sources above (for a breach of contract, for example, Sections 73 and 74 of the Indian Contract Act when they are listed). Where a fact is still unknown, write the draft anyway with a clear placeholder such as [AMOUNT], [DATE] or [NAME OF RECIPIENT], and list at the end what the user should fill in.`;

export function isAnswersMessage(text: string): boolean {
  return text.trimStart().startsWith(ANSWERS_PREFIX);
}

/** Whether an answer is (or contains) a question card, so it is not treated as finished work. */
export function hasAskBlock(text: string): boolean {
  return /```ask\b/.test(text);
}

const DECIDE_PROMPT = `You decide whether a legal assistant must ask the user something before it can help well.
Reply with ONLY a JSON object, no other text.

If the request can be answered usefully now (a general question, an explanation, a question about the law, or the needed facts are already given in the request, the matter details or the earlier chat), reply: {"ask":false}
If an essential fact is missing that would change the advice or the document (for example: what the matter is about, which side the user is on, which court, key dates, amounts, the outcome wanted), reply:
{"ask":true,"intro":"one short sentence on why you need this","questions":[{"header":"1-2 words","question":"a clear question","options":[{"label":"short answer","description":"optional one line"}],"multiSelect":false}]}

Rules: ask everything essential in this one card so the user is never asked twice: 2 or 3 questions whenever several facts are missing (for a document: what it is about, who it is to or from, and the outcome or amount wanted), 1 only if just one thing is missing. Most important first. Each question has 2 to 4 realistic options that fit this user's request ("multiSelect" true only when several can apply together). Do not add an "Other" option: the user can type their own answer. Never ask what is already stated.

Example. User: "Draft a legal notice for me." Reply:
{"ask":true,"intro":"I need three details to draft this properly.","questions":[{"header":"Dispute","question":"What is the notice about?","options":[{"label":"Unpaid money","description":"A debt, invoice or cheque"},{"label":"Breach of contract"},{"label":"Property or tenancy"},{"label":"Something else"}]},{"header":"Your role","question":"Who is sending the notice?","options":[{"label":"I am, as the claimant"},{"label":"My client is"}]},{"header":"Demand","question":"What should the other side do?","options":[{"label":"Pay a sum of money"},{"label":"Stop an act or vacate"},{"label":"Perform the contract"}]}]}

Example. User: "Prepare a bail strategy for my client." Reply:
{"ask":true,"intro":"Two quick details will shape the strategy.","questions":[{"header":"Stage","question":"Where is the case right now?","options":[{"label":"Just arrested"},{"label":"In police or judicial custody"},{"label":"Chargesheet filed"},{"label":"Bail already refused once"}]},{"header":"Charge","question":"What kind of offence is it?","options":[{"label":"Serious or violent"},{"label":"Financial or cheating"},{"label":"Minor or bailable"}]}]}

Never ask the user to share, upload, send or paste a document, file, report or the text of a law, and never ask a yes or no question about whether they can. Ask about the situation and what they want.

Write questions in plain words a client would understand: ask about the facts and what the user wants, never which statute or section applies. Do not ask for exact names, addresses or amounts: the draft will carry placeholders for those.`;

/** Requests that ask the assistant to produce or plan something are the ones that can lack facts. */
// Only asking verbs count: a question that merely mentions a notice, a complaint or a contract ("what is the notice period?",
// "limitation for a Section 138 complaint?") needs no questions back, and the check costs a model call and several seconds.
const TASKY = /\b(draft|prepare|write|compose|frame|file|filing|help me|need (?:a|an|to|help)|want (?:a|an|to)|make (?:a|an)|create|advise me|represent|handle my|take on my|sue|reply to|respond to|plan|strategy)\b/i;
/** A question about the law, not a request for work. */
const ASKS_A_QUESTION = /^\s*(?:what|why|how|when|who|which|is|are|does|do|explain|tell me|define|difference)\b/i;

const clip = (value: unknown, max: number) => (typeof value === "string" ? value.trim().slice(0, max) : "");

interface Card {
  header: string;
  question: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect: boolean;
}

function cleanCards(raw: unknown): Card[] {
  if (!Array.isArray(raw)) return [];
  const cards: Card[] = [];
  for (const item of raw.slice(0, 3)) {
    const q = item as Record<string, unknown>;
    const question = clip(q?.question, 300);
    const options = (Array.isArray(q?.options) ? q.options : [])
      .map((o) => {
        const opt = (typeof o === "string" ? { label: o } : o) as Record<string, unknown>;
        const label = clip(opt?.label, 80);
        const description = clip(opt?.description, 160);
        return label && !/^(other\b|something else|anything else|none of the above)/i.test(label) ? { label, ...(description ? { description } : {}) } : null;
      })
      .filter((o): o is { label: string; description?: string } => o !== null)
      .slice(0, 4);
    if (!question || options.length < 2) continue;
    // A request to hand over a file or text is not a choice the user can click, and the app has no use for it here.
    if (/\b(share|upload|send|paste|attach|provide|submit)\b[^?]{0,60}\b(document|report|chargesheet|charge sheet|file|copy|text|fir|judgment|order)\b/i.test(question)) continue;
    cards.push({ header: clip(q?.header, 24) || "Question", question, options, multiSelect: q?.multiSelect === true });
  }
  return cards;
}

/**
 * Returns the text of a question-card message when the user's request lacks something essential, otherwise null
 * (answer normally). Any failure, a slow model or a reply that is not valid JSON also gives null: asking is a
 * convenience and must never hold an answer back.
 */
export async function decideClarify(input: {
  userText: string;
  history: ChatTurn[];
  hasAttachments: boolean;
  matterBrief?: string;
  signal?: AbortSignal;
}): Promise<string | null> {
  const { userText, history, hasAttachments, matterBrief, signal } = input;
  if (hasAttachments || isAnswersMessage(userText)) return null;
  if (userText.length > 600 || !TASKY.test(userText)) return null;
  if (ASKS_A_QUESTION.test(userText) && !/\b(draft|prepare|write|compose|create)\b/i.test(userText)) return null;
  // Never two rounds in a row: after a card, a free-text reply is taken as the answer.
  const lastAssistant = [...history].reverse().find((t) => t.role === "assistant");
  if (lastAssistant && hasAskBlock(lastAssistant.content)) return null;

  const recent = history
    .slice(-4)
    .map((t) => `${t.role === "assistant" ? "Assistant" : "User"}: ${t.content.slice(0, 400)}`)
    .join("\n");
  const context = [matterBrief ? `Matter details:\n${matterBrief}` : "", recent ? `Earlier in this chat:\n${recent}` : ""].filter(Boolean).join("\n\n");

  try {
    const response = await getLlmClient().chat.completions.create(
      {
        model: llmModel(),
        messages: [
          { role: "system", content: DECIDE_PROMPT },
          { role: "user", content: `${context ? `${context}\n\n` : ""}The user's new message:\n${userText}` },
        ],
        temperature: 0.2,
        max_tokens: 600,
      },
      { signal, timeout: 45000 },
    );
    const raw = response.choices[0]?.message?.content ?? "";
    const json = /\{[\s\S]*\}/.exec(raw)?.[0];
    if (!json) {
      console.log("[Clarify] no JSON in the model's reply; answering normally");
      return null;
    }
    const parsed = JSON.parse(json) as { ask?: unknown; intro?: unknown; questions?: unknown };
    console.log(`[Clarify] ask=${parsed.ask === true}`);
    if (parsed.ask !== true) return null;
    const cards = cleanCards(parsed.questions);
    if (cards.length === 0) return null;
    const intro = clip(parsed.intro, 240) || "I need a few details before I can do this properly.";
    return `${intro}\n\n\`\`\`ask\n${JSON.stringify({ questions: cards })}\n\`\`\``;
  } catch (err) {
    console.log("[Clarify] check failed; answering normally:", err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * The task the model (and the legal search) sees for an answer to a card: the original request plus the user's
 * choices as plain facts, with an instruction to go ahead. The raw "Here are my answers: 1. ... -> ..." text reads
 * like a reply, not a request, and the small model answered it with "share the section first".
 */
export function withAnsweredNote(userText: string, original?: string): string {
  const facts = userText
    .split("\n")
    .map((l) => /^\d+\.\s+(.*?)\s→\s(.*)$/.exec(l.trim()))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => `- ${m[1]} ${m[2]}`);
  const head = original?.trim() ? `${original.trim()}\n\n` : "";
  const body = facts.length ? `Facts I have given you:\n${facts.join("\n")}` : userText;
  return `${head}${body}\n\n(Write the full answer or draft now. Do not ask me for more details or for a section or search first, and do not say you cannot proceed: write it in the standard Indian format and cite only provisions from the sources you were given. Where something is unknown, put a placeholder such as [AMOUNT], [DATE] or [NAME OF RECIPIENT] and list at the end what I should fill in.)`;
}

/** A card the agent asked, as one plain line, for the history the answering model reads (it should not see raw JSON). */
export function plainAsk(text: string): string {
  return text.replace(/```ask[^\S\n]*\n?([\s\S]*?)```/g, (_, body: string) => {
    try {
      const qs = (JSON.parse(body.trim()) as { questions?: Array<{ question?: string }> }).questions ?? [];
      return `(I asked the user: ${qs.map((q) => q.question).filter(Boolean).join(" ")})`;
    } catch {
      return "";
    }
  });
}
