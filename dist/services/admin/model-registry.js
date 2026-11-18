import crypto from "node:crypto";
import { pgData } from "../data/pg.js";
const toModel = (r) => ({
    ...r,
    context_window: Number(r.context_window),
    disk_size_bytes: Number(r.disk_size_bytes),
    temperature: Number(r.temperature),
    top_p: Number(r.top_p),
});
export async function listModels() {
    const sql = await pgData();
    return (await sql `SELECT * FROM app_models ORDER BY created_at DESC`).map(toModel);
}
export async function registerModel(data) {
    const sql = await pgData();
    const id = `model-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    const rows = await sql `
    INSERT INTO app_models (id, name, provider, gguf_file, quantization, context_window, disk_size_bytes, status, storage_path, temperature, top_p, created_at, updated_at)
    VALUES (${id}, ${data.name}, ${data.provider || "llama.cpp"}, ${data.gguf_file}, ${data.quantization || "Q4_K_M"}, ${data.context_window || 4096},
            ${data.disk_size_bytes || 0}, 'ready', ${data.storage_path}, ${data.temperature ?? 0.2}, ${data.top_p ?? 0.85}, ${now}, ${now})
    RETURNING *`;
    return toModel(rows[0]);
}
export async function loadModel(modelId, nodeId) {
    const sql = await pgData();
    const rows = await sql `UPDATE app_models SET status = 'loaded', active_node_id = ${nodeId}, updated_at = ${new Date().toISOString()} WHERE id = ${modelId} RETURNING id`;
    return rows.length ? { success: true } : { success: false, error: "Model not found" };
}
export async function unloadModel(modelId) {
    const sql = await pgData();
    const rows = await sql `UPDATE app_models SET status = 'ready', active_node_id = NULL, updated_at = ${new Date().toISOString()} WHERE id = ${modelId} RETURNING id`;
    return rows.length ? { success: true } : { success: false, error: "Model not found" };
}
