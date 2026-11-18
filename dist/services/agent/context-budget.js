/**
 * Keeps every request inside the model's context window, so an answer is never refused or cut off because
 * the prompt was too long.
 *
 * One request has to fit: system prompt + conversation summary + recent messages + the question + the answer.
 * The answer's room is reserved first. What is left is the prompt budget, and when the pieces do not fit they
 * are shortened from the least important to the most important:
 *   old chat messages -> attachment text -> matter notes -> chat summary -> document excerpts -> statutes.
 * The instructions, the closing directives of each block and the user's question are never dropped.
 */
/** Rough token count. Deliberately a little high: being over-careful costs a few words, being under-careful cuts an answer. */
export function estimateTokens(text) {
    if (!text)
        return 0;
    let ascii = 0;
    let other = 0;
    for (let i = 0; i < text.length; i++) {
        if (text.charCodeAt(i) < 128)
            ascii++;
        else
            other++;
    }
    // English legal text runs about 4 characters per token; digits, punctuation and section numbers run lower.
    // Devanagari and other scripts cost close to a token per character in current tokenizers.
    return Math.ceil(ascii / 3.3 + other * 0.9);
}
const MESSAGE_OVERHEAD = 8;
const TEMPLATE_TOKENS = 4;
const tokensOf = (text) => estimateTokens(text) + MESSAGE_OVERHEAD;
/** Cuts text down to about `targetTokens`, at a line or word break, and says it was cut. */
export function shrinkText(text, targetTokens, note = "\n…[shortened to fit]") {
    if (estimateTokens(text) <= targetTokens)
        return text;
    const perChar = estimateTokens(text) / Math.max(1, text.length);
    let end = Math.max(0, Math.floor(targetTokens / perChar) - note.length);
    if (end <= 0)
        return "";
    let cut = text.slice(0, end);
    const lastBreak = Math.max(cut.lastIndexOf("\n"), cut.lastIndexOf(". "), cut.lastIndexOf(" "));
    if (lastBreak > end * 0.6)
        cut = cut.slice(0, lastBreak);
    return cut.trimEnd() + note;
}
/** Keeps the start and the end of a very long message (the question is often at the end) and drops the middle. */
export function shrinkMiddle(text, targetTokens) {
    if (estimateTokens(text) <= targetTokens)
        return text;
    const note = "\n\n[… the middle of this message was left out to fit the model's limit …]\n\n";
    const perChar = estimateTokens(text) / Math.max(1, text.length);
    const keep = Math.max(0, Math.floor(targetTokens / perChar) - note.length);
    const head = Math.floor(keep * 0.6);
    const tail = keep - head;
    return text.slice(0, head).trimEnd() + note + text.slice(text.length - tail).trimStart();
}
const sectionText = (s) => (s.tail ? `${s.text}\n\n${s.tail}` : s.text);
const joinSections = (sections) => sections.map(sectionText).filter((t) => t.trim()).join("\n\n");
/** A safety margin: the estimate is not exact, and the server adds a few template tokens of its own. */
export const safetyTokens = (windowTokens) => Math.max(200, Math.floor(windowTokens * 0.04));
export function fitPrompt(input) {
    const { windowTokens, answerTokens } = input;
    // The final +4 is the chat template's own tokens, counted once in promptTokens below.
    const budget = Math.max(512, windowTokens - answerTokens - safetyTokens(windowTokens) - TEMPLATE_TOKENS);
    const sections = input.sections.map((s) => ({ ...s }));
    const shortened = [];
    // The user's message: never dropped, but a pasted document cannot take the whole window.
    const userCap = Math.floor(budget * 0.45);
    let userText = input.userText;
    let userTextShortened = false;
    if (estimateTokens(userText) > userCap) {
        userText = shrinkMiddle(userText, userCap);
        userTextShortened = true;
        sections.push({
            id: "user-note",
            text: "NOTE: the user's latest message was longer than the model can read at once, so its middle part was left out. Say so briefly and ask the user to send the missing part in a shorter message if it matters.",
            shedOrder: 99,
        });
    }
    const systemTokens = () => tokensOf(joinSections(sections));
    const fixed = () => systemTokens() + tokensOf(userText);
    // 1. Shorten sections, least important first, only as far as needed.
    const byShed = [...sections].sort((a, b) => a.shedOrder - b.shedOrder);
    const history = input.minimal ? [] : [...input.history];
    // Recent chat messages are kept as far as the budget allows once the sections are settled, so shorten sections
    // only when even an empty history does not fit.
    const shrinkSections = (limit) => {
        for (const s of byShed) {
            const over = fixed() - limit;
            if (over <= 0)
                return;
            const floor = input.minimal ? Math.min(s.floorTokens ?? 0, 300) : s.floorTokens ?? 0;
            const own = estimateTokens(s.text);
            if (own <= floor)
                continue;
            const target = Math.max(floor, own - over);
            const next = target <= 0 ? "" : shrinkText(s.text, target);
            if (next !== s.text) {
                s.text = next;
                shortened.push(s.id);
            }
        }
    };
    shrinkSections(budget);
    // 2. Fill what is left with the newest chat messages (never half a message: older ones are dropped whole).
    const room = budget - fixed();
    const kept = [];
    let used = 0;
    for (let i = history.length - 1; i >= 0; i--) {
        const cost = tokensOf(history[i].content);
        if (used + cost > room)
            break;
        kept.unshift(history[i]);
        used += cost;
    }
    // The conversation has to start with a user turn for most chat templates.
    while (kept.length && kept[0].role !== "user")
        kept.shift();
    const droppedHistory = input.history.length - kept.length;
    const messages = [
        { role: "system", content: joinSections(sections) },
        ...kept,
        { role: "user", content: userText },
    ];
    const promptTokens = messages.reduce((n, m) => n + tokensOf(m.content), 0) + TEMPLATE_TOKENS;
    return {
        messages,
        promptTokens,
        maxAnswerTokens: Math.max(0, Math.min(answerTokens, windowTokens - promptTokens - safetyTokens(windowTokens))),
        droppedHistory: input.minimal ? input.history.length : droppedHistory,
        shortened,
        userTextShortened,
    };
}
/** The server's own message names the real limit ("exceeds the available context size (8192 tokens)"); learn it. */
export function windowFromError(message) {
    const m = /context size \((\d+) tokens?\)/i.exec(message ?? "") || /n_ctx["':\s]+(\d+)/i.exec(message ?? "");
    const n = m ? Number(m[1]) : NaN;
    return Number.isFinite(n) && n >= 1024 ? n : null;
}
/** Ends a cut-off answer at the last full sentence instead of in the middle of a word. */
export function endAtSentence(text) {
    const trimmed = text.trimEnd();
    if (/[.!?।:)\]"”]$/.test(trimmed))
        return trimmed;
    const tailStart = Math.max(0, trimmed.length - 400);
    const tail = trimmed.slice(tailStart);
    const idx = Math.max(tail.lastIndexOf(". "), tail.lastIndexOf(".\n"), tail.lastIndexOf("? "), tail.lastIndexOf("।"), tail.lastIndexOf("\n\n"));
    return idx >= 0 ? trimmed.slice(0, tailStart + idx + 1).trimEnd() : trimmed;
}
export const CONTINUE_PROMPT = "Continue exactly where you stopped. Do not repeat anything already written, do not apologise and do not add an introduction. Finish the answer.";
export const CUT_OFF_NOTICE = "\n\n*This answer reached the model's length limit and was shortened. Reply \"continue\" to get the rest.*";
