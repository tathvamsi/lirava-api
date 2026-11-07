import { getLlmClient } from "./client.js";
import { getDb } from "../db/index.js";
import { emit } from "../bus/index.js";
import { createConversation, getConversation } from "../repo/index.js";
import { config } from "../../config.js";
import { generateLegalResponse } from "../legal/knowledge.js";
import { retrieveLegalContext } from "../legal/rag.js";
import { getAgentPersonaPrompt } from "./personas.js";
import { routeLegalTask } from "./router.js";
import { extractTextFromFile } from "../files/index.js";
import crypto from "node:crypto";
const activeRuns = new Map();
export function getRunState(dotId) {
    let state = activeRuns.get(dotId);
    if (!state) {
        state = { running: false, abortController: null, currentStep: 0 };
        activeRuns.set(dotId, state);
    }
    return state;
}
export function abortRun(dotId) {
    const state = activeRuns.get(dotId);
    if (state?.running && state.abortController) {
        state.abortController.abort();
        state.running = false;
        emit({ type: "dot_status", dotId, data: { status: "idle" } });
        return true;
    }
    return false;
}
export async function sendMessage(dotId, userText, userId = "usr-super-admin", conversationId, clientMsgId, attachments) {
    const db = getDb();
    const runState = getRunState(dotId);
    // If already running, abort current run to accept newest prompt
    if (runState.running && runState.abortController) {
        runState.abortController.abort();
    }
    // Ensure conversation exists so messages are never orphaned without a conversationId
    if (!conversationId) {
        const existing = db.prepare(`SELECT id FROM conversations WHERE dot_id = ? ORDER BY updated_at DESC LIMIT 1`).get(dotId);
        if (existing?.id) {
            conversationId = existing.id;
        }
        else {
            const conv = createConversation(dotId, userText.slice(0, 40) || "New consultation", userId);
            conversationId = conv.id;
        }
    }
    const matterId = conversationId ? getConversation(conversationId)?.matterId : null;
    const matter = matterId
        ? db.prepare("SELECT title, client, court, notes FROM matters WHERE id = ? AND user_id = ?").get(matterId, userId)
        : undefined;
    console.log(`\x1b[34m[AgentRuntime]\x1b[0m 💬 Prompt received for dot=${dotId} conv=${conversationId || "none"}: "${userText.slice(0, 75)}${userText.length > 75 ? "..." : ""}" (attachments: ${attachments?.length || 0})`);
    // 1. Insert User Message
    const userMsgId = clientMsgId || `msg-${crypto.randomUUID()}`;
    const now = Date.now();
    const userMsg = {
        id: userMsgId,
        dotId: dotId,
        dot_id: dotId,
        conversationId: conversationId || null,
        conversation_id: conversationId || null,
        role: "user",
        text: userText,
        attachments: attachments && attachments.length > 0 ? attachments : null,
        createdAt: now,
        created_at: now,
    };
    const attachmentsJson = userMsg.attachments ? JSON.stringify(userMsg.attachments) : null;
    db.prepare(`
    INSERT INTO messages (id, dot_id, conversation_id, role, text, attachments, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(userMsg.id, userMsg.dotId, userMsg.conversationId ?? null, userMsg.role, userMsg.text, attachmentsJson, userMsg.createdAt);
    // Keep the conversation's recency stamp fresh so the sidebar can order by it.
    if (conversationId) {
        db.prepare(`UPDATE conversations SET updated_at = ? WHERE id = ?`).run(now, conversationId);
    }
    emit({ type: "message", dotId, userId, data: userMsg });
    emit({ type: "dot_status", dotId, userId, data: { status: "thinking" } });
    if (/^(hi|hello|hey|greetings|good\s+(morning|afternoon|evening))[.!?\s]*$/i.test(userText.trim())) {
        const greetingText = "Hello. I'm Lirava. How can I help with your legal matter today?";
        const assistantId = `msg-${crypto.randomUUID()}`;
        const assistantTime = Date.now();
        const assistantMessage = {
            id: assistantId,
            dotId,
            dot_id: dotId,
            conversationId: conversationId || null,
            conversation_id: conversationId || null,
            role: "dot",
            text: greetingText,
            createdAt: assistantTime,
            created_at: assistantTime,
        };
        db.prepare(`
      INSERT INTO messages (id, dot_id, conversation_id, role, text, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(assistantMessage.id, assistantMessage.dotId, assistantMessage.conversationId ?? null, assistantMessage.role, assistantMessage.text, assistantMessage.createdAt);
        emit({ type: "message", dotId, userId, data: assistantMessage });
        emit({ type: "dot_status", dotId, userId, data: { status: "idle" } });
        return { userMessage: userMsg, assistantMessage };
    }
    // 2. Fetch recent conversation history
    // Local LLM has n_ctx = 1792. We keep up to 4 recent turns and cap long previous outputs
    // so that the prompt stays well under 800 tokens, leaving >1000 tokens for generation.
    const historyLimit = 6;
    const historyQuery = conversationId
        ? `SELECT role, text FROM messages WHERE conversation_id = ? AND id != ? ORDER BY created_at DESC LIMIT ?`
        : `SELECT role, text FROM messages WHERE dot_id = ? AND id != ? ORDER BY created_at DESC LIMIT ?`;
    const historyParams = conversationId ? [conversationId, userMsg.id, historyLimit] : [dotId, userMsg.id, historyLimit];
    const historyRows = db.prepare(historyQuery).all(...historyParams);
    // Sanitize history to prevent pattern poisoning:
    // - Exclude repeated identical queries
    // - Exclude prior raw clause dumps or fallback messages
    // - Truncate older context so it fits safely within the local LLM window
    const cleanHistory = historyRows
        .reverse()
        .filter((m) => {
        if (m.role === "user" && m.text.trim().toLowerCase() === userText.trim().toLowerCase())
            return false;
        if (m.role === "dot" && (m.text.includes('(a) "information"') || m.text.includes("Legal Consultation Brief")))
            return false;
        return true;
    })
        .map((m) => {
        const textWithoutNotice = m.text.replace(/^> ⚖️[\s\S]*?---\n\n/, "").trim();
        return {
            role: (m.role === "dot" ? "assistant" : m.role === "user" ? "user" : "system"),
            content: textWithoutNotice.length > 400 ? textWithoutNotice.slice(0, 400) + "..." : textWithoutNotice,
        };
    });
    console.log(`\x1b[34m[AgentRuntime]\x1b[0m 📜 Context loaded: ${cleanHistory.length} sanitized historical messages for persona dotId=${dotId}`);
    // 3. Extract text content from any user-attached documents
    let attachedDocumentContext = "";
    if (attachments && attachments.length > 0) {
        for (const att of attachments) {
            const extracted = await extractTextFromFile(att.id);
            if (extracted.trim()) {
                attachedDocumentContext += `\n\n[USER ATTACHED DOCUMENT: ${att.name}]\n${extracted.trim()}\n[END OF ATTACHED DOCUMENT]`;
            }
        }
    }
    const abortController = new AbortController();
    runState.running = true;
    runState.abortController = abortController;
    runState.currentStep = 1;
    try {
        const openai = getLlmClient();
        // 0. Master Orchestrator task analysis & sub-agent routing
        const isMasterOrGeneral = dotId === "soli_master" ||
            dotId.includes("master") ||
            dotId.includes("soli") ||
            (!dotId.includes("vakil") && !dotId.includes("nyaya") && !dotId.includes("pramaan") && !dotId.includes("docket"));
        let routing = null;
        let targetSubAgent = dotId;
        if (isMasterOrGeneral) {
            routing = routeLegalTask(userText, attachments?.length || 0);
            targetSubAgent = routing.target;
            console.log(`\x1b[35m[MasterAgent]\x1b[0m ⚖️ Analyzed task -> Delegating to ${routing.name} (${routing.role}). Reason: ${routing.reason}`);
            emit({ type: "agent_routing", dotId, userId, data: routing });
        }
        // 1. Retrieve RAG context from vector legal corpus (Qdrant) and ingested vault
        const ragResult = await retrieveLegalContext(userText);
        if (ragResult) {
            console.log(`\x1b[32m[AgentRuntime]\x1b[0m 📚 Legal Vector RAG retrieved context (${ragResult.sources.length} sources, ${ragResult.contextText.length} chars)`);
            emit({
                type: "rag_context",
                dotId,
                userId,
                data: {
                    sources: ragResult.sources,
                    documentTitle: ragResult.documentTitle,
                },
            });
        }
        // Prepare system prompt tailored to the active sub-agent persona (Vakil, Nyaya, Pramaan, Docket)
        const personaPrompt = getAgentPersonaPrompt(dotId, targetSubAgent);
        let enhancedSystemPrompt = personaPrompt;
        if (ragResult) {
            enhancedSystemPrompt += `\n\n${ragResult.contextText}\n\nLEGAL COUNSEL DIRECTIVES FOR RETRIEVED STATUTES & PRECEDENTS:\n- Formulate your legal advice and drafting strictly grounded upon the statutory sections and judicial precedents provided above.\n- State exact sections (BNSS, BNS, BSA, CPC, NI Act), statutory ingredients, and relevant ratios.\n- Do NOT output synthetic platform banners or watermarks. Provide authentic courtroom counsel.`;
        }
        if (attachedDocumentContext) {
            enhancedSystemPrompt += `\n\nUSER UPLOADED ATTACHMENT CONTEXT:\nThe user has provided documents along with their query. Refer to the attached text below to analyze clauses, provide legal reviews, or answer questions directly based on the user's uploaded material:\n${attachedDocumentContext.slice(0, 6000)}`;
        }
        if (matter) {
            enhancedSystemPrompt += `\n\nCURRENT MATTER CONTEXT:\nMatter: ${matter.title}\nClient: ${matter.client || "Not recorded"}\nCourt / forum: ${matter.court || "Not recorded"}\nMatter notes: ${matter.notes || "None recorded"}\nKeep this matter context in mind, but do not invent facts not supplied by the user or sources.`;
        }
        // When RAG or attachments are injected, keep only recent turns to fit within context ceiling
        const activeHistory = ragResult || attachedDocumentContext ? cleanHistory.slice(-2) : cleanHistory;
        const messages = [
            {
                role: "system",
                content: enhancedSystemPrompt,
            },
            ...activeHistory,
            {
                role: "user",
                content: userText
            }
        ];
        const asstMsgId = `msg-${crypto.randomUUID()}`;
        const asstTime = Date.now();
        const asstMsg = {
            id: asstMsgId,
            dotId: dotId,
            dot_id: dotId,
            conversationId: conversationId || null,
            conversation_id: conversationId || null,
            role: "dot",
            text: "",
            createdAt: asstTime,
            created_at: asstTime,
        };
        let generatedContent = "";
        let reasoningBuffer = "";
        let hasReceivedContent = false;
        let assistantText = "";
        const llmStartTime = Date.now();
        let initialMessageEmitted = false;
        try {
            console.log(`\x1b[34m[AgentRuntime]\x1b[0m 🧠 Dispatching streaming LLM request to (${config.customLlmBaseUrl}) for sub-agent ${targetSubAgent}...`);
            const stream = await openai.chat.completions.create({
                model: config.customLlmModel,
                messages,
                temperature: 0.3,
                max_tokens: 1800,
                stream: true,
            }, { signal: abortController.signal, timeout: 120000 });
            for await (const chunk of stream) {
                const delta = chunk.choices[0]?.delta;
                const text = delta?.content || "";
                const reasoning = delta?.reasoning_content || "";
                if (reasoning) {
                    reasoningBuffer += reasoning;
                    if (!initialMessageEmitted) {
                        initialMessageEmitted = true;
                        assistantText = "*Analyzing statutory provisions and case records...*\n\n";
                        emit({ type: "message", dotId, userId, data: { ...asstMsg, text: assistantText } });
                    }
                }
                if (text) {
                    if (!hasReceivedContent) {
                        hasReceivedContent = true;
                        generatedContent += text;
                        assistantText = text;
                        initialMessageEmitted = true;
                        emit({ type: "message", dotId, userId, data: { ...asstMsg, text: assistantText } });
                    }
                    else {
                        generatedContent += text;
                        assistantText += text;
                        emit({ type: "message_delta", id: asstMsgId, dotId, userId, delta: text });
                    }
                }
            }
            // If the model generated all its response into reasoning_content without transitioning to content:
            if (!hasReceivedContent && reasoningBuffer.trim()) {
                console.log(`\x1b[33m[AgentRuntime] ℹ️ Model output was in reasoning_content (${reasoningBuffer.length} chars). Promoting to answer.\x1b[0m`);
                generatedContent = reasoningBuffer.trim();
                assistantText = generatedContent;
                if (!initialMessageEmitted) {
                    initialMessageEmitted = true;
                    emit({ type: "message", dotId, userId, data: { ...asstMsg, text: assistantText } });
                }
                else {
                    emit({ type: "message_delta", id: asstMsgId, dotId, userId, delta: generatedContent });
                }
            }
            console.log(`\x1b[34m[AgentRuntime]\x1b[0m ⚡ LLM streaming completed in ${Date.now() - llmStartTime}ms (${assistantText.length} chars)`);
        }
        catch (llmErr) {
            if (llmErr.name === "AbortError" || abortController.signal.aborted) {
                throw llmErr;
            }
            console.error(`\x1b[31m[AgentRuntime] ❌ LLM Inference Error:\x1b[0m`, llmErr.message);
            // If context exceeded the LLM's context size, retry with isolated query
            const isContextOverflow = llmErr.status === 400 ||
                llmErr.message?.includes("exceeds the available context size") ||
                llmErr.message?.includes("context size");
            if (isContextOverflow) {
                console.warn(`\x1b[33m[AgentRuntime] ⚠️ Context overflow (${llmErr.message}). Retrying with isolated prompt...\x1b[0m`);
                try {
                    const retryStream = await openai.chat.completions.create({
                        model: config.customLlmModel,
                        messages: [
                            messages[0], // system prompt
                            { role: "user", content: userText }
                        ],
                        temperature: 0.3,
                        max_tokens: 1800,
                        stream: true,
                    }, { signal: abortController.signal, timeout: 120000 });
                    for await (const chunk of retryStream) {
                        const delta = chunk.choices[0]?.delta;
                        const text = delta?.content || "";
                        const reasoning = delta?.reasoning_content || "";
                        if (reasoning)
                            reasoningBuffer += reasoning;
                        if (text) {
                            if (!hasReceivedContent) {
                                hasReceivedContent = true;
                                generatedContent += text;
                                assistantText = text;
                                initialMessageEmitted = true;
                                emit({ type: "message", dotId, userId, data: { ...asstMsg, text: assistantText } });
                            }
                            else {
                                generatedContent += text;
                                assistantText += text;
                                emit({ type: "message_delta", id: asstMsgId, dotId, userId, delta: text });
                            }
                        }
                    }
                    if (!hasReceivedContent && reasoningBuffer.trim()) {
                        generatedContent = reasoningBuffer.trim();
                        assistantText = generatedContent;
                        if (!initialMessageEmitted) {
                            initialMessageEmitted = true;
                            emit({ type: "message", dotId, userId, data: { ...asstMsg, text: assistantText } });
                        }
                        else {
                            emit({ type: "message_delta", id: asstMsgId, dotId, userId, delta: generatedContent });
                        }
                    }
                }
                catch (retryErr) {
                    console.warn(`[AgentRuntime] Retry also failed:`, retryErr.message);
                }
            }
            if (!generatedContent.trim()) {
                console.warn(`\x1b[33m[AgentRuntime] ⚠️ LLM inference node offline at ${config.customLlmBaseUrl} (${llmErr.message}). Engaging Lirava Legal Knowledge Engine fallback.\x1b[0m`);
                const fallbackText = generateLegalResponse(userText);
                assistantText = fallbackText;
                const words = assistantText.split(" ");
                const firstChunk = words.slice(0, 3).join(" ") + (words.length > 3 ? " " : "");
                if (!initialMessageEmitted) {
                    initialMessageEmitted = true;
                    emit({ type: "message", dotId, userId, data: { ...asstMsg, text: firstChunk } });
                }
                else {
                    emit({ type: "message_delta", id: asstMsgId, dotId, userId, delta: firstChunk });
                }
                for (let i = 3; i < words.length; i += 3) {
                    if (abortController.signal.aborted)
                        break;
                    const slice = words.slice(i, i + 3).join(" ") + (i + 3 < words.length ? " " : "");
                    emit({ type: "message_delta", id: asstMsgId, dotId, userId, delta: slice });
                    await new Promise((r) => setTimeout(r, 10));
                }
            }
        }
        if (!assistantText) {
            console.warn(`\x1b[33m[AgentRuntime] ⚠️ LLM returned empty response. Engaging Lirava Legal Knowledge Engine fallback.\x1b[0m`);
            const fallbackText = generateLegalResponse(userText);
            assistantText = fallbackText;
            if (!initialMessageEmitted) {
                emit({ type: "message", dotId, userId, data: { ...asstMsg, text: assistantText } });
            }
            else {
                emit({ type: "message_delta", id: asstMsgId, dotId, userId, delta: assistantText });
            }
        }
        asstMsg.text = assistantText;
        db.prepare(`
      INSERT INTO messages (id, dot_id, conversation_id, role, text, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(asstMsg.id, asstMsg.dotId, asstMsg.conversationId ?? null, asstMsg.role, asstMsg.text, asstMsg.createdAt);
        emit({ type: "message", dotId, userId, data: asstMsg });
        emit({ type: "dot_status", dotId, userId, data: { status: "idle" } });
        runState.running = false;
        runState.abortController = null;
        return { userMessage: userMsg, assistantMessage: asstMsg };
    }
    catch (err) {
        runState.running = false;
        runState.abortController = null;
        emit({ type: "dot_status", dotId, userId, data: { status: "idle" } });
        if (err.name === "AbortError") {
            return { userMessage: userMsg };
        }
        throw err;
    }
}
