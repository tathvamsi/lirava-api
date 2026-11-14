import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface MockLlm {
  url: string;
  /** Every chat request the service sent to the "model", newest last. */
  requests: Array<{ system: string; user: string; maxTokens?: number; messages: Array<{ role: string; content: string }> }>;
  /** Makes the "server" refuse any prompt over this many tokens, like a real server with a small window. null = no limit. */
  setServerWindow(tokens: number | null): void;
  close(): Promise<void>;
}

/**
 * A tiny OpenAI-compatible server. A question containing "SLOW" streams for several seconds (so Stop and
 * overlapping chats can be tested); anything else answers at once. The embeddings route is not implemented,
 * like an unreachable embedding server.
 */
export async function startMockLlm(): Promise<MockLlm> {
  const requests: MockLlm["requests"] = [];
  let serverWindow: number | null = null;
  const server: Server = createServer((req, res) => {
    const url = req.url ?? "";
    if (req.method === "GET" && url.endsWith("/models")) {
      res.setHeader("Content-Type", "application/json");
      return void res.end(JSON.stringify({ data: [{ id: "mock" }] }));
    }
    if (req.method === "POST" && url.endsWith("/chat/completions")) {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        const body = JSON.parse(raw) as { messages: Array<{ role: string; content: string }>; stream?: boolean; max_tokens?: number };
        const system = body.messages.find((m) => m.role === "system")?.content ?? "";
        const user = [...body.messages].reverse().find((m) => m.role === "user")?.content ?? "";
        requests.push({ system, user, maxTokens: body.max_tokens, messages: body.messages });

        // A real server refuses a prompt that does not fit its window.
        const promptTokens = Math.ceil(body.messages.reduce((n, m) => n + m.content.length, 0) / 3);
        if (serverWindow !== null && promptTokens + (body.max_tokens ?? 0) > serverWindow) {
          res.statusCode = 400;
          res.setHeader("Content-Type", "application/json");
          return void res.end(
            JSON.stringify({ error: { message: `request (${promptTokens} tokens) exceeds the available context size (${serverWindow} tokens), try increasing it`, type: "exceed_context_size_error" } }),
          );
        }

        // The summariser call (a plain request, not streamed).
        if (system.includes("running summary of a legal consultation")) {
          res.setHeader("Content-Type", "application/json");
          return void res.end(
            JSON.stringify({ choices: [{ message: { role: "assistant", content: "- SUMMARY-MARK: client Ram Kumar, cheque dishonour, Section 138 NI Act, notice sent 4 March." }, finish_reason: "stop" }] }),
          );
        }
        const isContinuation = user.startsWith("Continue exactly where you stopped");
        const allText = body.messages.map((m) => m.content).join("\n");
        // "CUTOFF" in a question: the first answer stops early (finish_reason "length"); its continuation finishes.
        // "CUTOFF_FOREVER": every call stops early.
        const cutOff = allText.includes("CUTOFF") && (!isContinuation || allText.includes("CUTOFF_FOREVER"));

        const slow = user.includes("SLOW");
        const words = isContinuation && !cutOff ? ["and", "the", "rest", "of", "the", "answer."] : cutOff ? Array.from({ length: 12 }, (_, i) => `part${i}`) : slow ? Array.from({ length: 40 }, (_, i) => `word${i}`) : ["Per", "the", "order", "[D1],", "bail", "was", "sought."];
        const delay = slow ? 150 : 15;

        if (!body.stream) {
          res.setHeader("Content-Type", "application/json");
          return void res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: words.join(" ") } }] }));
        }
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
        let closed = false;
        res.on("close", () => (closed = true));
        let i = 0;
        const tick = () => {
          if (closed) return;
          if (i >= words.length) {
            res.write(`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: cutOff ? "length" : "stop" }] })}\n\n`);
            res.write("data: [DONE]\n\n");
            return void res.end();
          }
          const chunk = { id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: `${words[i++]} ` }, finish_reason: null }] };
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);
          setTimeout(tick, delay);
        };
        tick();
      });
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    setServerWindow: (tokens) => {
      serverWindow = tokens;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
