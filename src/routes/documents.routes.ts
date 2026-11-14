import { Hono } from "hono";
import { matterOwned } from "../services/data/pg.js";
import { listMatterDocuments } from "../services/documents/index.js";
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
    return c.json({ documents: await listMatterDocuments(userId, matterId) });
  } catch (err) {
    console.error("[documents] list failed:", err);
    return c.json({ error: "Could not load the documents." }, 500);
  }
});
