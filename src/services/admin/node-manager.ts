import crypto from "node:crypto";
import { pgData } from "../data/pg.js";

export interface InferenceNodeRecord {
  id: string;
  name: string;
  address: string;
  status: string;
  enabled: number;
  is_draining: number;
  active_connections: number;
  vram_used_bytes: number;
  vram_total_bytes: number;
  latency_ms: number;
  loaded_model_id?: string | null;
  last_heartbeat_at: string;
  created_at: string;
}

const toNode = (r: Record<string, any>): InferenceNodeRecord => ({
  ...(r as InferenceNodeRecord),
  enabled: Number(r.enabled),
  is_draining: Number(r.is_draining),
  active_connections: Number(r.active_connections),
  vram_used_bytes: Number(r.vram_used_bytes),
  vram_total_bytes: Number(r.vram_total_bytes),
  latency_ms: Number(r.latency_ms),
});

export async function listNodes(): Promise<InferenceNodeRecord[]> {
  const sql = await pgData();
  return (await sql`SELECT * FROM app_nodes ORDER BY created_at DESC`).map(toNode);
}

export async function registerNode(data: { name: string; address: string; vram_total_bytes?: number }): Promise<InferenceNodeRecord> {
  const sql = await pgData();
  const id = `node-${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  const rows = await sql`
    INSERT INTO app_nodes (id, name, address, status, enabled, is_draining, active_connections, vram_used_bytes, vram_total_bytes, latency_ms, last_heartbeat_at, created_at)
    VALUES (${id}, ${data.name}, ${data.address}, 'healthy', 1, 0, 0, 0, ${data.vram_total_bytes || 16 * 1024 * 1024 * 1024}, 25, ${now}, ${now})
    RETURNING *`;
  return toNode(rows[0]);
}

export async function toggleDrainNode(nodeId: string): Promise<{ success: boolean; is_draining?: number; error?: string }> {
  const sql = await pgData();
  const rows = await sql`UPDATE app_nodes SET is_draining = 1 - is_draining WHERE id = ${nodeId} RETURNING is_draining`;
  return rows[0] ? { success: true, is_draining: Number(rows[0].is_draining) } : { success: false, error: "Node not found" };
}

export async function toggleEnableNode(nodeId: string): Promise<{ success: boolean; enabled?: number; error?: string }> {
  const sql = await pgData();
  const rows = await sql`UPDATE app_nodes SET enabled = 1 - enabled WHERE id = ${nodeId} RETURNING enabled`;
  return rows[0] ? { success: true, enabled: Number(rows[0].enabled) } : { success: false, error: "Node not found" };
}
