/**
 * The AI providers a chat can use: Lirava's own model server, NVIDIA, and Sarvam. Each answers the same OpenAI-style
 * chat requests, so the rest of the app only needs to know which one a request is using. The choice travels with the
 * request (AsyncLocalStorage), so no function needs an extra argument and one user's choice never leaks into another's.
 *
 * Keys live only in the server's environment. The browser is told which providers are available, never their keys.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { config } from "../../config.js";

export type ProviderId = "custom" | "nvidia" | "sarvam";
export const PROVIDER_IDS: readonly ProviderId[] = ["custom", "nvidia", "sarvam"];
export const isProviderId = (v: unknown): v is ProviderId => typeof v === "string" && (PROVIDER_IDS as readonly string[]).includes(v);

export interface Provider {
  id: ProviderId;
  /** Shown in the picker. */
  label: string;
  baseURL: string;
  apiKey: string;
  model: string;
  /** The model actually running, when it is known and differs from the name sent in requests (our own server). */
  displayModel?: string;
  /** Tokens one request may use (prompt plus answer). */
  window: number;
  /** Most tokens one answer may use before it is continued. */
  answerMax: number;
  /** Whether images can be sent to this model. */
  vision: boolean;
  /** When this model cannot read images, the model of the same provider that is used for a message that has one. */
  imageModel?: Provider;
  /** True when the user's text leaves Lirava's own server for a third party. */
  hosted: boolean;
  /** Extra headers this provider needs. */
  headers: Record<string, string>;
  /** Extra fields for every chat request (a provider-specific setting). */
  body: Record<string, unknown>;
  available: boolean;
  /** Why it cannot be used, when it cannot. */
  unavailableReason?: string;
}

const trimSlash = (u: string) => u.replace(/\/+$/, "");

// ---------------- The model loaded on our own server ----------------

/** Our own server runs whichever model was last loaded on it (Qwen, Lirava, ...). Its /models route says which. Read briefly cached. */
let ownLoaded: { name: string; at: number } | null = null;

/** Asks the own server which model is loaded, at most every 30 seconds. A server that is down or silent keeps the last answer. */
export async function refreshOwnModel(): Promise<void> {
  if (ownLoaded && Date.now() - ownLoaded.at < 30_000) return;
  try {
    const root = trimSlash(config.customLlmBaseUrl).replace(/\/v1$/, "");
    const res = await fetch(`${root}/models`, { signal: AbortSignal.timeout(3000), headers: { Authorization: `Bearer ${config.customLlmApiKey}` } });
    const data = (await res.json()) as { active?: unknown };
    if (res.ok && typeof data.active === "string" && data.active) ownLoaded = { name: data.active.replace(/\.gguf$/i, ""), at: Date.now() };
  } catch {
    /* keep what was known */
  }
  if (ownLoaded) ownLoaded.at = Date.now();
}
const num = (v: string | undefined, fallback: number) => (v && Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : fallback);

/**
 * Lirava's own model server. Its settings are read live from `config` (CUSTOM_LLM_*), because tests and the admin tools
 * change `config` while the process runs.
 */
function own(): Provider {
  return {
    id: "custom",
    label: "Lirava model",
    baseURL: config.customLlmBaseUrl,
    apiKey: config.customLlmApiKey,
    model: config.customLlmModel,
    displayModel: ownLoaded?.name,
    window: config.contextWindowTokens,
    answerMax: config.answerMaxTokens,
    vision: config.visionEnabled,
    hosted: false,
    headers: {},
    // A small model on our own server can loop ("...the proceedings are manifestly frivolous in nature and ..." for pages).
    // A mild repetition penalty makes that much less likely; the runtime also stops an answer that repeats itself.
    body: { frequency_penalty: 0.3, repeat_penalty: 1.1 },
    available: Boolean(config.customLlmBaseUrl),
    unavailableReason: config.customLlmBaseUrl ? undefined : "CUSTOM_LLM_BASE_URL is not set on the server.",
  };
}

function nvidia(): Provider {
  const key = process.env.NVIDIA_API_KEY || "";
  return {
    id: "nvidia",
    label: "NVIDIA",
    baseURL: trimSlash(process.env.NIM_BASE_URL || "https://integrate.api.nvidia.com/v1"),
    apiKey: key,
    model: process.env.NIM_LLM_MODEL || "nvidia/nemotron-3.5-super-vl-120b-a12b",
    window: num(process.env.NIM_CONTEXT_WINDOW_TOKENS, 32768),
    answerMax: num(process.env.NIM_ANSWER_MAX_TOKENS, 1800),
    vision: process.env.NIM_VISION ? process.env.NIM_VISION === "true" : true,
    hosted: true,
    headers: {},
    body: {},
    available: Boolean(key),
    unavailableReason: key ? undefined : "NVIDIA_API_KEY is not set on the server.",
  };
}

function sarvam(): Provider {
  const key = process.env.SARVAM_API_KEY || "";
  // sarvam-105b has a 128K window; chats are kept well inside it so answers stay quick. It is a reasoning model: with
  // reasoning on, its thinking can use the whole answer budget and leave no visible text, so it is off unless asked for.
  const effort = process.env.SARVAM_REASONING_EFFORT || "off";
  const headers: Record<string, string> = key ? { "api-subscription-key": key } : {};
  // sarvam-105b is text only, and the /v1 endpoint serves only it. Sarvam's image models are on /v2; gemma4 reads images, has a
  // 262K window and does not reason unless asked to, so a short answer is never swallowed by thinking.
  const imageModel: Provider = {
    id: "sarvam",
    label: "Sarvam",
    baseURL: trimSlash(process.env.SARVAM_VISION_BASE_URL || "https://api.sarvam.ai/v2"),
    apiKey: key,
    model: process.env.SARVAM_VISION_MODEL || "gemma4",
    window: num(process.env.SARVAM_CONTEXT_WINDOW_TOKENS, 32768),
    answerMax: num(process.env.SARVAM_ANSWER_MAX_TOKENS, 2500),
    vision: true,
    hosted: true,
    headers,
    body: {},
    available: Boolean(key),
  };
  return {
    imageModel,
    id: "sarvam",
    label: "Sarvam",
    baseURL: trimSlash(process.env.SARVAM_BASE_URL || "https://api.sarvam.ai/v1"),
    apiKey: key,
    model: process.env.SARVAM_LLM_MODEL || "sarvam-105b",
    window: num(process.env.SARVAM_CONTEXT_WINDOW_TOKENS, 32768),
    answerMax: num(process.env.SARVAM_ANSWER_MAX_TOKENS, 2500),
    vision: false,
    hosted: true,
    // Sarvam asks for its own key header; the standard Bearer header is sent as well.
    headers,
    body: { reasoning_effort: effort === "off" ? null : effort },
    available: Boolean(key),
    unavailableReason: key ? undefined : "SARVAM_API_KEY is not set on the server.",
  };
}

const builders: Record<ProviderId, () => Provider> = { custom: own, nvidia, sarvam };

/**
 * The provider a request uses when none was chosen: DEFAULT_LLM_PROVIDER (custom, nvidia or sarvam; "custom" if unset or
 * invalid). If that one is not set up (for example its key is missing) the own server is used, so a chat never has no model.
 */
export function defaultProvider(): Provider {
  const wanted = isProviderId(config.defaultLlmProvider) ? builders[config.defaultLlmProvider]() : own();
  return wanted.available ? wanted : own();
}

/** The provider to run a message with: the chosen one, or its image model when the message has an image and the chosen one cannot read it. */
export function providerFor(provider: Provider, hasImages: boolean): Provider {
  return hasImages && !provider.vision && provider.imageModel ? provider.imageModel : provider;
}

export class ProviderError extends Error {
  readonly status = 400;
}

/** A chosen provider, or the default when the request chose none. A choice that is not valid or not set up is an error, never a quiet swap. */
export function resolveProvider(choice?: unknown): Provider {
  if (choice === undefined || choice === null || choice === "") return defaultProvider();
  if (!isProviderId(choice)) throw new ProviderError(`Unknown model "${String(choice).slice(0, 40)}". Choose one of: ${PROVIDER_IDS.join(", ")}.`);
  const p = builders[choice]();
  if (!p.available) throw new ProviderError(`${p.label} is not available: ${p.unavailableReason ?? "not set up"}`);
  return p;
}

export interface PublicProvider {
  id: ProviderId;
  label: string;
  model: string;
  available: boolean;
  hosted: boolean;
  vision: boolean;
  /** One line shown under the option. */
  note: string;
  isDefault: boolean;
}

/** What the browser may know: no keys, no addresses. */
export function publicProviders(): PublicProvider[] {
  const def = defaultProvider().id;
  return PROVIDER_IDS.map((id) => {
    const p = builders[id]();
    return {
      id,
      label: p.label,
      model: p.displayModel ?? p.model,
      available: p.available,
      hosted: p.hosted,
      vision: p.vision || Boolean(p.imageModel?.vision),
      note: !p.available ? (p.unavailableReason ?? "Not set up") : p.hosted ? "Hosted: your text is sent to this provider" : "Runs on Lirava's own server",
      isDefault: id === def,
    };
  });
}

// ---------------- Carrying the choice with the request ----------------

const store = new AsyncLocalStorage<Provider>();

/** Runs `fn` (and everything it awaits) with this provider. */
export function withProvider<T>(provider: Provider, fn: () => Promise<T>): Promise<T> {
  return store.run(provider, fn);
}

/** The provider of the request being handled, or the default outside one. */
export function activeProvider(): Provider {
  return store.getStore() ?? defaultProvider();
}

/** The model name to put in a chat request. */
export const llmModel = () => activeProvider().model;
