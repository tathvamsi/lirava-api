import { QdrantClient } from "@qdrant/js-client-rest";
import { config } from "../../config.js";
import { embedText } from "./embeddings.js";

let qdrantClient: QdrantClient | null = null;

export function getQdrant(): QdrantClient {
  if (qdrantClient) return qdrantClient;

  qdrantClient = new QdrantClient({
    url: config.qdrantUrl,
    apiKey: config.qdrantApiKey,
    checkCompatibility: false,
  });

  return qdrantClient;
}

export interface LegalSearchResult {
  id: string | number;
  score: number;
  payload?: {
    act?: string;
    section?: string;
    title?: string;
    text?: string;
    statutoryText?: string;
    ratio?: string;
    source?: string;
    court?: string;
    year?: number;
    category?: string;
    [key: string]: any;
  };
}

export interface LegalChunkPoint {
  id: string | number;
  vector: number[];
  payload: {
    act: string;
    section: string;
    title: string;
    text: string;
    statutoryText?: string;
    ratio?: string;
    source?: string;
    court?: string;
    year?: number;
    category?: string;
    [key: string]: any;
  };
}

/**
 * Perform semantic vector cosine similarity search against Qdrant legal corpus.
 */
export async function searchStatutes(
  query: string,
  limit: number = config.topK,
  actFilter?: string
): Promise<LegalSearchResult[]> {
  const collectionName = config.qdrantCollection || "soli_legal_corpus";
  const trimmed = query.trim();
  if (!trimmed) return [];

  try {
    const qdrant = getQdrant();

    // 1. Generate 1024-dimension query vector using local bge-m3 embedding model
    const vector = await embedText(trimmed);

    // 2. Build metadata filter if specified
    const filter = actFilter
      ? {
          must: [
            {
              key: "act",
              match: { value: actFilter },
            },
          ],
        }
      : undefined;

    console.log(
      `\x1b[36m[legal-qdrant]\x1b[0m 🔍 Vector search in '${collectionName}' (topK=${limit}, filter=${actFilter || "none"}): "${trimmed.slice(0, 60)}..."`
    );

    // 3. Query Qdrant vector index
    const response = await qdrant.query(collectionName, {
      query: vector,
      limit,
      score_threshold: 0.35,
      with_payload: true,
      filter,
    });

    const points = response.points || [];

    console.log(
      `\x1b[36m[legal-qdrant]\x1b[0m ✔ Vector search returned ${points.length} matches (top score: ${points[0]?.score?.toFixed(3) ?? "n/a"})`
    );

    return points.map((p: any) => ({
      id: p.id,
      score: p.score,
      payload: p.payload as any,
    }));
  } catch (err: any) {
    console.warn(`\x1b[33m[legal-qdrant] ⚠️ Vector search failed in '${collectionName}':\x1b[0m ${err.message}`);
    return [];
  }
}

/**
 * Upsert vector chunks into the Qdrant legal corpus collection.
 */
export async function upsertLegalChunks(points: LegalChunkPoint[]): Promise<boolean> {
  const collectionName = config.qdrantCollection || "soli_legal_corpus";
  if (!points || points.length === 0) return true;

  try {
    const qdrant = getQdrant();
    await qdrant.upsert(collectionName, {
      wait: true,
      points: points.map((p) => ({
        id: p.id,
        vector: p.vector,
        payload: p.payload,
      })),
    });
    console.log(`\x1b[32m[legal-qdrant]\x1b[0m ✔ Successfully upserted ${points.length} points to '${collectionName}'`);
    return true;
  } catch (err: any) {
    console.error(`\x1b[31m[legal-qdrant]\x1b[0m ❌ Failed to upsert points to '${collectionName}': ${err.message}`);
    throw err;
  }
}
