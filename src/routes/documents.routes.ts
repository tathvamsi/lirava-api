import { Hono } from "hono";
import { matterOwned } from "../services/data/pg.js";
import { listMatterDocuments, setDocumentKind } from "../services/documents/index.js";
import { DOC_KIND_LABEL, isDocKind } from "../services/documents/classify.js";
import { requireAuth, type AuthEnv } from "../middleware/auth.js";

export const documentsRoutes = new Hono<AuthEnv>();

documentsRoutes.use("*", requireAuth);

/** The documents indexed for one of the user's matters. Someone else's matter looks like one that does not exist. */
documentsRoutes.get("/", async (c) => {
  const userId = c.get("user").id;
  const matterId = c.req.query("matterId") || "";
  if (!matterId) return c.json({ error: "matterId is required" }, 400);
  if (!(await matterOwned(matterId, userId))) return c.json({ error: "Matter not found" }, 404);
  try {
    return c.json({ documents: await listMatterDocuments(userId, matterId), kinds: DOC_KIND_LABEL });
  } catch (err) {
    console.error("[documents] list failed:", err);
    return c.json({ error: "Could not load the documents." }, 500);
  }
});

/** Correct the type the platform guessed. The case file reads the corrected type next time it is built. */
documentsRoutes.patch("/:id", async (c) => {
  const userId = c.get("user").id;
  const body = await c.req.json().catch(() => null);
  const kind = (body as { kind?: unknown } | null)?.kind;
  if (!isDocKind(kind)) return c.json({ error: "kind must be one of: " + Object.keys(DOC_KIND_LABEL).join(", ") }, 400);
  try {
    // Someone else's document looks like one that does not exist.
    if (!(await setDocumentKind(userId, c.req.param("id"), kind))) return c.json({ error: "Document not found" }, 404);
    return c.json({ ok: true, kind });
  } catch (err) {
    console.error("[documents] set kind failed:", err);
    return c.json({ error: "Could not save the document type." }, 500);
  }
});
