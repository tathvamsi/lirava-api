/**
 * Turns a finished answer into a saved artifact: a plan (artifact mode) or a legal document (document editor
 * mode). The artifact remembers which chat message it came from, so the chat can show it as a card in place of
 * the long text. Saving never holds the answer back: any failure just leaves the answer as ordinary chat text.
 */
import { saveArtifact } from "../repo/index.js";
import { generateDocumentPdf, UnsupportedTextError } from "../legal/documents.js";
import { saveFile } from "../files/index.js";
import { cleanOutput, modeDirective, type OutputMode } from "./output-mode.js";
import { documentTitle, tidyDocument } from "./document-layout.js";
import { getLlmClient } from "./client.js";
import { activeProvider, llmModel } from "./providers.js";

/** Shorter than this is a reply, not a document or a plan. */
const MIN_CHARS = 400;

/** The small model sometimes answers a request for a document with "please share the section first". */
export function looksLikeRefusal(text: string): boolean {
  const t = text.trim();
  if (t.length === 0 || t.length > 700) return false;
  return /\b(can(?:'|no)t|can not|unable to|won't be able to|not able to)\b[^.]{0,60}\b(draft|prepare|write|proceed|work|create|provide)\b|\bplease (?:share|provide|tell me|specify|run)\b|\bwithout (?:knowing|the specific|more)\b|\bI need (?:the|more|to know)\b/i.test(t);
}

/**
 * One more try at the work when the model refused it: a short prompt with no search results (they are what the
 * model over-trusts), an explicit order to write it with placeholders, and a low temperature. Null on any failure.
 */
export async function writeWithoutRefusing(input: { mode: OutputMode; task: string; persona: string; signal?: AbortSignal }): Promise<string | null> {
  try {
    const response = await getLlmClient().chat.completions.create(
      {
        model: llmModel(),
        messages: [
          {
            role: "system",
            content: `${input.persona}\n\n${modeDirective(input.mode)}\n\nYou must write the ${input.mode === "plan" ? "plan" : "document"} now. Never refuse, never say you need more information, and never ask the user to share a section or an Act. Use [PLACEHOLDERS] for any fact you do not have. Name an Act or section only when you are certain of it; otherwise leave it as a placeholder such as [SECTION].`,
          },
          { role: "user", content: input.task },
        ],
        temperature: 0.3,
        max_tokens: activeProvider().answerMax,
      },
      { signal: input.signal, timeout: 120000 },
    );
    const text = response.choices[0]?.message?.content?.trim() ?? "";
    if (text.length >= MIN_CHARS && !looksLikeRefusal(text)) return text;
    console.log(`[Output] the second try gave no usable ${input.mode} (${text.length} chars): ${text.slice(0, 160).replace(/\s+/g, " ")}`);
    return null;
  } catch (err) {
    console.warn("[artifact-output] the second try failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

export async function createOutputArtifact(input: {
  mode: OutputMode;
  text: string;
  userId: string;
  vakilId: string;
  conversationId: string;
  messageId: string;
  /** What the user asked for, and the matter it belongs to: they name the paper better than its opening words do. */
  request?: string;
  matterTitle?: string | null;
}): Promise<{ id: string } | null> {
  try {
    const content = tidyDocument(cleanOutput(input.text));
    if (content.length < MIN_CHARS) return null;
    const title = documentTitle({ content, mode: input.mode, request: input.request, matterTitle: input.matterTitle });
    const filename = `${title.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 50) || "document"}.pdf`;

    // A document gets its PDF up front so it can be downloaded at once; a plan is read on screen.
    let pdfFileId: string | null = null;
    if (input.mode === "document") {
      try {
        const bytes = await generateDocumentPdf({ title, content });
        pdfFileId = (await saveFile(input.vakilId, filename, "application/pdf", Buffer.from(bytes), input.userId)).id;
      } catch (err) {
        if (!(err instanceof UnsupportedTextError)) console.warn("[artifact-output] could not make the PDF:", err instanceof Error ? err.message : err);
      }
    }

    const artifact = await saveArtifact({
      vakilId: input.vakilId,
      conversationId: input.conversationId,
      title,
      filename,
      kind: input.mode === "plan" ? "plan" : "legal_paper",
      content,
      summary: input.mode === "plan" ? `Plan: ${title}` : `Legal document: ${title}`,
      metadata: { messageId: input.messageId, mode: input.mode },
      pdfFileId,
      userId: input.userId,
    });
    return { id: artifact.id };
  } catch (err) {
    console.warn("[artifact-output] could not save the artifact:", err instanceof Error ? err.message : err);
    return null;
  }
}
