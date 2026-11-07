import OpenAI from "openai";
import { config } from "../../config.js";
let clientInstance = null;
export function getLlmClient() {
    if (clientInstance)
        return clientInstance;
    clientInstance = new OpenAI({
        baseURL: config.customLlmBaseUrl,
        apiKey: config.customLlmApiKey,
        timeout: 120000,
        maxRetries: 0,
    });
    return clientInstance;
}
export async function checkLlmHealth() {
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
    }
    catch (err) {
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
