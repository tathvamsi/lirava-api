/**
 * Running summary of a long chat.
 *
 * Only the newest messages fit in the model's window. When the messages that are not yet summarised grow past
 * what fits, the older ones are folded into a short summary (parties, facts, dates, sections discussed) that is
 * saved with the chat and put back in front of the model on every later message. This runs after an answer has
 * been sent, so the user never waits for it, and if it fails the chat simply carries on without it.
 */
import { config } from "../../config.js";
import { OFFLINE_NOTICE } from "../legal/notice.js";
import { getChatSummary, historyAfter, setChatSummary } from "../chats/store.js";
import { getLlmClient } from "./client.js";
import { estimateTokens, shrinkText, type ChatTurn } from "./context-budget.js";

/** A single old message is cut to this many characters before it is used as chat history. */
export const HISTORY_MESSAGE_CHARS = 1500;
/** The newest messages kept word for word (not summarised). */
const KEEP_RECENT_TOKENS = Number(process.env.CHAT_KEEP_RECENT_TOKENS || 1800);
/** Summarise only once this many tokens beyond the kept ones have piled up, so it is not done after every message. */
const FOLD_SLACK_TOKENS = Number(process.env.CHAT_SUMMARY_SLACK_TOKENS || 1200);
export const SUMMARY_MAX_TOKENS = Number(process.env.CHAT_SUMMARY_MAX_TOKENS || 500);

export const SUMMARY_SYSTEM_PROMPT = [
  "You maintain the running summary of a legal consultation between an Indian lawyer and an AI assistant.",
  "Update the summary with the new messages. Keep: the parties and their roles, the court or forum and case numbers, dates and deadlines,",
  "facts the lawyer stated, Acts and sections discussed, what was drafted or decided, and open questions.",
  "Use only what is in the messages. Do not add legal advice or anything new. Write compact plain-text bullet points, at most 250 words.",
  "Return only the updated summary.",
].join(" ");

/** One stored message as a chat turn for the model, or null if it should not be shown to the model at all. */
export function toTurn(m: { role: string; text: string }): ChatTurn | null {
  const text = m.text.replace(/^> ⚖️[\s\S]*?---\n\n/, "").trim();
  if (!text) return null;
  // Stored offline fallbacks and raw clause dumps would teach the model to repeat them.
  if (m.role === "vakil" && (m.text.startsWith(OFFLINE_NOTICE) || m.text.includes('(a) "information"') || m.text.includes("Legal Consultation Brief"))) return null;
  return {
    role: m.role === "vakil" || m.role === "assistant" ? "assistant" : m.role === "user" ? "user" : "system",
    content: text.length > HISTORY_MESSAGE_CHARS ? `${text.slice(0, HISTORY_MESSAGE_CHARS)}...` : text,
  };
}

const folding = new Set<string>();

/** Folds older messages into the chat's summary when enough have piled up. Safe to call after every answer. */
export async function maybeSummarizeChat(conversationId: string, userId: string): Promise<boolean> {
  const key = `${userId}::${conversationId}`;
  if (folding.has(key)) return false;
  folding.add(key);
  try {
    const { summary, upto } = await getChatSummary(conversationId, userId);
    const rows = await historyAfter(conversationId, userId, "", upto, 80);
    const turns = rows
      .map((r) => ({ at: r.createdAt, turn: toTurn(r) }))
      .filter((t): t is { at: number; turn: ChatTurn } => t.turn !== null);
    const cost = (t: { turn: ChatTurn }) => estimateTokens(t.turn.content) + 8;
    const total = turns.reduce((n, t) => n + cost(t), 0);
    if (total <= KEEP_RECENT_TOKENS + FOLD_SLACK_TOKENS) return false;

    // Keep the newest messages as they are (at least the last two); everything before them is folded in.
    let kept = 0;
    let keepFrom = turns.length;
    while (keepFrom > 0 && (kept + cost(turns[keepFrom - 1]) <= KEEP_RECENT_TOKENS || turns.length - keepFrom < 2)) {
      kept += cost(turns[keepFrom - 1]);
      keepFrom--;
    }
    const toFold = turns.slice(0, keepFrom);
    if (!toFold.length) return false;

    const transcript = toFold
      .map((t) => `${t.turn.role === "user" ? "LAWYER" : "ASSISTANT"}: ${t.turn.content}`)
      .join("\n\n")
      .slice(0, 9000);
    const openai = getLlmClient();
    const res = await openai.chat.completions.create(
      {
        model: config.customLlmModel,
        messages: [
          { role: "system", content: SUMMARY_SYSTEM_PROMPT },
          { role: "user", content: `CURRENT SUMMARY:\n${summary || "(none yet)"}\n\nNEW MESSAGES TO ADD:\n${transcript}\n\nWrite the updated summary.` },
        ],
        temperature: 0.1,
        max_tokens: 600,
      },
      { timeout: 90_000 },
    );
    const text = (res.choices[0]?.message?.content ?? "").trim();
    // A reasoning model can spend its whole allowance thinking and return nothing: then keep the old summary.
    if (text.length < 20) return false;
    const saved = await setChatSummary(conversationId, userId, shrinkText(text, SUMMARY_MAX_TOKENS), toFold[toFold.length - 1].at);
    if (saved) console.log(`\x1b[34m[AgentRuntime]\x1b[0m 🗜️ Chat ${conversationId}: folded ${toFold.length} older messages into the summary`);
    return saved;
  } catch (err: any) {
    console.warn("[AgentRuntime] could not summarise chat:", err?.message);
    return false;
  } finally {
    folding.delete(key);
  }
}
