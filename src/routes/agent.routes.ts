import { Hono } from "hono";
import { sendMessage, abortRun, getRunState } from "../services/agent/runtime.js";
import { parseVakilId } from "../services/agent/vakil-id.js";
import { requireAuth, type AuthEnv } from "../middleware/auth.js";
import { ChatError } from "../services/chats/store.js";
import { ProviderError, publicProviders, refreshOwnModel, resolveProvider } from "../services/agent/providers.js";

export const agentRoutes = new Hono<AuthEnv>();

agentRoutes.use("*", requireAuth);

/** The models a chat can use, and which are set up on this server. Never includes a key or an address. */
agentRoutes.get("/providers", async (c) => {
  await refreshOwnModel(); // so "Lirava model" shows the model that is really loaded on our server
  return c.json({ providers: publicProviders() });
});

agentRoutes.post("/message", async (c) => {
  const userId = c.get("user").id;
  try {
    const body = await c.req.json();
    const { text, conversationId, messageId, attachments } = body;
    const vakilId = parseVakilId(body.vakilId);

    const hasAttachments = Array.isArray(attachments) && attachments.length > 0;
    const promptText = (text || "").trim() || (hasAttachments ? "Please review and analyze the attached document." : "");

    if (!vakilId || (!promptText && !hasAttachments)) {
      return c.json({ error: "A valid vakilId and text or attachments are required" }, 400);
    }

    // The user comes from the verified session; a userId in the body is ignored.
    // `provider` is the model the user picked (custom, nvidia or sarvam). Nothing is swapped quietly: a choice that is
    // unknown or not set up on this server is refused with the reason.
    const provider = resolveProvider(body.provider);
    // background: true saves the question and returns at once; the answer arrives through the live stream.
    const result = await sendMessage(vakilId, promptText, userId, conversationId, messageId, attachments, { background: body.background === true, provider });
    return c.json(result);
  } catch (err: any) {
    if (err instanceof ProviderError) return c.json({ error: err.message, code: "provider_unavailable" }, 400);
    if (err instanceof ChatError) return c.json({ error: err.message }, err.status);
    console.error("[agent-routes] Error in sendMessage:", err);
    return c.json({ error: err.message || "Agent execution failed" }, 500);
  }
});

agentRoutes.post("/abort", async (c) => {
  const userId = c.get("user").id;
  try {
    const body = await c.req.json();
    const vakilId = parseVakilId(body.vakilId);

    if (!vakilId) {
      return c.json({ error: "A valid vakilId is required" }, 400);
    }

    // Only this user's own run can be stopped: the given chat, or all of that agent's runs.
    const conversationId = typeof body.conversationId === "string" && body.conversationId ? body.conversationId : undefined;
    const aborted = abortRun(vakilId, userId, conversationId);
    return c.json({ success: true, aborted });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

agentRoutes.get("/state/:conversationId", (c) => {
  const userId = c.get("user").id;
  const conversationId = c.req.param("conversationId");
  const state = getRunState(conversationId, userId);
  return c.json({ conversationId, running: state.running, step: state.currentStep });
});
