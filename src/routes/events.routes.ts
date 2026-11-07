import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { onEvent } from "../services/bus/index.js";
import { getSnapshot } from "../services/repo/index.js";

export const eventsRoutes = new Hono();

eventsRoutes.get("/", (c) => {
  const userId = c.req.query("userId") || "usr-super-admin";
  console.log(`\x1b[35m[events-sse]\x1b[0m ⚡ SSE client connected (userId: ${userId})`);

  return streamSSE(c, async (stream) => {
    // 1. Initial snapshot formatted as { type: "snapshot", data: Snapshot }
    const snapshot = getSnapshot(userId);
    await stream.writeSSE({
      data: JSON.stringify({ type: "snapshot", data: snapshot }),
    });

    // 2. Subscribe to event bus and stream all server events
    const unsubscribe = onEvent(async (event) => {
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
