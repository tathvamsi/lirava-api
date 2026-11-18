import { QdrantClient } from "@qdrant/js-client-rest";
import { config } from "../../config.js";
import { embedText } from "./embeddings.js";
let qdrantClient = null;
export function setQdrant(client) {
    qdrantClient = client;
}
export function getQdrant() {
    if (qdrantClient)
        return qdrantClient;
    qdrantClient = new QdrantClient({
        url: config.qdrantUrl,
        apiKey: config.qdrantApiKey,
        checkCompatibility: false,
        timeout: config.upstreamTimeoutMs,
    });
    return qdrantClient;
}
/**
 * Ensures Qdrant collection 'soli_legal_corpus' exists with 1024-dim Cosine vectors
 * and creates keyword payload indices.
 */
export async function ensureLegalCorpusCollection() {
    const collectionName = config.qdrantCollection || "soli_legal_corpus";
    const qdrant = getQdrant();
    let exists = false;
    try {
        if (typeof qdrant.collectionExists === "function") {
            const res = await qdrant.collectionExists(collectionName);
            exists = Boolean(res?.exists ?? res);
        }
        else if (typeof qdrant.getCollections === "function") {
            const res = await qdrant.getCollections();
            exists = res.collections.some((c) => c.name === collectionName);
        }
        else if (typeof qdrant.getCollection === "function") {
            await qdrant.getCollection(collectionName);
            exists = true;
        }
    }
    catch {
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
    if (typeof qdrant.createPayloadIndex === "function") {
        for (const field of ["entity_type", "act_code", "category"]) {
            try {
                await qdrant.createPayloadIndex(collectionName, {
                    field_name: field,
                    field_schema: "keyword",
                });
            }
            catch {
                // Safe to ignore if already exists or unsupported by mock
            }
        }
    }
}
/**
 * Perform semantic vector cosine similarity search against Qdrant legal corpus.
 */
export async function searchStatutes(query, limit = config.topK, actFilter, entityType) {
    const collectionName = config.qdrantCollection || "soli_legal_corpus";
    const trimmed = query.trim();
    if (!trimmed)
        return [];
    try {
        const qdrant = getQdrant();
        // 1. Generate 1024-dimension query vector
        const vector = await embedText(trimmed);
        // 2. Build metadata filter if specified
        const mustConditions = [];
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
        console.log(`\x1b[36m[legal-qdrant]\x1b[0m 🔍 Vector search in '${collectionName}' (topK=${limit}, filter=${actFilter || "none"}): "${trimmed.slice(0, 60)}..."`);
        // 3. Query Qdrant vector index
        const response = await qdrant.query(collectionName, {
            query: vector,
            limit,
            score_threshold: 0.35,
            with_payload: true,
            filter,
        });
        const points = response.points || [];
        console.log(`\x1b[36m[legal-qdrant]\x1b[0m ✔ Vector search returned ${points.length} matches (top score: ${points[0]?.score?.toFixed(3) ?? "n/a"})`);
        return points.map((p) => ({
            id: p.id,
            score: p.score,
            payload: p.payload,
        }));
    }
    catch (err) {
        console.warn(`\x1b[33m[legal-qdrant] ⚠️ Vector search failed in '${collectionName}':\x1b[0m ${err.message}`);
        return [];
    }
}
/**
 * Upsert vector chunks into the Qdrant legal corpus collection.
 */
export async function upsertLegalChunks(points) {
    const collectionName = config.qdrantCollection || "soli_legal_corpus";
    if (!points || points.length === 0)
        return true;
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
    }
    catch (err) {
        console.error(`\x1b[31m[legal-qdrant]\x1b[0m ❌ Failed to upsert points to '${collectionName}': ${err.message}`);
        throw err;
    }
}
