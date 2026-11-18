import { Hono } from "hono";
import {
  deleteArtifactForUser,
  findDuplicateArtifact,
  getArtifactForUser,
  listArtifacts,
  saveArtifact,
  updateArtifactForUser,
} from "../services/repo/index.js";
import { generateDocumentDocx, generateDocumentPdf, UnsupportedTextError } from "../services/legal/documents.js";
import { saveFile } from "../services/files/index.js";
import { getConversation } from "../services/chats/store.js";
import { requireAuth, type AuthEnv } from "../middleware/auth.js";
import { contentDisposition } from "../services/files/http.js";

export const artifactsRoutes = new Hono<AuthEnv>();

artifactsRoutes.use("*", requireAuth);

const MAX_CONTENT_CHARS = 500_000;

artifactsRoutes.get("/", async (c) => {
  const userId = c.get("user").id;
  const artifacts = await listArtifacts(userId, { agentOnly: c.req.query("agentOnly") === "true" });
  return c.json({ artifacts });
});

artifactsRoutes.post("/", async (c) => {
  const userId = c.get("user").id;
  try {
    const body = await c.req.json();
    const title: string = (typeof body.title === "string" && body.title.trim() ? body.title.trim() : "Legal Document").slice(0, 200);
    const content: string = typeof body.content === "string" ? body.content : "";
    const vakilId: string = typeof body.vakilId === "string" && body.vakilId ? body.vakilId : "vakil_dev";
    const conversationId: string | null = typeof body.conversationId === "string" && body.conversationId ? body.conversationId : null;
    if (!content.trim()) return c.json({ error: "A document needs some content." }, 400);
    if (content.length > MAX_CONTENT_CHARS) return c.json({ error: "This document is too large to save." }, 413);

    // A document can only be attached to a chat the user owns.
    if (conversationId && !(await getConversation(conversationId, userId))) {
      return c.json({ error: "Conversation not found." }, 404);
    }

    // Saving the same document again returns the saved copy instead of creating duplicates.
    const existing = await findDuplicateArtifact(userId, conversationId, title, content);
    if (existing) return c.json({ success: true, artifact: existing });

    const filename = `${title.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 50) || "document"}.pdf`;

    // Generate the PDF up front so preview and download work immediately. Text the PDF can't
    // render (for example Hindi) is still saved: the Word version carries it in full.
    let pdfFileId: string | null = null;
    try {
      const pdfBytes = await generateDocumentPdf({ title, content });
      pdfFileId = (await saveFile(vakilId, filename, "application/pdf", Buffer.from(pdfBytes), userId)).id;
    } catch (pdfErr) {
      if (!(pdfErr instanceof UnsupportedTextError)) console.warn("[artifacts] Could not generate PDF:", pdfErr);
    }

    const artifact = await saveArtifact({
      vakilId,
      conversationId,
      title,
      content,
      filename,
      kind: typeof body.kind === "string" ? body.kind : undefined,
      summary: typeof body.summary === "string" ? body.summary.slice(0, 500) : undefined,
      pdfFileId,
      userId,
    });
    return c.json({ success: true, artifact });
  } catch (err) {
    console.error("[artifacts] save failed:", err);
    return c.json({ error: "Could not save the document." }, 500);
  }
});

artifactsRoutes.get("/:id", async (c) => {
  const artifact = await getArtifactForUser(c.req.param("id"), c.get("user").id);
  if (!artifact) return c.json({ error: "Artifact not found" }, 404);
  return c.json({ artifact });
});

// The user edits a document or plan in the editor: the new text (and title) is saved.
artifactsRoutes.patch("/:id", async (c) => {
  const userId = c.get("user").id;
  const existing = await getArtifactForUser(c.req.param("id"), userId);
  if (!existing) return c.json({ error: "Artifact not found" }, 404);
  try {
    const body = await c.req.json();
    const content: string | undefined = typeof body.content === "string" ? body.content : undefined;
    const title: string | undefined = typeof body.title === "string" && body.title.trim() ? body.title.trim().slice(0, 200) : undefined;
    if (content !== undefined && !content.trim()) return c.json({ error: "A document needs some content." }, 400);
    if (content && content.length > MAX_CONTENT_CHARS) return c.json({ error: "This document is too large to save." }, 413);

    // No PDF is stored here: the download is built from the current text by the export route, so it always
    // includes the latest edits and an autosave never piles up files.
    const artifact = await updateArtifactForUser(existing.id, userId, { title, content });
    return c.json({ success: true, artifact });
  } catch (err) {
    console.error("[artifacts] update failed:", err);
    return c.json({ error: "Could not save your changes." }, 500);
  }
});

artifactsRoutes.delete("/:id", async (c) => {
  if (!(await deleteArtifactForUser(c.req.param("id"), c.get("user").id))) return c.json({ error: "Artifact not found" }, 404);
  return c.json({ success: true });
});

artifactsRoutes.get("/:id/export", async (c) => {
  const artifact = await getArtifactForUser(c.req.param("id"), c.get("user").id);
  if (!artifact) return c.json({ error: "Artifact not found" }, 404);
  const format = c.req.query("format") === "docx" ? "docx" : "pdf";
  const base = artifact.title || "document";

  try {
    if (format === "docx") {
      const docx = await generateDocumentDocx({ title: artifact.title, content: artifact.content });
      return new Response(new Uint8Array(docx), {
        headers: {
          "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          "Content-Disposition": contentDisposition("attachment", `${base}.docx`),
          "X-Content-Type-Options": "nosniff",
          "Cache-Control": "private, no-store",
        },
      });
    }
    const pdf = await generateDocumentPdf({ title: artifact.title, content: artifact.content });
    return new Response(new Uint8Array(pdf), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": contentDisposition("attachment", `${base}.pdf`),
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
      },
    });
  } catch (err) {
    if (err instanceof UnsupportedTextError) return c.json({ error: err.message, alternative: "docx" }, 422);
    console.error("[artifacts] export failed:", err);
    return c.json({ error: "Could not generate the document." }, 500);
  }
});
