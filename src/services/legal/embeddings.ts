import { config } from "../../config.js";

interface EmbeddingResponse {
  data: Array<{
    embedding: number[];
    index: number;
  }>;
}

const embeddingCache = new Map<string, number[]>();
const MAX_CACHE_SIZE = 500;

export async function embedText(text: string): Promise<number[]> {
  const normalized = text.trim();
  if (!normalized) {
    return new Array(config.embeddingDimensions).fill(0);
  }

  const cached = embeddingCache.get(normalized);
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
      }),
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
    embeddingCache.set(normalized, vector);

    return vector;
  } catch (err: any) {
    console.warn(`\x1b[33m[embeddings]\x1b[0m ⚠️ Failed to generate embedding from ${endpoint}: ${err.message}`);
    throw err;
  }
}

export async function embedBatch(texts: string[]): Promise<number[][]> {
  const results: number[][] = [];
  for (const text of texts) {
    const vec = await embedText(text);
    results.push(vec);
  }
  return results;
}
