import { getLlmClient } from "./client.js";
import { getMatterForUser, noteMatterAnswered, noteMatterWorkStarted } from "../repo/index.js";
import { emit } from "../bus/index.js";
import { buildDocumentContext, statuteCitations } from "../documents/context.js";
import { memoryPromptSection } from "../memories/index.js";
import { linkedKnowledgeIds } from "../knowledge-bases/index.js";
import { PgLibraryStore } from "../library/pg-store.js";
import { verifyAnswer } from "../library/verify.js";
import { indexedStatus, linkDocuments, searchDocuments, type DocumentHit } from "../documents/index.js";
import {
  ChatError,
  type Citation,
  createConversation,
  getConversation,
  getChatContext,
  insertMessage,
  latestConversationId,
  touchConversation,
} from "../chats/store.js";
import {
  CONTINUE_PROMPT,
  CUT_OFF_NOTICE,
  endAtSentence,
  estimateTokens,
  fitPrompt,
  safetyTokens,
  windowFromError,
  type ChatTurn,
  type PromptSection,
} from "./context-budget.js";
import { maybeSummarizeChat, toTurn } from "./summary.js";
import { classifySmallTalk, smallTalkReply } from "./smalltalk.js";
import { decideRetrieval, hasLegalSignal } from "./retrieval-gate.js";
import { config } from "../../config.js";
import { MODEL_UNAVAILABLE_MESSAGE } from "../legal/notice.js";
import { retrieveLegalContext } from "../legal/rag.js";
import { getAgentPersonaPrompt } from "./personas.js";
import { routeLegalTask, type RoutingDecision } from "./router.js";
import { extractTextFromFile, type Attachment } from "../files/index.js";
import { isImageName, loadImageParts, type ImagePart } from "./vision.js";
import crypto from "node:crypto";
import { RunQueue } from "./queue.js";
import { detectLanguage, languageAnswer, languageAnsweredTask, languageSection } from "./language.js";
import { activeProvider, defaultProvider, llmModel, providerFor, publicProviders, withProvider, type Provider } from "./providers.js";
import { intakeMessage, intakeReplyTo, intakeTask, isThinReply, matterFactsBrief, planIntake } from "./intake.js";
import { getCaseFile } from "../casefile/index.js";
import { getPreferences } from "../preferences/index.js";
import { CLARIFY_ANSWERED, decideClarify, hasAskBlock, isAnswersMessage, plainAsk, withAnsweredNote } from "./clarify.js";
import { classifyOutput, modeDirective } from "./output-mode.js";
import { createOutputArtifact, looksLikeRefusal, writeWithoutRefusing } from "./artifact-output.js";

/** The promise's value, or `fallback` if it takes longer than `ms`. The timer is cleared either way. */
function withTimeout<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

export interface MessageRecord {
  id: string;
  vakilId: string;
  vakil_id?: string;
  conversationId?: string | null;
  conversation_id?: string | null;
  role: "user" | "vakil" | "assistant" | "system";
  text: string;
  title?: string | null;
  card?: string | null;
  source?: string | null;
  attachments?: Attachment[] | null;
  citations?: Citation[] | null;
  createdAt: number;
  created_at?: number;
}

export interface RunState {
  /** idle, waiting for a free slot, or generating. */
  phase: "idle" | "queued" | "running";
  vakilId: string;
  conversationId: string;
  running: boolean;
  abortController: AbortController | null;
  currentStep: number;
}

// Run state is kept per user and per conversation. Sending in one chat never cancels an answer that is
// still being written in another, and one user's message or Stop never touches another user's run.
const activeRuns = new Map<string, RunState>();
const runKey = (conversationId: string, userId: string) => `${userId}::${conversationId}`;

export function getRunState(conversationId: string, userId: string, vakilId = ""): RunState {
  const key = runKey(conversationId, userId);
  let state = activeRuns.get(key);
  if (!state) {
    state = { phase: "idle", vakilId, conversationId, running: false, abortController: null, currentStep: 0 };
    activeRuns.set(key, state);
  }
  return state;
}

/**
 * Stops this user's running answer(s): one chat when `conversationId` is given, otherwise every
 * running answer of that agent. Returns whether anything was stopped.
 */
/** Answers this user has in progress or waiting, by chat. Sent with the live stream so a reload shows them. */
export function runningFor(userId: string): Record<string, "queued" | "running"> {
  const out: Record<string, "queued" | "running"> = {};
  for (const [key, state] of activeRuns) {
    if (key.startsWith(`${userId}::`) && state.running && state.phase !== "idle") out[state.conversationId] = state.phase;
  }
  return out;
}

// At most this many answers are generated at once overall, and per user; the rest wait their turn.
const runQueue = new RunQueue(Number(process.env.MAX_CONCURRENT_RUNS || 4), Number(process.env.MAX_RUNS_PER_USER || 2));

/** How many times a cut-off answer is continued, and the least room worth continuing in. */
const MAX_CONTINUATIONS = Number(process.env.MAX_CONTINUATIONS || 4);
const MIN_CONTINUE_TOKENS = 150;
/** No answer is allowed past this size, however many continuations it asks for. */
const MAX_ANSWER_CHARS = 24_000;

/** A failure worth one more try: a busy server, a rate limit, a dropped connection or a timeout. */
const isTransient = (e: any) => e?.status === 429 || (typeof e?.status === "number" && e.status >= 500) || /ECONNRESET|ETIMEDOUT|fetch failed|Connection error|timed? ?out|socket hang up/i.test(String(e?.message ?? ""));

// If the model server reports a smaller window than configured, that is used from then on.
// It is remembered per provider: one provider's small window must not shrink another's.
const learnedWindows = new Map<string, number>();
const currentWindow = () => {
  const p = activeProvider();
  return Math.min(p.window, learnedWindows.get(p.id) ?? Number.POSITIVE_INFINITY);
};
/** Fields some providers want on every chat request (for example Sarvam's reasoning setting). */
const extraBody = (): object => activeProvider().body;

export function abortRun(vakilId: string, userId: string, conversationId?: string): boolean {
  let stopped = false;
  for (const [key, state] of activeRuns) {
    if (!key.startsWith(`${userId}::`) || !state.running || !state.abortController) continue;
    if (conversationId ? state.conversationId !== conversationId : state.vakilId !== vakilId) continue;
    state.abortController.abort();
    state.running = false;
    stopped = true;
  }
  if (stopped) emit({ type: "vakil_status", vakilId, userId, data: { status: "idle" } });
  return stopped;
}

export async function sendMessage(
  vakilId: string,
  userText: string,
  userId: string,
  conversationId?: string,
  clientMsgId?: string,
  attachments?: Attachment[],
  options: { background?: boolean; provider?: Provider } = {},
): Promise<{ userMessage: MessageRecord; assistantMessage?: MessageRecord }> {
  if (!userId) throw new ChatError(401, "Sign in required.");
  // Resolve the conversation. It must belong to this user: someone else's id is
  // reported as "not found", exactly like an id that does not exist.
  let conversation = conversationId ? await getConversation(conversationId, userId) : null;
  if (conversationId && !conversation) throw new ChatError(404, "Conversation not found.");
  if (!conversation) {
    const latest = await latestConversationId(vakilId, userId);
    conversation = latest
      ? await getConversation(latest, userId)
      : await createConversation(vakilId, userText.slice(0, 40) || "New consultation", userId);
  }
  if (!conversation) throw new ChatError(404, "Conversation not found.");
  conversationId = conversation.id;

  // A new message in a chat replaces an answer still being written in that same chat (and only that chat).
  const runState = getRunState(conversationId, userId, vakilId);
  if (runState.running && runState.abortController) {
    runState.abortController.abort();
  }

  const matterId = conversation.matterId;
  // The matter's details go into the prompt, but only if it is one of this user's own matters.
  const matter = matterId ? await getMatterForUser(matterId, userId) : null;

  console.log(`\x1b[34m[AgentRuntime]\x1b[0m 💬 Prompt received for vakil=${vakilId} conv=${conversationId || "none"}: "${userText.slice(0, 75)}${userText.length > 75 ? "..." : ""}" (attachments: ${attachments?.length || 0})`);

  if (matterId) void noteMatterWorkStarted(matterId, userId, conversationId, userText).catch(() => undefined);

  // 1. Insert User Message
  const now = Date.now();
  // The message is stored and the chat's recency stamp (which the sidebar orders by) refreshed in the same step.
  const [stored] = await Promise.all([
    insertMessage({
      id: clientMsgId,
      conversationId,
      userId,
      vakilId,
      role: "user",
      text: userText,
      attachments: attachments && attachments.length > 0 ? attachments : null,
      createdAt: now,
    }),
    touchConversation(conversationId, userId, now),
  ]);
  const userMsg: MessageRecord = {
    id: stored.id,
    vakilId: vakilId,
    vakil_id: vakilId,
    conversationId,
    conversation_id: conversationId,
    role: "user",
    text: userText,
    attachments: attachments && attachments.length > 0 ? attachments : null,
    createdAt: now,
    created_at: now,
  };

  emit({ type: "message", vakilId, userId, data: userMsg });
  emit({ type: "vakil_status", vakilId, userId, data: { status: "thinking" } });
  // Greetings, "what is your name?" and thanks get a fixed reply: no model call, and no statute attached as a source.
  const smallTalk = classifySmallTalk(userText);
  const cannedText = smallTalkReply(smallTalk);
  if (cannedText) {
    const greetingText = cannedText;
    const assistantId = `msg-${crypto.randomUUID()}`;
    const assistantTime = Date.now();
    const assistantMessage: MessageRecord = {
      id: assistantId,
      vakilId,
      vakil_id: vakilId,
      conversationId: conversationId || null,
      conversation_id: conversationId || null,
      role: "vakil",
      text: greetingText,
      createdAt: assistantTime,
      created_at: assistantTime,
    };

    await insertMessage({
      id: assistantMessage.id,
      conversationId,
      userId,
      vakilId,
      role: "vakil",
      text: assistantMessage.text,
      createdAt: assistantMessage.createdAt,
    });

    emit({ type: "message", vakilId, userId, data: assistantMessage });
    emit({ type: "vakil_status", vakilId, userId, data: { status: "idle" } });
    return { userMessage: userMsg, assistantMessage };
  }

  // From here the answer is produced. It can run inside this call, or in the background.
  const abortController = new AbortController();
  runState.running = true;
  runState.abortController = abortController;
  runState.currentStep = 1;

  const generateInner = async (): Promise<{ userMessage: MessageRecord; assistantMessage?: MessageRecord }> => {
  // 2. Chat history. Older messages live on as a running summary saved with the chat; the messages after it are
  // loaded here (this user's own conversation only) and the newest ones that fit the model's window are used.
  const { summary: chatSummary, history: historyRows } = await getChatContext(conversationId, userId, userMsg.id, 40);

  // Sanitize history to prevent pattern poisoning: leave out repeated identical questions, stored fallback
  // messages and raw clause dumps (see toTurn). Long messages are shortened per message, not dropped.
  const cleanHistory: ChatTurn[] = historyRows
    .filter((m) => !(m.role === "user" && m.text.trim().toLowerCase() === userText.trim().toLowerCase()))
    .map(toTurn)
    .filter((t): t is ChatTurn => t !== null);

  console.log(`\x1b[34m[AgentRuntime]\x1b[0m 📜 Context loaded: ${cleanHistory.length} historical messages${chatSummary ? " + chat summary" : ""} for persona vakilId=${vakilId}`);

  // 3. Tie the attached documents to this chat and matter so they stay searchable in later questions.
  const attachedIds = (attachments ?? []).map((att) => att.id);
  const [, indexed] = await Promise.all([
    linkDocuments(userId, attachedIds, conversationId, conversation.matterId ?? null).catch((err) =>
      console.warn("[AgentRuntime] could not link documents:", err.message),
    ),
    indexedStatus(userId, attachedIds).catch(() => new Map<string, string>()),
  ]);

  // Files whose text is not indexed (unsupported or unreadable) are still read directly, as before.
  let attachedDocumentContext = "";
  const imageFiles: Array<{ id: string; name: string }> = [];
  let unreadableImages: string[] = [];
  let imageParts: ImagePart[] = [];
  let imageNames: string[] = [];
  if (attachments && attachments.length > 0) {
    for (const att of attachments) {
      if (indexed.get(att.id) === "ready") continue;
      // An image has no text to extract, and its bytes are read once, later, if the model can see it.
      if (isImageName(att.name)) {
        imageFiles.push({ id: att.id, name: att.name });
        continue;
      }
      const extracted = await extractTextFromFile(att.id, userId);
      if (extracted.trim()) {
        attachedDocumentContext += `\n\n[USER ATTACHED DOCUMENT: ${att.name}]\n${extracted.trim()}\n[END OF ATTACHED DOCUMENT]`;
      }
    }
  }

  // Images: a vision model is sent them with the question; any other model is told plainly it cannot read them.
  if (imageFiles.length > 0) {
    if (activeProvider().vision) {
      const loaded = await loadImageParts(imageFiles, userId);
      imageParts = loaded.parts;
      imageNames = loaded.names;
      unreadableImages = loaded.skipped;
    } else {
      unreadableImages = imageFiles.map((f) => f.name);
    }
  }

  try {
    const openai = getLlmClient();

    // Before answering, check whether something essential is missing. If so, the reply is a question card
    // the user answers with a click, and the answer itself waits for those answers (see clarify.ts).
    // A bail petition has a fixed checklist (who it is for, which court, what the case is, arrest and custody) that is
    // checked against the matter and the case file, and only what is missing is asked (see intake.ts).
    const caseFile = matterId ? await withTimeout(getCaseFile(userId, matterId).then((v) => v?.content ?? null).catch(() => null), 3000, null) : null;
    const savedLanguageEarly = await withTimeout(getPreferences(userId).then((p) => p.documentLanguage).catch(() => undefined), 1500, undefined);
    const intakeReply = intakeReplyTo(cleanHistory, userText);
    const intakePlan =
      (attachments?.length ?? 0) > 0 || isAnswersMessage(userText)
        ? null
        : planIntake({
            request: intakeReply?.original ?? userText,
            history: intakeReply ? [...cleanHistory, { role: "user", content: userText }] : cleanHistory,
            matter: matter ? { title: matter.title, client: matter.client, court: matter.court, notes: matter.notes, intake: matter.intake } : null,
            caseFile,
            savedLanguage: savedLanguageEarly,
          });
    let intakeAsk: string | null = null;
    // A reply that only repeats the request is not the details: ask once more, then write with placeholders.
    if (intakePlan?.missing.length && (!intakeReply || (isThinReply(userText, intakeReply.original) && intakeReply.asked < 2))) {
      intakeAsk = intakeMessage(intakePlan, { again: Boolean(intakeReply) });
    }
    const intakeDone = Boolean(intakePlan) && !intakeAsk;

    console.log("[Clarify] checking whether anything essential is missing");
    const askText =
      intakeAsk ??
      (intakePlan || intakeReply
        ? null
        : await decideClarify({
            userText,
            history: cleanHistory,
            hasAttachments: (attachments?.length ?? 0) > 0,
            matterBrief: matter ? `${matter.title}${matter.client ? `, client ${matter.client}` : ""}${matter.court ? `, ${matter.court}` : ""}. ${(matter.notes || "").slice(0, 600)}` : undefined,
            signal: abortController.signal,
          }));
    if (askText && !abortController.signal.aborted) {
      const askTime = Date.now();
      const askMsg: MessageRecord = {
        id: `msg-${crypto.randomUUID()}`,
        vakilId,
        vakil_id: vakilId,
        conversationId: conversationId || null,
        conversation_id: conversationId || null,
        role: "vakil",
        text: askText,
        createdAt: askTime,
        created_at: askTime,
      };
      await insertMessage({ id: askMsg.id, conversationId, userId, vakilId, role: "vakil", text: askText, createdAt: askTime });
      await touchConversation(conversationId, userId);
      emit({ type: "message", vakilId, userId, data: askMsg });
      emit({ type: "vakil_status", vakilId, userId, data: { status: "idle" } });
      if (runState.abortController === abortController) {
        runState.running = false;
        runState.abortController = null;
      }
      return { userMessage: userMsg, assistantMessage: askMsg };
    }

    // 0. Master Orchestrator task analysis & sub-agent routing
    const isMasterOrGeneral =
      vakilId === "soli_master" ||
      vakilId.includes("master") ||
      vakilId.includes("soli") ||
      (!vakilId.includes("vakil") && !vakilId.includes("nyaya") && !vakilId.includes("pramaan") && !vakilId.includes("docket"));

    // An answer to a question card is turned back into the original request plus the facts given, so routing,
    // the legal search and the model all work from a real task (see clarify.ts).
    const answering = isAnswersMessage(userText);
    // The same goes for the plain-text "Which language should I write this in?": the short reply carries on the request it answers.
    const langAnswer = answering ? null : languageAnswer(userText, cleanHistory);
    const originalRequest = answering ? [...cleanHistory].reverse().find((t) => t.role === "user" && !isAnswersMessage(t.content))?.content : (intakeDone ? intakeReply?.original : undefined) ?? langAnswer?.original;
    // A bail petition is written from the request, what the file holds and the lawyer's details together.
    const intakeTaskText =
      intakeDone && intakePlan
        ? intakeTask({ original: intakeReply?.original ?? userText, known: intakePlan.known, details: intakeReply ? userText : undefined, language: detectLanguage(userText) })
        : null;
    const taskText = answering ? withAnsweredNote(userText, originalRequest) : intakeTaskText ?? (langAnswer ? languageAnsweredTask(langAnswer) : userText);
    // A plan or strategy opens as an artifact, a notice or draft in the document editor (see output-mode.ts).
    const outputMode = classifyOutput(originalRequest ?? userText);

    let routing: RoutingDecision | null = null;
    let targetSubAgent = vakilId;

    if (isMasterOrGeneral) {
      routing = routeLegalTask(taskText, attachments?.length || 0);
      targetSubAgent = routing.target;
      console.log(`\x1b[35m[MasterAgent]\x1b[0m ⚖️ Analyzed task -> Delegating to ${routing.name} (${routing.role}). Reason: ${routing.reason}`);
      emit({ type: "agent_routing", vakilId, userId, data: routing });
    }

    // 1. Retrieve RAG context from vector legal corpus (Qdrant) and ingested vault
    // Decide first whether this message needs the legal knowledge base at all. A general or casual message searches
    // nothing, so it answers faster and no unrelated statute is attached to it as a source.
    // Knowledge bases the user attached to this chat or its matter count as case context, like a matter's own files.
    const knowledgeIds = await linkedKnowledgeIds(userId, conversationId, conversation.matterId ?? null);
    const gate = decideRetrieval({
      text: taskText,
      hasAttachments: (attachments?.length ?? 0) > 0,
      onlyImages: (attachments?.length ?? 0) > 0 && (attachments ?? []).every((a) => isImageName(a.name)),
      inMatter: Boolean(conversation.matterId) || knowledgeIds.length > 0,
      recent: cleanHistory.map((m) => m.content),
    });
    console.log(`\x1b[35m[RetrievalGate]\x1b[0m 🧭 statutes=${gate.statutes ? "search" : "skip"}, documents=${gate.documents ? "search" : "skip"} (${gate.reason})`);
    // The statute library (vector + text search) and the user's own documents are independent, so they are searched
    // at the same time; each has its own time limit and falls back to "nothing found" rather than stalling the answer.
    // A short follow-up ("and what if he was a minor?") is searched together with the legal question it follows.
    const priorLegal = gate.reason === "follow-up" ? [...cleanHistory].reverse().find((m) => m.role === "user" && hasLegalSignal(m.content))?.content : undefined;
    const searchText = priorLegal ? `${priorLegal.slice(0, 300)} ${taskText}` : taskText;
    const [ragResult, documentHits] = await Promise.all([
      gate.statutes ? withTimeout(retrieveLegalContext(searchText).catch(() => null), config.upstreamTimeoutMs * 2, null) : Promise.resolve(null),
      gate.documents
        ? withTimeout(
            searchDocuments(userId, { conversationId, matterId: conversation.matterId ?? null, knowledgeIds }, taskText, 5).catch(() => [] as DocumentHit[]),
            config.upstreamTimeoutMs,
            [] as DocumentHit[],
          )
        : Promise.resolve([] as DocumentHit[]),
    ]);
    if (ragResult) {
      console.log(
        `\x1b[32m[AgentRuntime]\x1b[0m 📚 Legal Vector RAG retrieved context (${ragResult.sources.length} sources, ${ragResult.contextText.length} chars)`
      );
      emit({
        type: "rag_context",
        vakilId,
        userId,
        data: {
          sources: ragResult.sources,
          documentTitle: ragResult.documentTitle,
        },
      });
    }

    // 2. Passages of this user's documents (attached to this chat, or in its matter) that match the question
    // (searched above, together with the statutes).
    const documentContext = buildDocumentContext(documentHits);
    let citations: Citation[] = [...documentContext.citations, ...statuteCitations(ragResult?.sources)];

    // The prompt is built from sections so that, when it is too long for the model's window, the least important
    // ones are shortened first (see context-budget.ts). Instructions and the user's question are never cut.
    const sections: PromptSection[] = [{ id: "persona", text: getAgentPersonaPrompt(vakilId, targetSubAgent), shedOrder: 100 }];

    if (ragResult) {
      sections.push({
        id: "statutes",
        text: ragResult.contextText,
        tail: `LEGAL COUNSEL DIRECTIVES FOR RETRIEVED STATUTES & PRECEDENTS:\n- Ground the legal advice you give in the statutory sections and judicial precedents provided above.\n- When the user asks you to draft a document (a notice, petition, agreement, reply), ALWAYS write the draft in the standard Indian format, even when the sources above are only loosely related: use them only for the provisions you may cite, put [PLACEHOLDERS] for facts you do not have, and never refuse, never say you cannot draft, and never ask the user to share a section, an Act or a search first.\n- State exact sections (BNSS, BNS, BSA, CPC, NI Act), statutory ingredients, and relevant ratios.\n- Cite a case or section only if it appears in the sources above, with its citation exactly as printed there. Any other authority you mention must be marked "unverified, from memory" and given without a reporter or neutral citation number. Never invent a paragraph number or a quotation.\n- Do NOT output synthetic platform banners or watermarks. Provide authentic courtroom counsel.`,
        floorTokens: 350,
        shedOrder: 50,
      });
    } else {
      sections.push({
        id: "no-sources",
        text: `NO STATUTORY SOURCES WERE RETRIEVED FOR THIS QUESTION. Do not present case names, citations, bench strengths or section numbers from memory as verified. If you mention any authority, say that it is unverified and must be checked against the official source. Say plainly when you are unsure.`,
        shedOrder: 100,
      });
    }

    if (documentContext.text) {
      sections.push({ id: "documents", text: documentContext.body ?? documentContext.text, tail: documentContext.rules, floorTokens: 300, shedOrder: 40 });
    }

    // What the user asked Lirava to remember about them (settings → Memory). Shed early if the prompt is too long.
    const memoryText = await memoryPromptSection(userId);
    if (memoryText) sections.push({ id: "memories", text: memoryText, floorTokens: 80, shedOrder: 30 });

    if (attachedDocumentContext) {
      sections.push({
        id: "attachments",
        text: `USER UPLOADED ATTACHMENT CONTEXT:\nThe user has provided documents along with their query. Refer to the attached text below to analyze clauses, provide legal reviews, or answer questions directly based on the user's uploaded material:\n${attachedDocumentContext.slice(0, 6000)}`,
        floorTokens: 250,
        shedOrder: 20,
      });
    }

    if (imageParts.length > 0) {
      sections.push({
        id: "image-note",
        text: `The user attached ${imageParts.length} image(s) (${imageNames.join(", ")}) to this message; you can see them. Read any text in an image exactly as written and say clearly when part of it is too small or unclear to read. Describe only what is visible, never guess at the rest, and treat what the image shows as the user's own material, not as verified law.`,
        floorTokens: 60,
        shedOrder: 95,
      });
    }

    if (unreadableImages.length > 0) {
      sections.push({
        id: "images",
        text: (() => {
          const canRead = publicProviders().filter((p) => p.available && p.vision && p.id !== activeProvider().id).map((p) => p.label);
          const switchTo = canRead.length ? `Tell the user to choose ${canRead.join(" or ")} in the model picker beside the message box (those models can read images), then send the image again. ` : "";
          return `The user attached image file(s) (${unreadableImages.join(", ")}), but the selected model (${activeProvider().label}) cannot read images. Do not describe or guess their contents. Tell the user plainly that ${activeProvider().label} cannot read images. ${switchTo}Or they can upload the document as a PDF or Word file, or paste the text. Then answer anything else in their message.`;
        })(),
        floorTokens: 60,
        shedOrder: 90,
      });
    }

    if (matter) {
      sections.push({
        id: "matter",
        text: `CURRENT MATTER CONTEXT:\nMatter: ${matter.title}\nClient: ${matter.client || "Not recorded"}\nCourt / forum: ${matter.court || "Not recorded"}\nMatter notes: ${(matter.notes || "None recorded").slice(0, 1500)}${matterFactsBrief(matter, caseFile) ? `\n${matterFactsBrief(matter, caseFile)}` : ""}`,
        tail: `Keep this matter context in mind, but do not invent facts not supplied by the user or sources.`,
        floorTokens: 120,
        shedOrder: 30,
      });
    }

    // Which language documents are written in: the user's saved default, or the rule to ask first (see language.ts).
    const savedLanguage = savedLanguageEarly; // already read before the checklist step
    sections.push({ id: "language", text: languageSection(savedLanguage, { documentRequest: outputMode === "document" }), floorTokens: 120, shedOrder: 96 });

    if (chatSummary) {
      sections.push({
        id: "summary",
        text: `SUMMARY OF THE EARLIER PART OF THIS CHAT (those messages are no longer shown; treat this as background and do not repeat it):\n${chatSummary}`,
        floorTokens: 150,
        shedOrder: 35,
      });
    }

    // The user has just answered a question card: use the answers, do not ask again (see clarify.ts).
    if (isAnswersMessage(userText)) sections.push({ id: "clarify", text: CLARIFY_ANSWERED, shedOrder: 100 });
    if (outputMode) sections.push({ id: "output-mode", text: modeDirective(outputMode), shedOrder: 100 });

    // The model reads a card it asked as one plain line, and an answer to a card with an instruction to go ahead.
    const modelHistory = cleanHistory.map((t) => ({ ...t, content: plainAsk(t.content) }));
    const modelUserText = taskText;

    // Each image takes a share of the window, so the text is fitted into what is left.
    const imageReserve = imageParts.length * config.imageTokens;
    const fitted = fitPrompt({ sections, history: modelHistory, userText: modelUserText, windowTokens: Math.max(1024, currentWindow() - imageReserve), answerTokens: activeProvider().answerMax });
    // The images travel with the user's message (the last one), which becomes text plus image parts.
    const messages = (imageParts.length > 0
      ? fitted.messages.map((m, i, all) => (i === all.length - 1 && m.role === "user" ? { ...m, content: [{ type: "text", text: m.content }, ...imageParts] } : m))
      : fitted.messages) as typeof fitted.messages;
    console.log(
      `\x1b[34m[AgentRuntime]\x1b[0m 📏 Prompt ~${fitted.promptTokens} tokens of ${currentWindow()} (answer up to ${fitted.maxAnswerTokens}); ` +
        `${cleanHistory.length - fitted.droppedHistory}/${cleanHistory.length} chat messages kept${fitted.shortened.length ? `; shortened: ${fitted.shortened.join(", ")}` : ""}${fitted.userTextShortened ? "; user message shortened" : ""}`,
    );

    const asstMsgId = `msg-${crypto.randomUUID()}`;
    const asstTime = Date.now();
    const asstMsg: MessageRecord = {
      id: asstMsgId,
      vakilId: vakilId,
      vakil_id: vakilId,
      conversationId: conversationId || null,
      conversation_id: conversationId || null,
      role: "vakil",
      text: "",
      citations: citations.length ? citations : null,
      createdAt: asstTime,
      created_at: asstTime,
    };

    let generatedContent = "";
    let reasoningBuffer = "";
    let hasReceivedContent = false;
    let assistantText = "";
    let loopGuardAt = 0;
    const llmStartTime = Date.now();
    let initialMessageEmitted = false;

    // Streams one model call into the message being written. Returns why the model stopped: "stop" is a finished
    // answer, "length" means it ran out of room mid-answer (the window or max_tokens), so the answer is incomplete.
    const consume = async (stream: AsyncIterable<any>): Promise<string | null> => {
      let finish: string | null = null;
      for await (const chunk of stream) {
        const choice = chunk.choices?.[0];
        if (choice?.finish_reason) finish = choice.finish_reason;
        const delta = choice?.delta as any;
        const text = delta?.content || "";
        const reasoning = delta?.reasoning_content || "";

        if (reasoning) {
          reasoningBuffer += reasoning;
          if (!initialMessageEmitted) {
            initialMessageEmitted = true;
            // A visible placeholder only: the real answer replaces it, and it is never saved as an answer.
            emit({ type: "message", vakilId, userId, data: { ...asstMsg, text: "*Analyzing statutory provisions and case records...*\n\n" } });
          }
        }

        if (text) {
          if (!hasReceivedContent) {
            hasReceivedContent = true;
            generatedContent += text;
            assistantText = text;
            initialMessageEmitted = true;
            emit({ type: "message", vakilId, userId, data: { ...asstMsg, text: assistantText } });
          } else {
            generatedContent += text;
            assistantText += text;
            emit({ type: "message_delta", id: asstMsgId, vakilId, userId, delta: text });
          }

          // A small model can get stuck and write the same clause again and again. When the latest stretch of text already
          // appears earlier in the answer, stop here and keep the first copy, instead of letting it run to the length limit.
          if (assistantText.length - loopGuardAt >= 300) {
            loopGuardAt = assistantText.length;
            const tail = assistantText.slice(-120);
            if (assistantText.slice(0, -120).includes(tail)) {
              console.warn(`[33m[AgentRuntime][0m 🔁 The model started repeating itself; stopping the answer at the first copy`);
              assistantText = endAtSentence(assistantText.slice(0, assistantText.indexOf(tail) + tail.length));
              generatedContent = assistantText;
              return "stop";
            }
          }
        }
      }
      return finish;
    };

    /** Marks an answer that stopped before it was finished, ending it at a full sentence. */
    const markCutOff = () => {
      if (!assistantText.trim()) return;
      assistantText = endAtSentence(assistantText) + CUT_OFF_NOTICE;
    };

    try {
      console.log(`\x1b[34m[AgentRuntime]\x1b[0m 🧠 Dispatching streaming LLM request to (${activeProvider().baseURL}) for sub-agent ${targetSubAgent}...`);
      const open = () =>
        openai.chat.completions.create(
          {
            model: llmModel(),
            messages,
            temperature: 0.3,
            max_tokens: Math.max(256, fitted.maxAnswerTokens),
            stream: true,
            ...extraBody(),
          },
          { signal: abortController.signal, timeout: 120000 },
        );
      // A hosted provider can fail for a moment (a busy server, a dropped connection): one more try before giving up.
      let stream;
      try {
        stream = await open();
      } catch (e: any) {
        if (!activeProvider().hosted || abortController.signal.aborted || !isTransient(e)) throw e;
        console.warn(`[33m[AgentRuntime][0m ⏳ ${activeProvider().label} failed for a moment (${String(e?.message).slice(0, 80)}); trying once more`);
        await new Promise((r) => setTimeout(r, 1500));
        stream = await open();
      }

      let finish = await consume(stream);
      // A hosted model that answers with nothing at all is asked once more.
      if (!assistantText.trim() && activeProvider().hosted && !abortController.signal.aborted && finish !== "length") {
        console.warn(`[33m[AgentRuntime][0m ⏳ ${activeProvider().label} sent an empty reply; trying once more`);
        finish = await consume(await open());
      }

      // A reasoning model can spend the whole answer budget thinking and send no text. Try once more with reasoning off.
      if (finish === "length" && !assistantText.trim() && "reasoning_effort" in extraBody() && (extraBody() as { reasoning_effort?: unknown }).reasoning_effort !== null) {
        console.warn(`[33m[AgentRuntime][0m 🧠 The model used its whole answer budget thinking and wrote nothing; trying again with reasoning off`);
        const again = await openai.chat.completions.create(
          { model: llmModel(), messages, temperature: 0.3, max_tokens: Math.max(256, fitted.maxAnswerTokens), stream: true, ...extraBody(), reasoning_effort: null },
          { signal: abortController.signal, timeout: 120000 },
        );
        finish = await consume(again);
      }

      // The answer hit its length limit before it was finished: ask the model to carry on from where it stopped.
      // First with the same prompt (the server reuses its cache). When the window has no room for that, with a much
      // smaller prompt (no chat history, every section at its minimum), which frees most of the window for the answer.
      let continuations = 0;
      // A document may need several continuations; a plain question should not run on, and no answer grows without bound.
      const continuationLimit = outputMode ? MAX_CONTINUATIONS : Math.min(2, MAX_CONTINUATIONS);
      while (finish === "length" && assistantText.trim() && continuations < continuationLimit && assistantText.length < MAX_ANSWER_CHARS && !abortController.signal.aborted) {
        const window = currentWindow();
        const tail = estimateTokens(assistantText) + estimateTokens(CONTINUE_PROMPT) + 24;
        let base = messages;
        let room = Math.min(activeProvider().answerMax, window - (fitted.promptTokens + tail) - safetyTokens(window));
        if (room < MIN_CONTINUE_TOKENS) {
          const compact = fitPrompt({
            sections,
            history: [],
            userText: modelUserText,
            windowTokens: Math.max(1024, window - tail),
            answerTokens: Math.min(activeProvider().answerMax, 1200),
            minimal: true,
          });
          base = compact.messages;
          room = Math.min(activeProvider().answerMax, window - (compact.promptTokens + tail) - safetyTokens(window));
          if (room >= MIN_CONTINUE_TOKENS) console.log(`\x1b[34m[AgentRuntime]\x1b[0m ✂️ Continuing with a smaller prompt to make room (${compact.promptTokens} tokens)`);
        }
        if (room < MIN_CONTINUE_TOKENS) break;
        continuations++;
        console.log(`\x1b[34m[AgentRuntime]\x1b[0m ↪️ Answer hit its length limit; continuing (${continuations}/${MAX_CONTINUATIONS}, room for ${room} tokens)`);
        const next = await openai.chat.completions.create(
          {
            model: llmModel(),
            messages: [...base, { role: "assistant" as const, content: assistantText }, { role: "user" as const, content: CONTINUE_PROMPT }],
            temperature: 0.3,
            max_tokens: room,
            stream: true,
            ...extraBody(),
          },
          { signal: abortController.signal, timeout: 120000 },
        );
        const before = assistantText.length;
        finish = await consume(next);
        // A model that starts over repeats what it already wrote: keep the first copy and stop.
        const probe = assistantText.slice(before).trim().slice(0, 120);
        if (probe.length >= 80 && assistantText.slice(0, before).includes(probe)) {
          console.warn(`[33m[AgentRuntime][0m 🔁 The continuation repeated earlier text; stopping there`);
          assistantText = endAtSentence(assistantText.slice(0, before));
          finish = "stop";
        }
      }
      // Still not finished (no room left): end at a full sentence and tell the user how to get the rest.
      if (finish === "length") {
        console.warn(`\x1b[33m[AgentRuntime]\x1b[0m ✂️ Answer reached the length limit after ${continuations} continuation(s)`);
        markCutOff();
      }

      // Text the model produced only as "reasoning" is its private working, not an answer, so it is
      // never shown as one. An empty answer falls through to the notice below.

      console.log(`\x1b[34m[AgentRuntime]\x1b[0m ⚡ LLM streaming completed in ${Date.now() - llmStartTime}ms (${assistantText.length} chars)`);
    } catch (llmErr: any) {
      if (llmErr.name === "AbortError" || abortController.signal.aborted) {
        // Stopped by the user (or replaced by a newer message): keep the part already written instead of losing it.
        if (assistantText.trim()) {
          asstMsg.text = assistantText;
          await insertMessage({ id: asstMsg.id, conversationId, userId, vakilId, role: "vakil", text: assistantText, citations, createdAt: asstMsg.createdAt }).catch(() => undefined);
          emit({ type: "message", vakilId, userId, data: asstMsg });
        }
        throw llmErr;
      }

      console.error(`\x1b[31m[AgentRuntime] ❌ LLM Inference Error:\x1b[0m`, llmErr.message);

      // The server says how big its window really is when a prompt does not fit: remember it for every later request.
      const reportedWindow = windowFromError(llmErr.message);
      if (reportedWindow && reportedWindow < currentWindow()) {
        learnedWindows.set(activeProvider().id, reportedWindow);
        console.warn(`\x1b[33m[AgentRuntime]\x1b[0m 📐 The model server's window is ${reportedWindow} tokens; using that from now on.`);
      }

      // If the prompt did not fit, try once more with a much smaller one (no chat history, sections at their minimum).
      // Only before any answer text exists: a failure in the middle of an answer must not start a second answer.
      const isContextOverflow =
        !hasReceivedContent &&
        (reportedWindow !== null || llmErr.status === 400 || llmErr.message?.includes("exceeds the available context size") || llmErr.message?.includes("context size"));

      if (isContextOverflow) {
        console.warn(`\x1b[33m[AgentRuntime] ⚠️ Context overflow (${llmErr.message}). Retrying with a minimal prompt...\x1b[0m`);
        try {
          const small = fitPrompt({
            sections,
            history: [],
            userText: modelUserText,
            windowTokens: Math.floor(currentWindow() * 0.85),
            answerTokens: Math.min(activeProvider().answerMax, 900),
            minimal: true,
          });
          const retryStream = await openai.chat.completions.create(
            {
              model: llmModel(),
              messages: small.messages,
              temperature: 0.3,
              max_tokens: Math.max(256, small.maxAnswerTokens),
              stream: true,
            },
            { signal: abortController.signal, timeout: 120000 }
          );
          const retryFinish = await consume(retryStream);
          if (retryFinish === "length") markCutOff();
        } catch (retryErr: any) {
          console.warn(`[AgentRuntime] Retry also failed:`, retryErr.message);
        }
      } else if (generatedContent.trim()) {
        // The connection broke part-way through an answer: keep what was written and say it is not complete.
        markCutOff();
      }

      if (!generatedContent.trim()) {
        console.warn(`\x1b[33m[AgentRuntime] ⚠️ LLM inference node offline at ${activeProvider().baseURL} (${llmErr.message}). Telling the user the model is unavailable.\x1b[0m`);
        // No canned legal text stands in for the model: it could be mistaken for advice, or saved as a document.
        const fallbackText = MODEL_UNAVAILABLE_MESSAGE;
        citations = [];
        asstMsg.citations = null;
        assistantText = fallbackText;

        const words = assistantText.split(" ");
        const firstChunk = words.slice(0, 3).join(" ") + (words.length > 3 ? " " : "");
        if (!initialMessageEmitted) {
          initialMessageEmitted = true;
          emit({ type: "message", vakilId, userId, data: { ...asstMsg, text: firstChunk } });
        } else {
          emit({ type: "message_delta", id: asstMsgId, vakilId, userId, delta: firstChunk });
        }

        for (let i = 3; i < words.length; i += 3) {
          if (abortController.signal.aborted) break;
          const slice = words.slice(i, i + 3).join(" ") + (i + 3 < words.length ? " " : "");
          emit({ type: "message_delta", id: asstMsgId, vakilId, userId, delta: slice });
          await new Promise((r) => setTimeout(r, 10));
        }
      }
    }

    if (!assistantText) {
      console.warn(`\x1b[33m[AgentRuntime] ⚠️ LLM returned empty response. Telling the user the model is unavailable.\x1b[0m`);
      citations = [];
      asstMsg.citations = null;
      assistantText = MODEL_UNAVAILABLE_MESSAGE;
      if (!initialMessageEmitted) {
        emit({ type: "message", vakilId, userId, data: { ...asstMsg, text: assistantText } });
      } else {
        emit({ type: "message_delta", id: asstMsgId, vakilId, userId, delta: assistantText });
      }
    }

    asstMsg.text = assistantText;
    // When the model could not answer, the message says so and that is all: no retry, no citation check, no document, no matter note.
    const modelUnavailable = assistantText === MODEL_UNAVAILABLE_MESSAGE;

    // The model refused a request for a document or plan ("please share the section first"): try once more with
    // a short prompt that orders it to write the work with placeholders. The final message below replaces the text.
    if (!modelUnavailable && outputMode && !abortController.signal.aborted && looksLikeRefusal(assistantText)) {
      console.log("[Output] the model refused to write the work; trying once more without the search results");
      const redone = await writeWithoutRefusing({ mode: outputMode, task: taskText, persona: getAgentPersonaPrompt(vakilId, targetSubAgent), signal: abortController.signal });
      if (redone) {
        assistantText = redone;
        asstMsg.text = redone;
      }
    }

    // Check every case and section the answer names against the legal library. Nothing the model typed is trusted:
    // a citation is "verified" only when it matches a library record. The result travels beside the answer as its own
    // event (not mixed into `citations`), and a failed or slow check never holds the answer back.
    try {
      const check = modelUnavailable ? null : await withTimeout(verifyAnswer(assistantText, new PgLibraryStore()).catch(() => null), config.upstreamTimeoutMs, null);
      if (check && check.verdicts.length > 0) {
        console.log(`\x1b[35m[CitationCheck]\x1b[0m ⚖️ ${check.counts.verified} verified, ${check.counts.partial} partly, ${check.counts.unverified} not in the library`);
        emit({ type: "citation_check", vakilId, userId, data: { messageId: asstMsg.id, ...check } });
      }
    } catch {
      /* the check is advisory */
    }

    await insertMessage({
      id: asstMsg.id,
      conversationId,
      userId,
      vakilId,
      role: "vakil",
      text: asstMsg.text,
      citations,
      createdAt: asstMsg.createdAt,
    });
    await touchConversation(conversationId, userId);
    // The finished plan or document is saved as an artifact (which opens beside the chat) and the chat shows it
    // as a card. If saving fails, the answer simply stays as chat text.
    if (outputMode && !modelUnavailable && !hasAskBlock(asstMsg.text)) {
      await createOutputArtifact({ mode: outputMode, text: asstMsg.text, userId, vakilId, conversationId, messageId: asstMsg.id, request: originalRequest ?? userText, matterTitle: matter?.title ?? null });
    }
    if (matterId && !modelUnavailable && !hasAskBlock(asstMsg.text)) void noteMatterAnswered(matterId, userId, conversationId, asstMsg.text).catch(() => undefined);

    // After the answer is saved (so the user never waits for it): fold older messages into the chat's summary
    // once they no longer fit in the window.
    void maybeSummarizeChat(conversationId, userId);

    emit({ type: "message", vakilId, userId, data: asstMsg });
    emit({ type: "vakil_status", vakilId, userId, data: { status: "idle" } });

    if (runState.abortController === abortController) {
      runState.running = false;
      runState.abortController = null;
    }

    return { userMessage: userMsg, assistantMessage: asstMsg };
  } catch (err: any) {
    if (runState.abortController === abortController) {
      runState.running = false;
      runState.abortController = null;
    }
    emit({ type: "vakil_status", vakilId, userId, data: { status: "idle" } });

    // Pressing Stop is not a failure, whatever the HTTP client names the error it raises while cancelling.
    if (err.name === "AbortError" || abortController.signal.aborted) {
      return { userMessage: userMsg };
    }

    throw err;
  }
  };

  // The whole answer runs with the provider the user chose (or the server default), however long it waits in the queue.
  // A message with an image uses the provider's image model when the chosen one cannot read images (Sarvam: gemma4).
  const provider = providerFor(options.provider ?? defaultProvider(), (attachments ?? []).some((a) => isImageName(a.name)));
  const generate = () => withProvider(provider, generateInner);

  const announce = (status: RunState["phase"]) => {
    runState.phase = status;
    emit({ type: "run_status", vakilId, userId, conversationId, data: { status } });
  };

  if (!options.background) {
    announce("running");
    try {
      return await generate();
    } finally {
      announce("idle");
    }
  }

  // Background mode: the question is already saved, so hand it back at once. The answer waits for a free
  // slot (shown as "queued" when the model is busy), is generated, and arrives through the live stream.
  announce(runQueue.wouldWait(userId) ? "queued" : "running");
  void runQueue
    .run(userId, async () => {
      if (abortController.signal.aborted) return; // stopped while it was waiting
      announce("running");
      await generate();
    })
    .catch(async (err: unknown) => {
      console.error("[AgentRuntime] background answer failed:", err instanceof Error ? err.message : err);
      const failure = await insertMessage({
        conversationId: conversationId!,
        userId,
        vakilId,
        role: "vakil",
        text: "I couldn't complete this answer. Please send your question again.",
      }).catch(() => null);
      if (failure) emit({ type: "message", vakilId, userId, data: failure });
    })
    .finally(() => announce("idle"));

  return { userMessage: userMsg };
}
