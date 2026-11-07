import { Hono } from "hono";
import { resolveAgentId } from "../services/agent/identity.js";
import { listConversations, getConversation, createConversation, deleteConversation, renameConversation, setConversationMatter, moveConversation, listMessages, } from "../services/repo/index.js";
export const conversationsRoutes = new Hono();
conversationsRoutes.get("/", (c) => {
    const userId = c.req.query("userId") || "";
    const agentId = c.req.query("agentId");
    const legacyDotId = c.req.query("dotId");
    const dotId = resolveAgentId(agentId, legacyDotId);
    if ((agentId !== undefined || legacyDotId !== undefined) && !dotId)
        return c.json({ error: "Invalid or conflicting agent identifiers" }, 400);
    const conversations = listConversations(userId, dotId ?? undefined);
    return c.json({ conversations });
});
conversationsRoutes.get("/:id", (c) => {
    const id = c.req.param("id");
    const conv = getConversation(id);
    if (!conv)
        return c.json({ error: "Conversation not found" }, 404);
    const messages = listMessages(conv.dotId, conv.id);
    return c.json({ conversation: conv, messages });
});
conversationsRoutes.post("/", async (c) => {
    try {
        const body = await c.req.json();
        const { title, userId, id, matterId } = body;
        const dotId = resolveAgentId(body.agentId, body.dotId);
        if (!dotId)
            return c.json({ error: "A valid agentId or dotId is required" }, 400);
        const conv = createConversation(dotId, title, userId, id, matterId);
        return c.json({ success: true, conversation: conv });
    }
    catch (err) {
        return c.json({ error: err.message }, 500);
    }
});
conversationsRoutes.delete("/:id", (c) => {
    try {
        const id = c.req.param("id");
        const success = deleteConversation(id);
        return c.json({ success, id });
    }
    catch (err) {
        return c.json({ error: err.message || "Failed to delete conversation" }, 500);
    }
});
conversationsRoutes.patch("/:id", async (c) => {
    try {
        const id = c.req.param("id");
        const body = await c.req.json();
        const { title, matterId } = body;
        if (typeof title !== "string" && matterId !== null && typeof matterId !== "string") {
            return c.json({ error: "title or matterId is required" }, 400);
        }
        const conv = typeof title === "string"
            ? renameConversation(id, title)
            : setConversationMatter(id, matterId);
        if (!conv)
            return c.json({ error: "Conversation not found" }, 404);
        return c.json({ success: true, conversation: conv });
    }
    catch (err) {
        return c.json({ error: err.message || "Failed to rename conversation" }, 500);
    }
});
conversationsRoutes.post("/:id/move", async (c) => {
    try {
        const id = c.req.param("id");
        const body = await c.req.json();
        const targetDotId = resolveAgentId(body.targetAgentId, body.targetDotId);
        if (!targetDotId) {
            return c.json({ error: "A valid targetAgentId or targetDotId is required" }, 400);
        }
        const conv = moveConversation(id, targetDotId);
        if (!conv)
            return c.json({ error: "Conversation not found" }, 404);
        return c.json({ success: true, conversation: conv });
    }
    catch (err) {
        return c.json({ error: err.message || "Failed to move conversation" }, 500);
    }
});
