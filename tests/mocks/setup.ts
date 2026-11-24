// MUST execute before any imports of config or app
process.env.NODE_ENV = "test";
process.env.DATABASE_URL = "";
process.env.QDRANT_URL = "";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret-minimum-32-chars-long-abcdef";
// The mock search returns offline hash vectors whose scores mean nothing, so the relevance cut-off (tested on its own in
// retrieval-relevance.test.ts) is moved out of the way for these pipeline tests.
process.env.RAG_MIN_VECTOR_SCORE = "0";
process.env.RAG_STRONG_VECTOR_SCORE = "0";

export {};
