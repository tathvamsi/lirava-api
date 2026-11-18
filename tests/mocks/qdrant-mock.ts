import { cosineSimilarity } from "./embeddings-mock.js";

export interface MockQdrantPoint {
  id: string | number;
  vector: number[];
  payload: Record<string, any>;
}

export class MockQdrantClient {
  private collections = new Map<string, Map<string | number, MockQdrantPoint>>();

  constructor() {
    // Pre-create standard collection
    this.createCollection("soli_legal_corpus");
  }

  createCollection(name: string, _options?: any): Promise<{ status: string }> {
    if (!this.collections.has(name)) {
      this.collections.set(name, new Map());
    }
    return Promise.resolve({ status: "ok" });
  }

  getCollection(name: string): Promise<{
    points_count: number;
    status: string;
    config: { params: { vectors: { size: number; distance: string } } };
  }> {
    const col = this.collections.get(name);
    if (!col) {
      // Auto-create or return default
      return Promise.resolve({
        points_count: 0,
        status: "green",
        config: { params: { vectors: { size: 1024, distance: "Cosine" } } },
      });
    }
    return Promise.resolve({
      points_count: col.size,
      status: "green",
      config: { params: { vectors: { size: 1024, distance: "Cosine" } } },
    });
  }

  getCollections(): Promise<{ collections: Array<{ name: string }> }> {
    return Promise.resolve({
      collections: Array.from(this.collections.keys()).map((name) => ({ name })),
    });
  }

  deleteCollection(name: string): Promise<{ status: string }> {
    this.collections.delete(name);
    return Promise.resolve({ status: "ok" });
  }

  upsert(
    name: string,
    options: { wait?: boolean; points: Array<{ id: string | number; vector: number[]; payload?: any }> },
  ): Promise<{ operation_id: number; status: string }> {
    let col = this.collections.get(name);
    if (!col) {
      col = new Map();
      this.collections.set(name, col);
    }

    for (const p of options.points) {
      col.set(p.id, {
        id: p.id,
        vector: p.vector,
        payload: p.payload || {},
      });
    }

    return Promise.resolve({ operation_id: 1, status: "completed" });
  }

  private matchesFilter(payload: Record<string, any>, filter?: any): boolean {
    if (!filter) return true;
    if (filter.must && Array.isArray(filter.must)) {
      for (const clause of filter.must) {
        if (clause.key && clause.match && clause.match.value !== undefined) {
          const actual = payload[clause.key];
          const expected = clause.match.value;
          if (typeof actual === "string" && typeof expected === "string") {
            const a = actual.toLowerCase();
            const e = expected.toLowerCase();
            const actCode = (payload.act_code || "").toLowerCase();
            const codePrefix = actCode.split("_")[0];
            const aPrefix = a.split(/[\s,_]+/)[0];

            // Enforce strict mutual exclusion between BNS and BNSS
            if ((e === "bns" || e === "bns_2023") && (a === "bnss" || a.startsWith("bnss") || aPrefix === "bnss" || codePrefix === "bnss" || actCode.startsWith("bnss"))) {
              return false;
            }
            if ((e === "bnss" || e === "bnss_2023") && (a === "bns" || a.startsWith("bns_") || aPrefix === "bns" || codePrefix === "bns" || (actCode.startsWith("bns_") && !actCode.startsWith("bnss")))) {
              return false;
            }

            const matches =
              a === e ||
              (a.length > 0 && a.includes(e) && !(e === "bns" && (a === "bnss" || a.includes("bnss")))) ||
              (a.length > 0 && e.length > 0 && e.includes(a) && !(e === "bnss" && (a === "bns" || a.startsWith("bns_") || aPrefix === "bns"))) ||
              actCode === e ||
              codePrefix === e;
            if (!matches) return false;
          } else if (actual !== expected) {
            return false;
          }
        }
        if (clause.is_empty && clause.is_empty.key) {
          const val = payload[clause.is_empty.key];
          if (val !== undefined && val !== null && val !== "") return false;
        }
      }
    }
    return true;
  }

  query(
    name: string,
    options: {
      query: number[];
      limit?: number;
      score_threshold?: number;
      with_payload?: boolean;
      filter?: any;
    },
  ): Promise<{ points: Array<{ id: string | number; score: number; payload?: any }> }> {
    const col = this.collections.get(name);
    if (!col || col.size === 0) {
      return Promise.resolve({ points: [] });
    }

    const queryVec = options.query;
    const limit = options.limit ?? 5;
    const scoreThreshold = options.score_threshold ?? 0;

    const scoredPoints: Array<{ id: string | number; score: number; payload?: any }> = [];

    for (const item of col.values()) {
      if (!this.matchesFilter(item.payload, options.filter)) {
        continue;
      }
      const score = cosineSimilarity(queryVec, item.vector);
      if (score >= scoreThreshold) {
        scoredPoints.push({
          id: item.id,
          score,
          payload: options.with_payload !== false ? item.payload : undefined,
        });
      }
    }

    scoredPoints.sort((a, b) => b.score - a.score);
    return Promise.resolve({ points: scoredPoints.slice(0, limit) });
  }

  search(
    name: string,
    options: {
      vector: number[];
      limit?: number;
      score_threshold?: number;
      filter?: any;
    },
  ): Promise<Array<{ id: string | number; score: number; payload?: any }>> {
    return this.query(name, {
      query: options.vector,
      limit: options.limit,
      score_threshold: options.score_threshold,
      filter: options.filter,
      with_payload: true,
    }).then((res) => res.points);
  }

  scroll(
    name: string,
    options?: { limit?: number; filter?: any; with_payload?: boolean; with_vector?: boolean },
  ): Promise<{ points: Array<{ id: string | number; payload?: any; vector?: number[] }> }> {
    const col = this.collections.get(name);
    if (!col) return Promise.resolve({ points: [] });

    const limit = options?.limit ?? 100;
    const points: Array<{ id: string | number; payload?: any; vector?: number[] }> = [];

    for (const item of col.values()) {
      if (!this.matchesFilter(item.payload, options?.filter)) continue;
      points.push({
        id: item.id,
        payload: options?.with_payload !== false ? item.payload : undefined,
        vector: options?.with_vector ? item.vector : undefined,
      });
      if (points.length >= limit) break;
    }

    return Promise.resolve({ points });
  }

  delete(
    name: string,
    options: { wait?: boolean; points?: Array<string | number>; filter?: any },
  ): Promise<{ operation_id: number; status: string }> {
    const col = this.collections.get(name);
    if (col) {
      if (options.points && Array.isArray(options.points)) {
        for (const id of options.points) {
          col.delete(id);
        }
      }
      if (options.filter) {
        for (const [id, item] of Array.from(col.entries())) {
          if (this.matchesFilter(item.payload, options.filter)) {
            col.delete(id);
          }
        }
      }
    }
    return Promise.resolve({ operation_id: 2, status: "completed" });
  }

  count(name: string): Promise<{ count: number }> {
    const col = this.collections.get(name);
    return Promise.resolve({ count: col ? col.size : 0 });
  }

  clear(): void {
    this.collections.clear();
    this.createCollection("soli_legal_corpus");
  }
}

let activeMockQdrant: MockQdrantClient | null = null;

export function createMockQdrant(): MockQdrantClient {
  activeMockQdrant = new MockQdrantClient();
  return activeMockQdrant;
}

export function getMockQdrant(): MockQdrantClient {
  if (!activeMockQdrant) {
    activeMockQdrant = new MockQdrantClient();
  }
  return activeMockQdrant;
}

export function resetMockQdrant(): void {
  if (activeMockQdrant) {
    activeMockQdrant.clear();
  }
}
