process.env.NODE_ENV = "test";

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  endAtSentence,
  estimateTokens,
  fitPrompt,
  safetyTokens,
  shrinkMiddle,
  shrinkText,
  windowFromError,
  type ChatTurn,
  type PromptSection,
} from "../src/services/agent/context-budget.js";

const WINDOW = 8192;
const ANSWER = 1500;
const words = (n: number, w = "bail") => Array.from({ length: n }, () => w).join(" ");

const persona: PromptSection = { id: "persona", text: "You are Lirava. " + words(300, "counsel"), shedOrder: 100 };
const sectionsWorstCase = (): PromptSection[] => [
  persona,
  { id: "statutes", text: "STATUTES\n" + words(900, "provision"), tail: "DIRECTIVES: cite exact sections.", floorTokens: 350, shedOrder: 50 },
  { id: "documents", text: "DOCS\n" + words(900, "excerpt"), tail: "HOW TO USE: cite [D1].", floorTokens: 300, shedOrder: 40 },
  { id: "attachments", text: "ATTACHED\n" + words(2500, "clause"), floorTokens: 250, shedOrder: 20 },
  { id: "matter", text: "MATTER\n" + words(500, "notes"), tail: "Keep this in mind.", floorTokens: 120, shedOrder: 30 },
  { id: "summary", text: "SUMMARY\n" + words(600, "fact"), floorTokens: 150, shedOrder: 35 },
];
const longHistory = (turns: number): ChatTurn[] =>
  Array.from({ length: turns }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: `message ${i} ${words(400, "history")}` }) as ChatTurn);

describe("token estimate", () => {
  it("counts non-Latin text as more expensive per character, and never undercounts English by much", () => {
    assert.equal(estimateTokens(""), 0);
    const english = words(1000, "bail");
    assert.ok(estimateTokens(english) >= english.length / 4, "no fewer tokens than 4 characters each");
    const hindi = "जमानत".repeat(200);
    assert.ok(estimateTokens(hindi) / hindi.length > estimateTokens(english) / english.length, "Hindi costs more per character");
  });
});

describe("fitting a prompt into the model's window", () => {
  it("always leaves room for the whole answer, even when every part is huge", () => {
    const fit = fitPrompt({ sections: sectionsWorstCase(), history: longHistory(30), userText: "What is the bail position? " + words(200), windowTokens: WINDOW, answerTokens: ANSWER });
    assert.ok(fit.promptTokens + ANSWER + safetyTokens(WINDOW) <= WINDOW, `prompt ${fit.promptTokens} + answer ${ANSWER} must fit ${WINDOW}`);
    assert.ok(fit.maxAnswerTokens >= ANSWER, "the full answer allowance is still available");
  });

  it("keeps the newest chat messages and drops the oldest whole, starting on a user turn", () => {
    const history = longHistory(30);
    const fit = fitPrompt({ sections: [persona], history, userText: "next question", windowTokens: WINDOW, answerTokens: ANSWER });
    const kept = fit.messages.slice(1, -1);
    assert.ok(kept.length > 0 && kept.length < history.length, `kept ${kept.length} of ${history.length}`);
    assert.equal(kept[0].role, "user");
    assert.equal(kept.at(-1)!.content, history.at(-1)!.content, "the newest message is kept");
    assert.ok(history.some((m) => m.content === kept[0].content), "messages are whole, not cut");
    assert.equal(fit.droppedHistory, history.length - kept.length);
  });

  it("keeps all the history when it fits", () => {
    const history = longHistory(4).map((m) => ({ ...m, content: "short message" }));
    const fit = fitPrompt({ sections: [persona], history, userText: "q", windowTokens: WINDOW, answerTokens: ANSWER });
    assert.equal(fit.droppedHistory, 0);
    assert.equal(fit.messages.length, history.length + 2);
  });

  it("shortens the least important parts first and never cuts the instructions or the rules after a source", () => {
    const sections = sectionsWorstCase();
    const fit = fitPrompt({ sections, history: [], userText: "q", windowTokens: 4096, answerTokens: ANSWER });
    const system = fit.messages[0].content;
    assert.ok(fit.shortened.includes("attachments"), "attachments go first");
    assert.ok(fit.shortened.indexOf("attachments") < (fit.shortened.indexOf("statutes") === -1 ? 99 : fit.shortened.indexOf("statutes")));
    for (const keep of ["You are Lirava.", "DIRECTIVES: cite exact sections.", "HOW TO USE: cite [D1].", "Keep this in mind."]) assert.ok(system.includes(keep), `kept: ${keep}`);
    assert.ok(fit.promptTokens + ANSWER + safetyTokens(4096) <= 4096 + 400, "and it still fits (within the margin the floors allow)");
  });

  it("does not touch anything that already fits", () => {
    const fit = fitPrompt({ sections: [persona, { id: "matter", text: "MATTER short", shedOrder: 30 }], history: [], userText: "q", windowTokens: WINDOW, answerTokens: ANSWER });
    assert.deepEqual(fit.shortened, []);
    assert.equal(fit.userTextShortened, false);
  });

  it("caps a pasted wall of text but keeps its start and end, and tells the model", () => {
    const huge = "START-OF-MESSAGE " + words(20000) + " THE-ACTUAL-QUESTION-IS-HERE?";
    const fit = fitPrompt({ sections: [persona], history: [], userText: huge, windowTokens: WINDOW, answerTokens: ANSWER });
    const user = fit.messages.at(-1)!.content;
    assert.ok(user.startsWith("START-OF-MESSAGE") && user.endsWith("THE-ACTUAL-QUESTION-IS-HERE?"));
    assert.match(user, /middle of this message was left out/);
    assert.equal(fit.userTextShortened, true);
    assert.match(fit.messages[0].content, /latest message was longer than the model can read/);
    assert.ok(fit.promptTokens + ANSWER <= WINDOW);
  });

  it("minimal mode drops the history", () => {
    const fit = fitPrompt({ sections: sectionsWorstCase(), history: longHistory(10), userText: "q", windowTokens: 3000, answerTokens: 900, minimal: true });
    assert.equal(fit.messages.length, 2);
    assert.equal(fit.droppedHistory, 10);
  });
});

describe("helpers", () => {
  it("shrinkText and shrinkMiddle reduce to about the target", () => {
    const text = words(2000);
    assert.ok(estimateTokens(shrinkText(text, 300)) <= 330);
    assert.ok(estimateTokens(shrinkMiddle(text, 300)) <= 330);
    assert.equal(shrinkText("short", 300), "short");
  });

  it("learns the real window from the server's error message", () => {
    assert.equal(windowFromError("request (9020 tokens) exceeds the available context size (8192 tokens), try increasing it"), 8192);
    assert.equal(windowFromError('{"n_ctx": 4096, "n_prompt_tokens": 5000}'), 4096);
    assert.equal(windowFromError("some other 400"), null);
    assert.equal(windowFromError(undefined), null);
  });

  it("ends a cut-off answer at the last full sentence", () => {
    assert.equal(endAtSentence("The bail was granted. The court then obs"), "The bail was granted.");
    assert.equal(endAtSentence("Complete sentence."), "Complete sentence.");
    assert.equal(endAtSentence("no sentence break at all here"), "no sentence break at all here");
  });
});
