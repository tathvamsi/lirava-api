import { Hono } from "hono";
import { sendMessage, abortRun, getRunState } from "../services/agent/runtime.js";
import { resolveAgentId } from "../services/agent/identity.js";

export const agentRoutes = new Hono();

agentRoutes.post("/message", async (c) => {
  try {
    const body = await c.req.json();
    const { text, userId, conversationId, messageId, attachments } = body;
    const dotId = resolveAgentId(body.agentId, body.dotId);

    const hasAttachments = Array.isArray(attachments) && attachments.length > 0;
    const promptText = (text || "").trim() || (hasAttachments ? "Please review and analyze the attached document." : "");

    if (!dotId || (!promptText && !hasAttachments)) {
      return c.json({ error: "A valid agentId (or dotId) and text/attachments are required" }, 400);
    }

    const result = await sendMessage(dotId, promptText, userId, conversationId, messageId, attachments);
    return c.json(result);
  } catch (err: any) {
    console.error("[agent-routes] Error in sendMessage:", err);
    return c.json({ error: err.message || "Agent execution failed" }, 500);
  }
});

agentRoutes.post("/abort", async (c) => {
  try {
    const body = await c.req.json();
    const dotId = resolveAgentId(body.agentId, body.dotId);

    if (!dotId) {
      return c.json({ error: "A valid agentId or dotId is required" }, 400);
    }

    const aborted = abortRun(dotId);
    return c.json({ success: true, aborted });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

agentRoutes.get("/state/:dotId", (c) => {
  const dotId = c.req.param("dotId");
  const state = getRunState(dotId);
  return c.json({ agentId: dotId, dotId, running: state.running, step: state.currentStep });
});
