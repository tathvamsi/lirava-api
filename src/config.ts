import "dotenv/config";
import path from "node:path";

export const config = {
  port: Number(process.env.PORT || 4000),
  host: process.env.HOST || "0.0.0.0",
  nodeEnv: process.env.NODE_ENV || "development",
  logLevel: process.env.LOG_LEVEL || "debug",

  // CORS Origins
  corsOrigins: (process.env.CORS_ORIGINS || "http://localhost:3000,http://localhost:3100,http://localhost:3200").split(",").map(s => s.trim()),
  webUrl: (process.env.SOLI_WEB_URL || "http://localhost:3100").replace(/\/$/, ""),
  publicUrl: (process.env.SOLI_BACKEND_URL || "http://localhost:4000").replace(/\/$/, ""),

  // Database paths
  dotsDataDir: process.env.DOTS_DATA_DIR 
    ? path.resolve(process.cwd(), process.env.DOTS_DATA_DIR)
    : path.resolve(process.cwd(), "../soli-web/.data"),
  databaseUrl: process.env.DATABASE_URL || "",

  // Inference & LLM
  customLlmBaseUrl: process.env.CUSTOM_LLM_BASE_URL || "http://10.10.0.247:1618/v1",
  customLlmApiKey: process.env.CUSTOM_LLM_API_KEY || "sb-nOiBhTEoqFp6biWSeqRvQNVbp3xRbF054iedtsi2pnM",
  customLlmModel: process.env.CUSTOM_LLM_MODEL || "/home/ritvox/LLM-Server/models/qwen2.5-7b-instruct-q4_k_m-00001-of-00002.gguf",

  // Qdrant Vector Engine
  qdrantUrl: process.env.QDRANT_URL || "https://a8b9d0ad-1700-4b33-aa62-ebecca40206f.sa-east-1-0.aws.cloud.qdrant.io:6333",
  qdrantApiKey: process.env.QDRANT_API_KEY || "",
  qdrantCollection: process.env.QDRANT_COLLECTION || "soli_legal_corpus",

  // RAG Configuration
  customEmbeddingModel: process.env.CUSTOM_EMBEDDING_MODEL || "/home/ritvox/LLM-Server/models/bge-m3-Q4_K_M.gguf",
  embeddingDimensions: Number(process.env.EMBEDDING_DIMENSIONS || 1024),
  chunkSize: Number(process.env.CHUNK_SIZE || 1200),
  chunkOverlap: Number(process.env.CHUNK_OVERLAP || 200),
  topK: Number(process.env.TOP_K || 5),

  // Security
  sessionSecret: process.env.SESSION_SECRET || "soli-secret-change-in-production-32bytes",
  adminEmails: (process.env.ADMIN_EMAILS || "admin@soli.si,admin@soli.dev").split(",").map(e => e.trim().toLowerCase()),
  composioApiKey: process.env.COMPOSIO_API_KEY || "",
  tokenEncryptionKey: process.env.TOKEN_ENCRYPTION_KEY || "",
};
