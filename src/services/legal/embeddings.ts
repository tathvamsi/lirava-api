import { config } from "../../config.js";

interface EmbeddingResponse {
  data: Array<{
    embedding: number[];
    index: number;
  }>;
}

const embeddingCache = new Map<string, number[]>();
const MAX_CACHE_SIZE = 500;

/**
 * NVIDIA's embedding models are asymmetric: a search question and a stored passage are embedded differently,
 * and the request must say which. Your own server ignores the extra field, so it is sent only to NVIDIA.
 */
export type EmbeddingKind = "query" | "passage";

export async function embedText(text: string, kind: EmbeddingKind = "query"): Promise<number[]> {
  const normalized = text.trim();
  if (!normalized) {
    return new Array(config.embeddingDimensions).fill(0);
  }

  const cacheKey = `${kind}:${normalized}`;
  const cached = embeddingCache.get(cacheKey);
  if (cached) {
    return cached;
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
        ...(config.ownLlm ? {} : { input_type: kind, truncate: "END", dimensions: config.embeddingDimensions }),
      }),
      // Without a limit an unreachable embedding server stalls every chat message for ~30 seconds.
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
    console.warn(`\x1b[33m[embeddings]\x1b[0m ⚠️ Failed to generate embedding from ${endpoint}: ${err.message}`);
    throw err;
  }
}

/** Many texts in few requests (the admin tools index whole Acts). Order of the results matches the input. */
export async function embedMany(texts: string[], kind: EmbeddingKind = "passage", batchSize = 16): Promise<number[][]> {
  const endpoint = `${config.customLlmBaseUrl.replace(/\/+$/, "")}/embeddings`;
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize).map((t) => t.trim() || " ");
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.customLlmApiKey}` },
      body: JSON.stringify({
        model: config.customEmbeddingModel,
        input: batch,
        ...(config.ownLlm ? {} : { input_type: kind, truncate: "END", dimensions: config.embeddingDimensions }),
      }),
      signal: AbortSignal.timeout(Math.max(config.upstreamTimeoutMs, 30_000)),
    });
    if (!res.ok) throw new Error(`Embedding request failed with HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const json = (await res.json()) as EmbeddingResponse;
    const sorted = [...(json.data || [])].sort((a, b) => a.index - b.index);
    if (sorted.length !== batch.length) throw new Error("The embedding server returned the wrong number of vectors.");
    for (const item of sorted) out.push(item.embedding);
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
