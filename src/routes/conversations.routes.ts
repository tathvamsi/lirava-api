import { Hono } from "hono";
import { parseVakilId } from "../services/agent/vakil-id.js";
import { requireAuth, type AuthEnv } from "../middleware/auth.js";
import {
  ChatError,
  listConversations,
  getConversation,
  createConversation,
  deleteConversation,
  renameConversation,
  setConversationMatter,
  moveConversation,
  setConversationFlags,
  listMessages,
} from "../services/chats/store.js";

export const conversationsRoutes = new Hono<AuthEnv>();

// Every chat endpoint requires a signed-in user, and every query is scoped to that user.
conversationsRoutes.use("*", requireAuth);

function fail(c: { json: (body: unknown, status?: any) => Response }, err: unknown, fallback: string) {
  if (err instanceof ChatError) return c.json({ error: err.message }, err.status);
  console.error("[conversations]", err);
  return c.json({ error: fallback }, 500);
}

conversationsRoutes.get("/", async (c) => {
  const userId = c.get("user").id;
  const raw = c.req.query("vakilId");
  const vakilId = parseVakilId(raw);
  if (raw !== undefined && !vakilId) return c.json({ error: "Invalid vakilId" }, 400);
  try {
    return c.json({ conversations: await listConversations(userId, vakilId ?? undefined) });
  } catch (err) {
    return fail(c, err, "Failed to load conversations");
  }
});

conversationsRoutes.get("/:id", async (c) => {
  const userId = c.get("user").id;
  try {
    const conv = await getConversation(c.req.param("id"), userId);
    // Someone else's chat looks exactly like a chat that does not exist.
    if (!conv) return c.json({ error: "Conversation not found" }, 404);
    const messages = await listMessages(conv.id, userId);
    return c.json({ conversation: conv, messages });
  } catch (err) {
    return fail(c, err, "Failed to load conversation");
  }
});

conversationsRoutes.post("/", async (c) => {
  const userId = c.get("user").id;
  try {
    const body = await c.req.json();
    const vakilId = parseVakilId(body.vakilId);
    if (!vakilId) return c.json({ error: "A valid vakilId is required" }, 400);
    const title = typeof body.title === "string" && body.title.trim() ? body.title.trim().slice(0, 200) : undefined;
    const id = typeof body.id === "string" && body.id.trim() ? body.id.trim() : undefined;
    const matterId = typeof body.matterId === "string" && body.matterId ? body.matterId : null;
    const conv = await createConversation(vakilId, title, userId, id, matterId);
    return c.json({ success: true, conversation: conv });
  } catch (err) {
    return fail(c, err, "Failed to create conversation");
  }
});

conversationsRoutes.delete("/:id", async (c) => {
  const userId = c.get("user").id;
  const id = c.req.param("id");
  try {
    const success = await deleteConversation(id, userId);
    if (!success) return c.json({ error: "Conversation not found" }, 404);
    return c.json({ success, id });
  } catch (err) {
    return fail(c, err, "Failed to delete conversation");
  }
});

conversationsRoutes.patch("/:id", async (c) => {
  const userId = c.get("user").id;
  const id = c.req.param("id");
  try {
    const body = await c.req.json();
    const { title, matterId } = body;
    if (typeof body.pinned === "boolean" || typeof body.archived === "boolean") {
      const flagged = await setConversationFlags(id, userId, {
        pinned: typeof body.pinned === "boolean" ? body.pinned : undefined,
        archived: typeof body.archived === "boolean" ? body.archived : undefined,
      });
      if (!flagged) return c.json({ error: "Conversation not found" }, 404);
      return c.json({ success: true, conversation: flagged });
    }
    if (typeof title !== "string" && matterId !== null && typeof matterId !== "string") {
      return c.json({ error: "title, matterId, pinned or archived is required" }, 400);
    }
    const conv =
      typeof title === "string"
        ? await renameConversation(id, userId, title.trim().slice(0, 200))
        : await setConversationMatter(id, userId, matterId);
    if (!conv) return c.json({ error: "Conversation not found" }, 404);
    return c.json({ success: true, conversation: conv });
  } catch (err) {
    return fail(c, err, "Failed to update conversation");
  }
});

conversationsRoutes.post("/:id/move", async (c) => {
  const userId = c.get("user").id;
  const id = c.req.param("id");
  try {
    const body = await c.req.json();
    const targetVakilId = parseVakilId(body.targetVakilId);
    if (!targetVakilId) {
      return c.json({ error: "A valid targetVakilId or targetVakilId is required" }, 400);
    }
    const conv = await moveConversation(id, userId, targetVakilId);
    if (!conv) return c.json({ error: "Conversation not found" }, 404);
    return c.json({ success: true, conversation: conv });
  } catch (err) {
    return fail(c, err, "Failed to move conversation");
  }
});
