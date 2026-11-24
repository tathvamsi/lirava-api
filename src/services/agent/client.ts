import { OpenAI } from "openai";
import { config } from "../../config.js";
import { activeProvider } from "./providers.js";

// One client per provider (and per address and key, which the tests and admin tools can change while the process runs).
const clients = new Map<string, OpenAI>();

/** The client for the provider the current request chose, or for the server's default provider. */
export function getLlmClient(): OpenAI {
  const p = activeProvider();
  const cacheKey = `${p.id}|${p.baseURL}|${p.apiKey}`;
  let client = clients.get(cacheKey);
  if (!client) {
    client = new OpenAI({
      baseURL: p.baseURL,
      apiKey: p.apiKey || "not-needed",
      defaultHeaders: p.headers,
      timeout: 120000,
      maxRetries: 0,
    });
    clients.set(cacheKey, client);
  }
  return client;
}

export async function checkLlmHealth(): Promise<{
  status: "online" | "offline";
  baseURL: string;
  model: string;
  latencyMs: number;
  lastChecked: string;
  error?: string;
}> {
  const start = Date.now();
  const baseURL = config.customLlmBaseUrl;
  const model = config.customLlmModel;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);

    const res = await fetch(`${baseURL}/models`, {
      headers: { Authorization: `Bearer ${config.customLlmApiKey}` },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (res.ok) {
      return {
        status: "online",
        baseURL,
        model,
        latencyMs: Date.now() - start,
        lastChecked: new Date().toISOString(),
      };
    }

    return {
      status: "offline",
      baseURL,
      model,
      latencyMs: Date.now() - start,
      lastChecked: new Date().toISOString(),
      error: `HTTP ${res.status} from model provider`,
    };
  } catch (err: any) {
    return {
      status: "offline",
      baseURL,
      model,
      latencyMs: Date.now() - start,
      lastChecked: new Date().toISOString(),
      error: err.message || "Connection refused",
    };
  }
}
