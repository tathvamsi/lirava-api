import { QdrantClient } from "@qdrant/js-client-rest";
import { config } from "../../config.js";
import { embedText } from "./embeddings.js";

let qdrantClient: QdrantClient | null = null;

export function setQdrant(client: QdrantClient | null): void {
  qdrantClient = client;
}

export function getQdrant(): QdrantClient {
  if (qdrantClient) return qdrantClient;

  qdrantClient = new QdrantClient({
    url: config.qdrantUrl,
    apiKey: config.qdrantApiKey,
    checkCompatibility: false,
    timeout: config.upstreamTimeoutMs,
  });

  return qdrantClient;
}

export interface StatutoryQdrantPayload {
  id: string;
  entity_type: "provision";
  act_code: string;
  act_title: string;
  section: string;
  section_num: string;
  title: string;
  text: string;
  statutoryText: string;
  ratio?: string;
  category: string;
  year: number;
  source: string;
  replaces?: { act_code: string; section: string };
  replaced_by?: { act_code: string; section: string };
  act: string;
  [key: string]: any;
}

export interface PrecedentQdrantPayload {
  id: string;
  entity_type: "precedent";
  case_title: string;
  primary_citation: string;
  equivalent_citations: string[];
  neutral_citation?: string;
  court: string;
  year: number;
  bench_description?: string;
  ratio: string;
  principles: string[];
  statutory_citations: Array<{ act_code: string; section: string }>;
  category: string;
  source: string;
  act: string;
  section: string;
  title: string;
  text: string;
  statutoryText: string;
  [key: string]: any;
}

export type LegalCorpusPayload = StatutoryQdrantPayload | PrecedentQdrantPayload | Record<string, any>;

export interface LegalSearchResult {
  id: string | number;
  score: number;
  payload?: LegalCorpusPayload;
}

export interface LegalChunkPoint {
  id: string | number;
  vector: number[];
  payload: LegalCorpusPayload;
}

/**
 * Ensures Qdrant collection 'soli_legal_corpus' exists with 1024-dim Cosine vectors
 * and creates keyword payload indices.
 */
export async function ensureLegalCorpusCollection(): Promise<void> {
  const collectionName = config.qdrantCollection || "soli_legal_corpus";
  const qdrant = getQdrant();

  let exists = false;
  try {
    if (typeof (qdrant as any).collectionExists === "function") {
      const res = await (qdrant as any).collectionExists(collectionName);
      exists = Boolean(res?.exists ?? res);
    } else if (typeof qdrant.getCollections === "function") {
      const res = await qdrant.getCollections();
      exists = res.collections.some((c) => c.name === collectionName);
    } else if (typeof qdrant.getCollection === "function") {
      await qdrant.getCollection(collectionName);
      exists = true;
    }
  } catch {
    exists = false;
  }

  if (!exists) {
    console.log(`\x1b[34m[legal-qdrant]\x1b[0m 🔨 Creating Qdrant collection '${collectionName}' (1024-dim, Cosine)...`);
    await qdrant.createCollection(collectionName, {
      vectors: {
        size: 1024,
        distance: "Cosine",
      },
    });
  }

  // Create payload index for performance filtering
  if (typeof (qdrant as any).createPayloadIndex === "function") {
    for (const field of ["entity_type", "act_code", "category"]) {
      try {
        await (qdrant as any).createPayloadIndex(collectionName, {
          field_name: field,
          field_schema: "keyword",
        });
      } catch {
        // Safe to ignore if already exists or unsupported by mock
      }
    }
  }
}

/**
 * Perform semantic vector cosine similarity search against Qdrant legal corpus.
 */
export async function searchStatutes(
  query: string,
  limit: number = config.topK,
  actFilter?: string,
  entityType?: "provision" | "precedent",
): Promise<LegalSearchResult[]> {
  const collectionName = config.qdrantCollection || "soli_legal_corpus";
  const trimmed = query.trim();
  if (!trimmed) return [];

  try {
    const qdrant = getQdrant();

    // 1. Generate 1024-dimension query vector
    const vector = await embedText(trimmed);

    // 2. Build metadata filter if specified
    const mustConditions: any[] = [];
    if (actFilter) {
      mustConditions.push({
        key: "act",
        match: { value: actFilter },
      });
    }
    if (entityType) {
      mustConditions.push({
        key: "entity_type",
        match: { value: entityType },
      });
    }
    const filter = mustConditions.length > 0 ? { must: mustConditions } : undefined;

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
    await ensureLegalCorpusCollection();
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
