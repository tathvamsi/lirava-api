import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { onEvent, type ServerEvent } from "../services/bus/index.js";
import { getSnapshot } from "../services/repo/index.js";
import { runningFor } from "../services/agent/runtime.js";
import { requireAuth, type AuthEnv } from "../middleware/auth.js";

export const eventsRoutes = new Hono<AuthEnv>();

eventsRoutes.use("*", requireAuth);

/**
 * An event reaches a client only if it is addressed to that user. Events with no
 * owner are limited to shared Vakil (`vakil*`) changes, which carry no chat content.
 */
export function eventVisibleTo(event: ServerEvent, userId: string): boolean {
  if (event.userId) return event.userId === userId;
  return typeof event.type === "string" && event.type.startsWith("vakil");
}

eventsRoutes.get("/", (c) => {
  const userId = c.get("user").id;
  console.log(`\x1b[35m[events-sse]\x1b[0m ⚡ SSE client connected (userId: ${userId})`);

  return streamSSE(c, async (stream) => {
    // 1. Initial snapshot, built only from this user's data
    let snapshot;
    try {
      // Includes the answers currently being written, so a page opened or reloaded mid-answer still shows them.
      snapshot = { ...(await getSnapshot(userId)), running: runningFor(userId) };
    } catch (err) {
      console.error("[events-sse] Failed to build snapshot:", err);
      await stream.writeSSE({ data: JSON.stringify({ type: "error", error: "Could not load your workspace." }) });
      return;
    }
    await stream.writeSSE({
      data: JSON.stringify({ type: "snapshot", data: snapshot }),
    });

    // 2. Subscribe to the event bus, forwarding only this user's events
    const unsubscribe = onEvent(async (event) => {
      if (!eventVisibleTo(event, userId)) return;
      try {
        await stream.writeSSE({
          data: JSON.stringify(event),
        });
      } catch (err) {
        console.warn("[events-sse] Error streaming event:", err);
      }
    });

    // 3. Keep-alive ping interval (true SSE comment line ignored by EventSource)
    const interval = setInterval(async () => {
      try {
        await stream.write(": ping\n\n");
      } catch {
        clearInterval(interval);
      }
    }, 15000);

    // 4. Cleanup on disconnect
    stream.onAbort(() => {
      console.log(`\x1b[35m[events-sse]\x1b[0m 🔌 SSE client disconnected (userId: ${userId})`);
      unsubscribe();
      clearInterval(interval);
    });

    // Keep stream open
    await new Promise<void>((resolve) => {
      stream.onAbort(() => resolve());
    });
  });
});
