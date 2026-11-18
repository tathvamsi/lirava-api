import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { requireAuth } from "../middleware/auth.js";
import { requireAdmin } from "../middleware/security.js";
import { listModels, registerModel, loadModel, unloadModel } from "../services/admin/model-registry.js";
import { listNodes, registerNode, toggleDrainNode, toggleEnableNode } from "../services/admin/node-manager.js";
import { listDocuments, ingestDocument, deleteDocument } from "../services/admin/ingestion-pipeline.js";
import { indexProvisions } from "../services/admin/corpus.js";
import { adminExtraRoutes } from "./admin-extra.routes.js";
import { listApiKeys, createApiKey, revokeApiKey } from "../services/admin/api-keys.js";
import { getTelemetryMetrics } from "../services/admin/telemetry.js";
import { listAuditLogs, logAuditEvent } from "../services/admin/audit-ledger.js";
import { checkLlmHealth } from "../services/agent/client.js";
import { pgData } from "../services/data/pg.js";
import { config } from "../config.js";
import { getQdrant } from "../services/legal/qdrant.js";
import { countConversations, countMessagesSince } from "../services/chats/store.js";
import { countData } from "../services/repo/index.js";
import os from "node:os";
import fs from "node:fs";
export const adminRoutes = new Hono();
// The operations console: administrators only.
adminRoutes.use("*", requireAuth, requireAdmin);
adminRoutes.route("/", adminExtraRoutes);
const DEFAULT_ORG = "org-legal-corp";
/** Organisation ids become folder names, so only plain identifiers are accepted. */
const orgParam = (raw) => {
    const value = (raw || DEFAULT_ORG).trim();
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(value))
        throw new HTTPException(400, { message: "Invalid organisation id." });
    return value;
};
// Live operational snapshot used by the separate admin console.
adminRoutes.get("/overview", async (c) => {
    const data = await countData().catch(() => ({ vakils: 0, artifacts: 0, files: 0 }));
    // Chats are stored in PostgreSQL. Only aggregate counts are exposed here, never content.
    const [messageCounts, conversationCount] = await Promise.all([
        countMessagesSince(Date.now() - 24 * 60 * 60 * 1000).catch(() => ({ total: 0, recent: 0 })),
        countConversations().catch(() => 0),
    ]);
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
            assistants: data.vakils,
            conversations: conversationCount,
            messages: messageCounts.total,
            messagesLast24h: messageCounts.recent,
            artifacts: data.artifacts,
            files: data.files,
        },
        services: {
            llm: { status: llm.status, latencyMs: llm.latencyMs, model: llm.model },
            qdrant,
        },
    });
});
// ---------------- Models ----------------
adminRoutes.get("/models", async (c) => {
    const models = await listModels();
    return c.json({ models });
});
adminRoutes.post("/models", async (c) => {
    const body = await c.req.json();
    const record = await registerModel(body);
    return c.json({ success: true, model: record });
});
adminRoutes.post("/models/:id/load", async (c) => {
    const modelId = c.req.param("id");
    const { nodeId } = await c.req.json();
    const res = await loadModel(modelId, nodeId);
    return c.json(res);
});
adminRoutes.post("/models/:id/unload", async (c) => {
    const modelId = c.req.param("id");
    const res = await unloadModel(modelId);
    return c.json(res);
});
// ---------------- Nodes ----------------
adminRoutes.get("/nodes", async (c) => {
    const nodes = await listNodes();
    return c.json({ nodes });
});
adminRoutes.post("/nodes", async (c) => {
    const body = await c.req.json();
    const record = await registerNode(body);
    return c.json({ success: true, node: record });
});
adminRoutes.post("/nodes/:id/drain", async (c) => {
    const nodeId = c.req.param("id");
    const res = await toggleDrainNode(nodeId);
    return c.json(res);
});
adminRoutes.post("/nodes/:id/toggle", async (c) => {
    const nodeId = c.req.param("id");
    const res = await toggleEnableNode(nodeId);
    return c.json(res);
});
// ---------------- Documents ----------------
adminRoutes.get("/documents", async (c) => {
    const orgId = orgParam(c.req.query("orgId"));
    const status = c.req.query("status");
    const documents = await listDocuments(orgId, status);
    return c.json({ documents });
});
adminRoutes.post("/documents", async (c) => {
    try {
        const formData = await c.req.formData();
        const file = formData.get("file");
        const orgId = orgParam(formData.get("orgId"));
        const title = formData.get("title") || file?.name || "Uploaded Document";
        if (!file) {
            return c.json({ error: "Missing file" }, 400);
        }
        if (file.size > config.maxUploadBytes) {
            return c.json({ error: "File is too large." }, 413);
        }
        // The Act's name is what answers cite, so it has to be given.
        const act = String(formData.get("act") || "").trim().slice(0, 200);
        if (act.length < 3)
            return c.json({ error: "Enter the Act's name, for example \"Bharatiya Nagarik Suraksha Sanhita, 2023\"." }, 400);
        const yearValue = Number(formData.get("year"));
        const year = Number.isInteger(yearValue) && yearValue >= 1800 && yearValue <= 2100 ? yearValue : null;
        const source = String(formData.get("source") || "").trim().slice(0, 300) || null;
        const buffer = Buffer.from(await file.arrayBuffer());
        const doc = await ingestDocument({
            organizationId: orgId,
            title,
            fileName: file.name,
            mimeType: file.type || "application/octet-stream",
            fileBuffer: buffer,
            act,
            year,
            source,
        });
        // Add the new sections to the vector index too. If the embedding service is down the document is still
        // searchable by text, and "index pending" in the admin app can finish the job later.
        let vector = null;
        if (doc.status === "ready") {
            vector = await indexProvisions({ documentId: doc.id }).catch((err) => ({ indexed: 0, failed: doc.chunk_count, error: String(err?.message || err) }));
        }
        const actor = c.get("user");
        await logAuditEvent({
            actor_id: actor.id, actor_email: actor.email, actor_role: actor.role, organization_id: orgId, action: "corpus.document.upload",
            target_type: "document", target_id: doc.id, status: doc.status === "ready" ? "SUCCESS" : "ERROR", ip_address: "", user_agent: "",
            details: JSON.stringify({ act, sections: doc.chunk_count, indexed: vector?.indexed ?? 0 }),
        }).catch(() => undefined);
        return c.json({ success: true, document: doc, vector });
    }
    catch (err) {
        if (err instanceof HTTPException)
            throw err;
        console.error("[admin] document upload failed:", err);
        return c.json({ error: "Could not store the document." }, 500);
    }
});
adminRoutes.delete("/documents/:id", async (c) => {
    const docId = c.req.param("id");
    const orgId = orgParam(c.req.query("orgId"));
    const deleted = await deleteDocument(docId, orgId);
    return c.json({ success: deleted });
});
// ---------------- API Keys ----------------
adminRoutes.get("/api-keys", async (c) => {
    const orgId = orgParam(c.req.query("orgId"));
    const keys = await listApiKeys(orgId);
    return c.json({ keys });
});
adminRoutes.post("/api-keys", async (c) => {
    const body = await c.req.json();
    const res = await createApiKey(body);
    return c.json(res);
});
adminRoutes.delete("/api-keys/:id", async (c) => {
    const keyId = c.req.param("id");
    const orgId = orgParam(c.req.query("orgId"));
    const revoked = await revokeApiKey(keyId, orgId);
    return c.json({ success: revoked });
});
// ---------------- Telemetry & Analytics ----------------
adminRoutes.get("/analytics", async (c) => {
    const timeRange = c.req.query("timeRange") || "24h";
    const orgId = c.req.query("orgId");
    const data = await getTelemetryMetrics(timeRange, orgId);
    return c.json(data);
});
// ---------------- Audit Logs ----------------
adminRoutes.get("/audit-logs", async (c) => {
    const orgId = orgParam(c.req.query("orgId"));
    const logs = await listAuditLogs(orgId);
    return c.json({ events: logs, total: logs.length, totalPages: 1 });
});
// ---------------- System Health ----------------
adminRoutes.get("/health", async (c) => {
    const llm = await checkLlmHealth();
    const sql = await pgData();
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
    const inferenceNodes = (await sql `SELECT id, name, address, status, enabled, active_connections, vram_used_bytes, vram_total_bytes, latency_ms FROM app_nodes ORDER BY created_at DESC`);
    const models = (await sql `SELECT id, name, status, provider, active_node_id FROM app_models ORDER BY created_at DESC`);
    // Statute uploads are the only background work: count them by state.
    const [jobRow] = await sql `
    SELECT COUNT(*) FILTER (WHERE status = 'processing')::int AS processing,
           COUNT(*) FILTER (WHERE status = 'failed' AND updated_at >= ${new Date(Date.now() - 86_400_000).toISOString()})::int AS failed
    FROM app_admin_documents`;
    const queue = { queued: 0, processing: Number(jobRow?.processing ?? 0), failed: Number(jobRow?.failed ?? 0) };
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
