// MUST execute before any imports of config or app
process.env.NODE_ENV = "test";
process.env.DATABASE_URL = "";
process.env.QDRANT_URL = "";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret-minimum-32-chars-long-abcdef";

export {};
