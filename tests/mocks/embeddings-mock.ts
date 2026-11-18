import crypto from "node:crypto";

/**
 * Deterministic vector generator for test environments.
 * Maps text tokens into a 1024-dimensional space with L2 normalization.
 * Texts sharing relevant legal keywords will yield higher cosine similarity.
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

    // Also project word bigrams / character prefixes for subword matching
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

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return dot / denom;
}

export async function mockEmbedText(text: string, _kind: "query" | "passage" = "query"): Promise<number[]> {
  return generateDeterministicVector(text, 1024);
}

export async function mockEmbedMany(texts: string[], _kind: "passage" = "passage", _batchSize = 16): Promise<number[][]> {
  return texts.map((t) => generateDeterministicVector(t, 1024));
}

export async function mockEmbedBatch(texts: string[]): Promise<number[][]> {
  return texts.map((t) => generateDeterministicVector(t, 1024));
}

let originalFetch: typeof globalThis.fetch | null = null;

export function setupMockEmbeddingsFetch(): void {
  if (originalFetch) return; // already active

  originalFetch = globalThis.fetch;
  globalThis.fetch = async function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const urlStr = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;

    if (urlStr.includes("/embeddings")) {
      let bodyText = "";
      if (typeof init?.body === "string") {
        bodyText = init.body;
      } else if (init?.body) {
        bodyText = init.body.toString();
      }

      let parsed: any = {};
      try {
        parsed = JSON.parse(bodyText);
      } catch {
        parsed = {};
      }

      const inputVal = parsed.input;
      let data: Array<{ embedding: number[]; index: number }> = [];

      if (Array.isArray(inputVal)) {
        data = inputVal.map((text: string, index: number) => ({
          embedding: generateDeterministicVector(String(text), 1024),
          index,
        }));
      } else {
        const text = typeof inputVal === "string" ? inputVal : "";
        data = [
          {
            embedding: generateDeterministicVector(text, 1024),
            index: 0,
          },
        ];
      }

      return new Response(
        JSON.stringify({
          object: "list",
          data,
          model: parsed.model || "bge-m3",
          usage: { prompt_tokens: 10, total_tokens: 10 },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    if (originalFetch) {
      return originalFetch.call(globalThis, input, init);
    }
    throw new Error(`fetch not mocked for URL: ${urlStr}`);
  };
}

export function restoreMockEmbeddingsFetch(): void {
  if (originalFetch) {
    globalThis.fetch = originalFetch;
    originalFetch = null;
  }
}
