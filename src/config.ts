import "dotenv/config";

const nodeEnv = process.env.NODE_ENV || "development";
export const isProduction = nodeEnv === "production";

/** Same constant the web app uses in development, so the two services agree out of the box. Never used in production. */
const DEV_SESSION_SECRET = "development-only-soli-session-secret-change-before-production";

const list = (value: string | undefined) =>
  (value || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const ownLlm = process.env.OWN_LLM === "true";

export const config = {
  port: Number(process.env.PORT || 4000),
  // Listen on all interfaces only when told to (containers). Otherwise stay on loopback.
  host: process.env.HOST || (isProduction ? "0.0.0.0" : "127.0.0.1"),
  nodeEnv,
  logLevel: process.env.LOG_LEVEL || (isProduction ? "info" : "debug"),

  // CORS origins allowed to call this service from a browser.
  corsOrigins: list(process.env.CORS_ORIGINS || (isProduction ? "" : "http://localhost:3000,http://localhost:3100,http://localhost:3200")).map((s) =>
    s.replace(/\/$/, ""),
  ),
  webUrl: (process.env.SOLI_WEB_URL || "http://localhost:3100").replace(/\/$/, ""),
  publicUrl: (process.env.SOLI_BACKEND_URL || "http://localhost:4000").replace(/\/$/, ""),

  databaseUrl: process.env.DATABASE_URL || "",

  // Inference & LLM (OpenAI-compatible server)
  // OWN_LLM=true uses your own server (CUSTOM_LLM_*); anything else uses NVIDIA NIM (NIM_*, NVIDIA_API_KEY).
  // The rest of the app reads these three values and does not need to know which provider is active.
  ownLlm,
  customLlmBaseUrl: ownLlm
    ? process.env.CUSTOM_LLM_BASE_URL || "http://localhost:1618/v1"
    : (process.env.NIM_BASE_URL || "https://integrate.api.nvidia.com/v1").replace(/\/$/, ""),
  customLlmApiKey: ownLlm ? process.env.CUSTOM_LLM_API_KEY || "not-needed" : process.env.NVIDIA_API_KEY || "",
  customLlmModel: ownLlm
    ? process.env.CUSTOM_LLM_MODEL || "default"
    : process.env.NIM_LLM_MODEL || "nvidia/nemotron-3.5-super-vl-120b-a12b",

  /**
   * How many tokens one request may use in total (prompt + answer). On your own server this is the size of ONE slot:
   * the server's context (-c / ctxSize) divided by its parallel slots (32768 / 4 = 8192). Chats are trimmed and
   * summarised to fit it, and the answer is never allowed to run past it.
   */
  contextWindowTokens: Number(process.env.CONTEXT_WINDOW_TOKENS || (ownLlm ? 8192 : 32768)),
  /** Most tokens one answer may use before it is continued in a second call. */
  answerMaxTokens: Number(process.env.ANSWER_MAX_TOKENS || (ownLlm ? 1500 : 1800)),
  /**
   * True when the model can look at images (the Lirava VL model on our own server). Attached PNG/JPEG/GIF files are
   * then sent to it with the question. Set LLM_VISION=true or false to override; the default follows OWN_LLM.
   */
  visionEnabled: process.env.LLM_VISION ? process.env.LLM_VISION === "true" : ownLlm,
  /** Window tokens held back for each image (a full-screen screenshot is about 1,100). */
  imageTokens: Number(process.env.IMAGE_TOKENS || 1500),

  /**
   * OCR service (Tesseract on our own server) that reads scanned PDFs and photos. Leave OCR_BASE_URL empty to turn it off:
   * scanned documents are then reported as unreadable, as before. OCR_LANG is "auto" or codes such as "eng+hin".
   */
  ocrBaseUrl: (process.env.OCR_BASE_URL || "").replace(/\/$/, ""),
  ocrApiKey: process.env.OCR_API_KEY || "",
  ocrLang: process.env.OCR_LANG || "auto",

  // Qdrant Vector Engine
  qdrantUrl: process.env.QDRANT_URL || "",
  qdrantApiKey: process.env.QDRANT_API_KEY || "",
  qdrantCollection: process.env.QDRANT_COLLECTION || "soli_legal_corpus",

  // RAG Configuration
  customEmbeddingModel: ownLlm
    ? process.env.CUSTOM_EMBEDDING_MODEL || "default"
    : process.env.NIM_EMBEDDING_MODEL || "nvidia/nemotron-3.5-embed-1b",
  embeddingDimensions: Number(process.env.EMBEDDING_DIMENSIONS || 1024),
  chunkSize: Number(process.env.CHUNK_SIZE || 1200),
  chunkOverlap: Number(process.env.CHUNK_OVERLAP || 200),
  topK: Number(process.env.TOP_K || 5),
  /** Hard ceiling on any single call to the model/embedding/vector services. */
  upstreamTimeoutMs: Number(process.env.UPSTREAM_TIMEOUT_MS || 8000),

  // Security
  sessionSecret: process.env.SESSION_SECRET || (isProduction ? "" : DEV_SESSION_SECRET),
  adminEmails: list(process.env.ADMIN_EMAILS).map((e) => e.toLowerCase()),
  signupInviteCodes: list(process.env.SIGNUP_INVITE_CODES),
  allowOpenSignup: process.env.ALLOW_OPEN_SIGNUP === "true",
  signupAllowedDomains: list(process.env.SIGNUP_ALLOWED_DOMAINS).map((d) => d.toLowerCase().replace(/^@/, "")),
  composioApiKey: process.env.COMPOSIO_API_KEY || "",
  tokenEncryptionKey: process.env.TOKEN_ENCRYPTION_KEY || "",

  // Uploads
  maxUploadBytes: Number(process.env.MAX_UPLOAD_BYTES || 25 * 1024 * 1024),
};

/**
 * Refuse to start a production server with missing or unsafe settings. Called from
 * server.ts (not at import time, so tests and tooling can still import the app).
 */
export function assertProductionConfig(): void {
  if (!isProduction) return;
  const problems: string[] = [];
  if (config.sessionSecret.length < 32) problems.push("SESSION_SECRET must be set to a random value of at least 32 characters (and match the web app).");
  if (!config.databaseUrl) problems.push("DATABASE_URL is required: users, sessions and chats are stored in PostgreSQL.");
  if (!config.corsOrigins.length) problems.push("CORS_ORIGINS must list the web app origin(s).");
  if (!process.env.CUSTOM_LLM_BASE_URL) problems.push("CUSTOM_LLM_BASE_URL is required.");
  if (!config.signupInviteCodes.length && !config.signupAllowedDomains.length && !config.allowOpenSignup) {
    problems.push("Signup is open to anyone. Set SIGNUP_INVITE_CODES or SIGNUP_ALLOWED_DOMAINS, or set ALLOW_OPEN_SIGNUP=true to accept open registration.");
  }
  if (!config.adminEmails.length) problems.push("ADMIN_EMAILS must list at least one administrator email.");
  if (!/^[A-Za-z0-9+/=]{43,44}$/.test(config.tokenEncryptionKey)) {
    console.warn("[soli-backend] TOKEN_ENCRYPTION_KEY is not a base64 32-byte key: user-managed connector keys are disabled.");
  }
  if (problems.length) {
    throw new Error(`Invalid production configuration:\n  - ${problems.join("\n  - ")}`);
  }
}
