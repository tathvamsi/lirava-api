import { Hono } from "hono";
import { listModels, registerModel, loadModel, unloadModel } from "../services/admin/model-registry.js";
import { listNodes, registerNode, toggleDrainNode, toggleEnableNode } from "../services/admin/node-manager.js";
import { listDocuments, ingestDocument, deleteDocument } from "../services/admin/ingestion-pipeline.js";
import { listApiKeys, createApiKey, revokeApiKey } from "../services/admin/api-keys.js";
import { getTelemetryMetrics } from "../services/admin/telemetry.js";
import { listAuditLogs } from "../services/admin/audit-ledger.js";
import { checkLlmHealth } from "../services/agent/client.js";
import { getDb } from "../services/db/index.js";
import { config } from "../config.js";
import { getQdrant } from "../services/legal/qdrant.js";
import os from "node:os";
import fs from "node:fs";
export const adminRoutes = new Hono();
// Live operational snapshot used by the separate admin console.
adminRoutes.get("/overview", async (c) => {
    const db = getDb();
    const count = (table) => {
        const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get();
        return Number(row.count);
    };
    const recentMessages = db
        .prepare("SELECT COUNT(*) AS count FROM messages WHERE created_at >= ?")
        .get(Date.now() - 24 * 60 * 60 * 1000);
    const [llm, qdrant] = await Promise.all([
        checkLlmHealth(),
        Promise.all([
            getQdrant().getCollection(config.qdrantCollection),
            getQdrant().scroll(config.qdrantCollection, { limit: 100, with_payload: true, with_vector: false }),
        ])
            .then(([collection, scroll]) => ({
            status: "online",
            points: Number(collection.points_count ?? 0),
            documents: scroll.points.map((point) => {
                const payload = (point.payload || {});
                return {
                    id: String(point.id),
                    act: typeof payload.act === "string" ? payload.act : "",
                    section: typeof payload.section === "string" ? payload.section : "",
                    title: typeof payload.title === "string" ? payload.title : "Untitled corpus record",
                    category: typeof payload.category === "string" ? payload.category : "",
                    source: typeof payload.source === "string" ? payload.source : "",
                    year: typeof payload.year === "number" ? payload.year : null,
                };
            }),
        }))
            .catch(() => ({ status: "offline", points: null, documents: [] })),
    ]);
    return c.json({
        generatedAt: new Date().toISOString(),
        workspace: {
            assistants: count("dots"),
            conversations: count("conversations"),
            messages: count("messages"),
            messagesLast24h: Number(recentMessages.count),
            artifacts: count("artifacts"),
            files: count("files"),
        },
        services: {
            llm: { status: llm.status, latencyMs: llm.latencyMs, model: llm.model },
            qdrant,
        },
    });
});
// ---------------- Models ----------------
adminRoutes.get("/models", (c) => {
    const models = listModels();
    return c.json({ models });
});
adminRoutes.post("/models", async (c) => {
    const body = await c.req.json();
    const record = registerModel(body);
    return c.json({ success: true, model: record });
});
adminRoutes.post("/models/:id/load", async (c) => {
    const modelId = c.req.param("id");
    const { nodeId } = await c.req.json();
    const res = loadModel(modelId, nodeId);
    return c.json(res);
});
adminRoutes.post("/models/:id/unload", (c) => {
    const modelId = c.req.param("id");
    const res = unloadModel(modelId);
    return c.json(res);
});
// ---------------- Nodes ----------------
adminRoutes.get("/nodes", (c) => {
    const nodes = listNodes();
    return c.json({ nodes });
});
adminRoutes.post("/nodes", async (c) => {
    const body = await c.req.json();
    const record = registerNode(body);
    return c.json({ success: true, node: record });
});
adminRoutes.post("/nodes/:id/drain", (c) => {
    const nodeId = c.req.param("id");
    const res = toggleDrainNode(nodeId);
    return c.json(res);
});
adminRoutes.post("/nodes/:id/toggle", (c) => {
    const nodeId = c.req.param("id");
    const res = toggleEnableNode(nodeId);
    return c.json(res);
});
// ---------------- Documents ----------------
adminRoutes.get("/documents", (c) => {
    const orgId = c.req.query("orgId") || "org-legal-corp";
    const status = c.req.query("status");
    const documents = listDocuments(orgId, status);
    return c.json({ documents });
});
adminRoutes.post("/documents", async (c) => {
    try {
        const formData = await c.req.formData();
        const file = formData.get("file");
        const orgId = formData.get("orgId") || "org-legal-corp";
        const title = formData.get("title") || file?.name || "Uploaded Document";
        if (!file) {
            return c.json({ error: "Missing file" }, 400);
        }
        const buffer = Buffer.from(await file.arrayBuffer());
        const doc = await ingestDocument({
            organizationId: orgId,
            title,
            fileName: file.name,
            mimeType: file.type || "application/octet-stream",
            fileBuffer: buffer,
        });
        return c.json({ success: true, document: doc });
    }
    catch (err) {
        return c.json({ error: err.message }, 500);
    }
});
adminRoutes.delete("/documents/:id", (c) => {
    const docId = c.req.param("id");
    const orgId = c.req.query("orgId") || "org-legal-corp";
    const deleted = deleteDocument(docId, orgId);
    return c.json({ success: deleted });
});
// ---------------- API Keys ----------------
adminRoutes.get("/api-keys", (c) => {
    const orgId = c.req.query("orgId") || "org-legal-corp";
    const keys = listApiKeys(orgId);
    return c.json({ keys });
});
adminRoutes.post("/api-keys", async (c) => {
    const body = await c.req.json();
    const res = createApiKey(body);
    return c.json(res);
});
adminRoutes.delete("/api-keys/:id", (c) => {
    const keyId = c.req.param("id");
    const orgId = c.req.query("orgId") || "org-legal-corp";
    const revoked = revokeApiKey(keyId, orgId);
    return c.json({ success: revoked });
});
// ---------------- Telemetry & Analytics ----------------
adminRoutes.get("/analytics", (c) => {
    const timeRange = c.req.query("timeRange") || "24h";
    const orgId = c.req.query("orgId");
    const data = getTelemetryMetrics(timeRange, orgId);
    return c.json(data);
});
// ---------------- Audit Logs ----------------
adminRoutes.get("/audit-logs", (c) => {
    const orgId = c.req.query("orgId") || "org-legal-corp";
    const logs = listAuditLogs(orgId);
    return c.json({ events: logs, total: logs.length, totalPages: 1 });
});
// ---------------- System Health ----------------
adminRoutes.get("/health", async (c) => {
    const llm = await checkLlmHealth();
    const db = getDb();
    const hostTelemetryEnabled = process.env.BACKEND_HOST_TELEMETRY === "true";
    const memory = process.memoryUsage();
    const heapUsedMb = hostTelemetryEnabled ? Math.round(memory.heapUsed / 1024 / 1024) : null;
    const heapTotalMb = hostTelemetryEnabled ? Math.round(memory.heapTotal / 1024 / 1024) : null;
    const rssMb = hostTelemetryEnabled ? Math.round(memory.rss / 1024 / 1024) : null;
    let systemUsedPct = null;
    let totalDiskGb = null;
    let availableDiskGb = null;
    let diskUsedPct = null;
    if (hostTelemetryEnabled) {
        const totalMem = os.totalmem();
        const freeMem = os.freemem();
        systemUsedPct = Math.round(((totalMem - freeMem) / totalMem) * 100);
        try {
            const stat = fs.statfsSync(process.cwd());
            const totalBytes = stat.bsize * stat.blocks;
            const freeBytes = stat.bsize * stat.bfree;
            totalDiskGb = Number((totalBytes / 1024 ** 3).toFixed(1));
            availableDiskGb = Number((freeBytes / 1024 ** 3).toFixed(1));
            diskUsedPct = totalBytes ? Math.round(((totalBytes - freeBytes) / totalBytes) * 100) : 0;
        }
        catch { }
    }
    const inferenceNodes = db.prepare("SELECT id, name, address, status, enabled, active_connections, vram_used_bytes, vram_total_bytes, latency_ms FROM admin_inference_nodes ORDER BY created_at DESC").all();
    const models = db.prepare("SELECT id, name, status, provider, active_node_id FROM admin_models ORDER BY created_at DESC").all();
    const queue = db.prepare("SELECT coalesce(sum(CASE WHEN status = 'QUEUED' THEN 1 ELSE 0 END), 0) queued, coalesce(sum(CASE WHEN status = 'PROCESSING' THEN 1 ELSE 0 END), 0) processing, coalesce(sum(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END), 0) failed FROM admin_jobs").get();
    const memoryPressure = hostTelemetryEnabled && (systemUsedPct > 85 || heapUsedMb / Math.max(heapTotalMb, 1) > 0.85);
    const lowDiskSpace = hostTelemetryEnabled && (availableDiskGb < 20 || diskUsedPct > 85);
    const unhealthyNodes = inferenceNodes.some((node) => !["healthy", "online"].includes(node.status));
    const activeAlerts = [
        ...(memoryPressure ? [`High memory pressure detected on backend host (${systemUsedPct}% host RAM in use).`] : []),
        ...(lowDiskSpace ? [`Low disk space on backend host (${availableDiskGb} GB remaining, ${diskUsedPct}% used).`] : []),
        ...(unhealthyNodes ? ["One or more backend inference nodes are offline or degraded."] : []),
        ...(queue.failed >= 3 ? [`Repeated job failures detected (${queue.failed} failures).`] : []),
    ];
    return c.json({
        status: activeAlerts.length ? "degraded" : "healthy",
        uptimeSeconds: Math.floor(process.uptime()),
        uptimeFormatted: `${Math.floor(process.uptime() / 3600)}h ${Math.floor(process.uptime() / 60) % 60}m`,
        hostTelemetryAvailable: hostTelemetryEnabled,
        memory: { heapUsedMb, heapTotalMb, rssMb, systemUsedPct },
        disk: { totalGb: totalDiskGb, availableGb: availableDiskGb, usedPct: diskUsedPct },
        inferenceNodes: inferenceNodes.map((node) => ({ id: node.id, name: node.name, status: node.status, addressMasked: node.address, latencyMs: node.latency_ms, activeRequests: node.active_connections, maxConcurrency: 0, vramUsage: `${Math.round(node.vram_used_bytes / 1024 ** 3)}GB / ${Math.round(node.vram_total_bytes / 1024 ** 3)}GB` })),
        models,
        queueDepth: { queuedJobs: queue.queued, processingJobs: queue.processing, failedJobsLast24h: queue.failed },
        alerts: { memoryPressure, lowDiskSpace, unhealthyNodes, repeatedJobFailures: queue.failed >= 3, activeAlerts },
        llm,
        timestamp: new Date().toISOString(),
    });
});
