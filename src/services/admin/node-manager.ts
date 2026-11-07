import { getDb } from "../db/index.js";
import crypto from "node:crypto";

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

export function listNodes(): InferenceNodeRecord[] {
  const db = getDb();
  return db.prepare("SELECT * FROM admin_inference_nodes ORDER BY created_at DESC").all() as unknown as InferenceNodeRecord[];
}

export function registerNode(data: {
  name: string;
  address: string;
  vram_total_bytes?: number;
}): InferenceNodeRecord {
  const db = getDb();
  const id = `node-${crypto.randomUUID()}`;
  const now = new Date().toISOString();

  const record: InferenceNodeRecord = {
    id,
    name: data.name,
    address: data.address,
    status: "healthy",
    enabled: 1,
    is_draining: 0,
    active_connections: 0,
    vram_used_bytes: 0,
    vram_total_bytes: data.vram_total_bytes || 16 * 1024 * 1024 * 1024, // 16GB
    latency_ms: 25,
    loaded_model_id: null,
    last_heartbeat_at: now,
    created_at: now,
  };

  db.prepare(`
    INSERT INTO admin_inference_nodes (
      id, name, address, status, enabled, is_draining, active_connections,
      vram_used_bytes, vram_total_bytes, latency_ms, loaded_model_id, last_heartbeat_at, created_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    )
  `).run(
    record.id, record.name, record.address, record.status, record.enabled,
    record.is_draining, record.active_connections, record.vram_used_bytes,
    record.vram_total_bytes, record.latency_ms, record.loaded_model_id ?? null,
    record.last_heartbeat_at, record.created_at
  );

  return record;
}

export function toggleDrainNode(nodeId: string): { success: boolean; is_draining?: number; error?: string } {
  const db = getDb();
  const node = db.prepare("SELECT * FROM admin_inference_nodes WHERE id = ?").get(nodeId) as InferenceNodeRecord | undefined;
  if (!node) return { success: false, error: "Node not found" };

  const nextDrain = node.is_draining ? 0 : 1;
  db.prepare("UPDATE admin_inference_nodes SET is_draining = ? WHERE id = ?").run(nextDrain, nodeId);
  return { success: true, is_draining: nextDrain };
}

export function toggleEnableNode(nodeId: string): { success: boolean; enabled?: number; error?: string } {
  const db = getDb();
  const node = db.prepare("SELECT * FROM admin_inference_nodes WHERE id = ?").get(nodeId) as InferenceNodeRecord | undefined;
  if (!node) return { success: false, error: "Node not found" };

  const nextEnabled = node.enabled ? 0 : 1;
  db.prepare("UPDATE admin_inference_nodes SET enabled = ? WHERE id = ?").run(nextEnabled, nodeId);
  return { success: true, enabled: nextEnabled };
}
