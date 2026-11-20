import { Hono } from "hono";
import { requireAuth, type AuthEnv } from "../middleware/auth.js";
import { config } from "../config.js";
import { saveFile } from "../services/files/index.js";
import { checkUpload } from "../services/files/http.js";
import { indexDocument, type IndexResult } from "../services/documents/index.js";
import { getConversation } from "../services/chats/store.js";
import { matterOwned } from "../services/data/pg.js";
import {
  MAX_ATTACHED_PER_SCOPE,
  MAX_FILES_PER_BASE,
  MAX_KNOWLEDGE_BASES,
  addFile,
  canAddFile,
  createKnowledgeBase,
  deleteKnowledgeBase,
  getKnowledgeBase,
  isLinkScope,
  listKnowledgeBases,
  listLinks,
  removeFile,
  setLinks,
  updateKnowledgeBase,
} from "../services/knowledge-bases/index.js";

export const knowledgeBasesRoutes = new Hono<AuthEnv>();

knowledgeBasesRoutes.use("*", requireAuth);

const MAX_FILES_PER_UPLOAD = 10;
const TRY_AGAIN = "Could not reach your knowledge bases. Please try again.";

const fail = (c: { json: (b: unknown, s: 500) => Response }, err: unknown) => {
  console.error("[knowledge-bases] failed:", err);
  return c.json({ error: TRY_AGAIN }, 500);
};

/** Whether the chat or matter exists and is the user's. Someone else's looks like one that does not exist. */
async function scopeOwned(scope: "conversation" | "matter", id: string, userId: string): Promise<boolean> {
  return scope === "matter" ? matterOwned(id, userId) : Boolean(await getConversation(id, userId));
}

knowledgeBasesRoutes.get("/", async (c) => {
  try {
    return c.json({ knowledgeBases: await listKnowledgeBases(c.get("user").id) });
  } catch (err) {
    return fail(c, err);
  }
});

knowledgeBasesRoutes.post("/", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { name?: unknown; description?: unknown } | null;
  try {
    const result = await createKnowledgeBase(c.get("user").id, body?.name, body?.description);
    if (result === "full") return c.json({ error: `You can keep up to ${MAX_KNOWLEDGE_BASES} knowledge bases. Delete one to add another.` }, 409);
    if (!result) return c.json({ error: "Give the knowledge base a name." }, 400);
    return c.json({ knowledgeBase: result }, 201);
  } catch (err) {
    return fail(c, err);
  }
});

/** What is attached to one chat or matter. Declared before "/:id" so "links" is not read as an id. */
knowledgeBasesRoutes.get("/links", async (c) => {
  const userId = c.get("user").id;
  const scope = c.req.query("scope");
  const id = c.req.query("id") || "";
  if (!isLinkScope(scope) || !id) return c.json({ error: "scope and id are required." }, 400);
  try {
    if (!(await scopeOwned(scope, id, userId))) return c.json({ error: "Not found." }, 404);
    return c.json({ knowledgeBases: await listLinks(userId, scope, id) });
  } catch (err) {
    return fail(c, err);
  }
});

knowledgeBasesRoutes.put("/links", async (c) => {
  const userId = c.get("user").id;
  const body = (await c.req.json().catch(() => null)) as { scope?: unknown; id?: unknown; knowledgeIds?: unknown } | null;
  if (!isLinkScope(body?.scope) || typeof body?.id !== "string" || !body.id) return c.json({ error: "scope and id are required." }, 400);
  try {
    if (!(await scopeOwned(body.scope, body.id, userId))) return c.json({ error: "Not found." }, 404);
    const result = await setLinks(userId, body.scope, body.id, body.knowledgeIds);
    if (result === "too-many") return c.json({ error: `Attach at most ${MAX_ATTACHED_PER_SCOPE} knowledge bases.` }, 400);
    if (result === "invalid") return c.json({ error: "One of those knowledge bases was not found." }, 404);
    return c.json({ knowledgeBases: result });
  } catch (err) {
    return fail(c, err);
  }
});

knowledgeBasesRoutes.get("/:id", async (c) => {
  try {
    const base = await getKnowledgeBase(c.get("user").id, c.req.param("id"));
    return base ? c.json({ knowledgeBase: base }) : c.json({ error: "Knowledge base not found." }, 404);
  } catch (err) {
    return fail(c, err);
  }
});

knowledgeBasesRoutes.put("/:id", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { name?: unknown; description?: unknown } | null;
  try {
    const base = await updateKnowledgeBase(c.get("user").id, c.req.param("id"), { name: body?.name, description: body?.description });
    return base ? c.json({ knowledgeBase: base }) : c.json({ error: "Knowledge base not found, or the name is empty." }, 404);
  } catch (err) {
    return fail(c, err);
  }
});

knowledgeBasesRoutes.delete("/:id", async (c) => {
  try {
    return (await deleteKnowledgeBase(c.get("user").id, c.req.param("id"))) ? c.json({ success: true }) : c.json({ error: "Knowledge base not found." }, 404);
  } catch (err) {
    return fail(c, err);
  }
});

/** Upload documents into a base: stored, read page by page and indexed, so they can be searched and cited. */
knowledgeBasesRoutes.post("/:id/files", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  try {
    const allowed = await canAddFile(user.id, id);
    if (allowed === "missing") return c.json({ error: "Knowledge base not found." }, 404);
    if (allowed === "full") return c.json({ error: `A knowledge base can hold up to ${MAX_FILES_PER_BASE} files.` }, 409);

    const formData = await c.req.formData();
    const rawFiles = formData.getAll("file").filter((item): item is File => typeof item === "object" && item !== null && "arrayBuffer" in item);
    if (!rawFiles.length) return c.json({ error: "No file was provided." }, 400);
    if (rawFiles.length > MAX_FILES_PER_UPLOAD) return c.json({ error: `Upload at most ${MAX_FILES_PER_UPLOAD} files at a time.` }, 400);

    const added: Array<{ id: string; name: string; size: number; index: IndexResult }> = [];
    for (const file of rawFiles) {
      if (file.size > config.maxUploadBytes) {
        return c.json({ error: `${file.name || "File"} is larger than ${Math.round(config.maxUploadBytes / 1024 / 1024)} MB.` }, 413);
      }
      const buffer = Buffer.from(await file.arrayBuffer());
      const name = file.name || "uploaded_file";
      const check = checkUpload(name, buffer);
      if (!check.ok) return c.json({ error: check.reason }, 415);
      // The type comes from our own allowlist, not from what the browser claimed.
      const saved = await saveFile(id, name, check.mime, buffer, user.id);
      const index = await indexDocument({ userId: user.id, fileId: saved.id, name: saved.name, mime: saved.mime, buffer }).catch(
        (): IndexResult => ({ status: "failed", pages: 0, chunks: 0, unit: "page", note: "The file was saved but could not be indexed." }),
      );
      await addFile(user.id, id, saved.id);
      added.push({ id: saved.id, name: saved.name, size: saved.size, index });
    }
    return c.json({ files: added });
  } catch (err) {
    return fail(c, err);
  }
});

knowledgeBasesRoutes.delete("/:id/files/:fileId", async (c) => {
  try {
    return (await removeFile(c.get("user").id, c.req.param("id"), c.req.param("fileId"))) ? c.json({ success: true }) : c.json({ error: "File not found." }, 404);
  } catch (err) {
    return fail(c, err);
  }
});
