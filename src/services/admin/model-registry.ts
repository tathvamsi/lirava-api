import { getDb } from "../db/index.js";
import crypto from "node:crypto";

export interface ModelRecord {
  id: string;
  name: string;
  provider: string;
  gguf_file: string;
  quantization: string;
  context_window: number;
  disk_size_bytes: number;
  status: string;
  storage_path: string;
  temperature: number;
  top_p: number;
  active_node_id?: string | null;
  error_message?: string | null;
  created_at: string;
  updated_at: string;
}

export function listModels(): ModelRecord[] {
  const db = getDb();
  return db.prepare("SELECT * FROM admin_models ORDER BY created_at DESC").all() as unknown as ModelRecord[];
}

export function registerModel(data: {
  name: string;
  provider?: string;
  gguf_file: string;
  quantization?: string;
  context_window?: number;
  disk_size_bytes?: number;
  storage_path: string;
  temperature?: number;
  top_p?: number;
}): ModelRecord {
  const db = getDb();
  const id = `model-${crypto.randomUUID()}`;
  const now = new Date().toISOString();

  const record: ModelRecord = {
    id,
    name: data.name,
    provider: data.provider || "llama.cpp",
    gguf_file: data.gguf_file,
    quantization: data.quantization || "Q4_K_M",
    context_window: data.context_window || 4096,
    disk_size_bytes: data.disk_size_bytes || 0,
    status: "ready",
    storage_path: data.storage_path,
    temperature: data.temperature ?? 0.2,
    top_p: data.top_p ?? 0.85,
    active_node_id: null,
    error_message: null,
    created_at: now,
    updated_at: now,
  };

  db.prepare(`
    INSERT INTO admin_models (
      id, name, provider, gguf_file, quantization, context_window, disk_size_bytes,
      status, storage_path, temperature, top_p, active_node_id, error_message, created_at, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    )
  `).run(
    record.id, record.name, record.provider, record.gguf_file, record.quantization,
    record.context_window, record.disk_size_bytes, record.status, record.storage_path,
    record.temperature, record.top_p, record.active_node_id ?? null, record.error_message ?? null,
    record.created_at, record.updated_at
  );

  return record;
}

export function loadModel(modelId: string, nodeId: string): { success: boolean; error?: string } {
  const db = getDb();
  const model = db.prepare("SELECT * FROM admin_models WHERE id = ?").get(modelId) as ModelRecord | undefined;
  if (!model) return { success: false, error: "Model not found" };

  db.prepare(`
    UPDATE admin_models
    SET status = 'loaded', active_node_id = ?, updated_at = ?
    WHERE id = ?
  `).run(nodeId, new Date().toISOString(), modelId);

  return { success: true };
}

export function unloadModel(modelId: string): { success: boolean; error?: string } {
  const db = getDb();
  const model = db.prepare("SELECT * FROM admin_models WHERE id = ?").get(modelId) as ModelRecord | undefined;
  if (!model) return { success: false, error: "Model not found" };

  db.prepare(`
    UPDATE admin_models
    SET status = 'ready', active_node_id = NULL, updated_at = ?
    WHERE id = ?
  `).run(new Date().toISOString(), modelId);

  return { success: true };
}
