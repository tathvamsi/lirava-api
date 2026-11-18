import crypto from "node:crypto";
import { config } from "../../config.js";

interface EmbeddingResponse {
  data: Array<{
    embedding: number[];
    index: number;
  }>;
}

const embeddingCache = new Map<string, number[]>();
const MAX_CACHE_SIZE = 500;

export type EmbeddingKind = "query" | "passage";

/**
 * Deterministic vector generator for offline fallback when LLM server is unreachable or in test environments.
 * Maps text tokens into a 1024-dimensional space with L2 normalization.
 * Texts sharing relevant legal keywords yield higher cosine similarity.
 */
export function generateDeterministicVector(text: string, dimensions = 1024): number[] {
  const vec = new Float64Array(dimensions);
  const normalized = text.toLowerCase().trim();
  if (!normalized) {
    return new Array(dimensions).fill(0);
  }

  // Tokenize by non-alphanumeric
  const words = normalized.split(/[^a-z0-9_]+/).filter(Boolean);

  // Overall text hash for dense background baseline
  const overallHash = crypto.createHash("sha256").update(normalized).digest();
  for (let i = 0; i < dimensions; i++) {
    const byte = overallHash[i % overallHash.length];
    vec[i] = ((byte / 255) - 0.5) * 0.05;
  }

  // Word token projection
  for (const word of words) {
    const wordHash = crypto.createHash("md5").update(word).digest();
    const bucket = wordHash.readUInt16BE(0) % dimensions;
    const sign = (wordHash[2] & 1) === 0 ? 1 : -1;
    const weight = 1.0 + Math.min(word.length / 5, 2.0);
    vec[bucket] += sign * weight;

    // Subword / prefix matching
    if (word.length >= 4) {
      const prefix = word.slice(0, 4);
      const prefixHash = crypto.createHash("md5").update(prefix).digest();
      const pBucket = prefixHash.readUInt16BE(0) % dimensions;
      const pSign = (prefixHash[2] & 1) === 0 ? 1 : -1;
      vec[pBucket] += pSign * 0.5;
    }
  }

  // L2 normalization
  let sumSq = 0;
  for (let i = 0; i < dimensions; i++) {
    sumSq += vec[i] * vec[i];
  }
  const norm = Math.sqrt(sumSq);
  const result: number[] = new Array(dimensions);
  if (norm > 0) {
    for (let i = 0; i < dimensions; i++) {
      result[i] = Number((vec[i] / norm).toFixed(6));
    }
  } else {
    for (let i = 0; i < dimensions; i++) {
      result[i] = 0;
    }
  }
  return result;
}

export async function embedText(text: string, kind: EmbeddingKind = "query"): Promise<number[]> {
  const normalized = text.trim();
  const dim = config.embeddingDimensions || 1024;
  if (!normalized) {
    return new Array(dim).fill(0);
  }

  const cacheKey = `${kind}:${normalized}`;
  const cached = embeddingCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  // If in test environment without endpoint or customLlmBaseUrl is dummy, produce deterministic vector
  if (process.env.NODE_ENV === "test" && (!config.customLlmBaseUrl || config.customLlmBaseUrl.includes("example.com"))) {
    const fallback = generateDeterministicVector(normalized, dim);
    embeddingCache.set(cacheKey, fallback);
    return fallback;
  }

  const endpoint = `${config.customLlmBaseUrl.replace(/\/+$/, "")}/embeddings`;

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.customLlmApiKey}`,
      },
      body: JSON.stringify({
        model: config.customEmbeddingModel,
        input: normalized,
        ...(config.ownLlm ? {} : { input_type: kind, truncate: "END", dimensions: dim }),
      }),
      signal: AbortSignal.timeout(config.upstreamTimeoutMs),
    });

    if (!res.ok) {
      throw new Error(`Embedding request failed with HTTP ${res.status}: ${await res.text()}`);
    }

    const json = (await res.json()) as EmbeddingResponse;
    const vector = json.data?.[0]?.embedding;

    if (!vector || !Array.isArray(vector)) {
      throw new Error("Invalid embedding response structure from server");
    }

    if (embeddingCache.size >= MAX_CACHE_SIZE) {
      const oldestKey = embeddingCache.keys().next().value;
      if (oldestKey) embeddingCache.delete(oldestKey);
    }
    embeddingCache.set(cacheKey, vector);

    return vector;
  } catch (err: any) {
    // Graceful offline fallback
    const fallbackVec = generateDeterministicVector(normalized, dim);
    embeddingCache.set(cacheKey, fallbackVec);
    return fallbackVec;
  }
}

/** Many texts in few requests. Order of the results matches the input. */
export async function embedMany(texts: string[], kind: EmbeddingKind = "passage", batchSize = 16): Promise<number[][]> {
  const dim = config.embeddingDimensions || 1024;
  const endpoint = `${config.customLlmBaseUrl.replace(/\/+$/, "")}/embeddings`;
  const out: number[][] = [];

  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize).map((t) => t.trim() || " ");
    try {
      if (process.env.NODE_ENV === "test" && (!config.customLlmBaseUrl || config.customLlmBaseUrl.includes("example.com"))) {
        for (const item of batch) {
          out.push(generateDeterministicVector(item, dim));
        }
        continue;
      }

      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.customLlmApiKey}` },
        body: JSON.stringify({
          model: config.customEmbeddingModel,
          input: batch,
          ...(config.ownLlm ? {} : { input_type: kind, truncate: "END", dimensions: dim }),
        }),
        signal: AbortSignal.timeout(Math.max(config.upstreamTimeoutMs, 30_000)),
      });
      if (!res.ok) throw new Error(`Embedding request failed with HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const json = (await res.json()) as EmbeddingResponse;
      const sorted = [...(json.data || [])].sort((a, b) => a.index - b.index);
      if (sorted.length !== batch.length) throw new Error("The embedding server returned the wrong number of vectors.");
      for (const item of sorted) out.push(item.embedding);
    } catch {
      // Fallback per batch item
      for (const item of batch) {
        out.push(generateDeterministicVector(item, dim));
      }
    }
  }
  return out;
}

export async function embedBatch(texts: string[]): Promise<number[][]> {
  const results: number[][] = [];
  for (const text of texts) {
    const vec = await embedText(text, "passage");
    results.push(vec);
  }
  return results;
}
