import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AuthEnv } from "../middleware/auth.js";
import { clientIp } from "../middleware/security.js";
import { config } from "../config.js";
import { logAuditEvent } from "../services/admin/audit-ledger.js";
import {
  corpusStats,
  deleteAct,
  deleteProvisionRows,
  getJob,
  getProvisionRow,
  listActs,
  listJobs,
  listProvisionRows,
  previewSections,
  searchBoth,
  startReindexJob,
  updateProvisionRow,
} from "../services/admin/corpus.js";
import { getSql } from "../services/db/postgres.js";
import { defaultProvider, publicProviders } from "../services/agent/providers.js";

/** Corpus, user and system tools for the internal admin app. Mounted under /api/admin (administrators only). */
export const adminExtraRoutes = new Hono<AuthEnv>();

const ORG = "org-legal-corp";

async function audit(c: any, action: string, targetType: string, targetId: string, details: Record<string, unknown> = {}) {
  const user = c.get("user");
  await logAuditEvent({
    actor_id: user.id,
    actor_email: user.email,
    actor_role: user.role,
    organization_id: ORG,
    action,
    target_type: targetType,
    target_id: targetId,
    status: "SUCCESS",
    ip_address: clientIp(c),
    user_agent: (c.req.header("user-agent") || "").slice(0, 200),
    details: JSON.stringify(details),
  }).catch((err) => console.warn("[admin] audit write failed:", err?.message));
}

const int = (value: string | undefined, fallback: number) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
};

// ---------------- Corpus ----------------

adminExtraRoutes.get("/corpus/stats", async (c) => c.json({ ...(await corpusStats()), jobs: listJobs() }));

adminExtraRoutes.get("/corpus/acts", async (c) => c.json({ acts: await listActs() }));

adminExtraRoutes.get("/corpus/provisions", async (c) => {
  const result = await listProvisionRows({
    act: c.req.query("act"),
    q: c.req.query("q"),
    limit: int(c.req.query("limit"), 50),
    offset: int(c.req.query("offset"), 0),
  });
  return c.json(result);
});

adminExtraRoutes.get("/corpus/provisions/:id", async (c) => {
  const row = await getProvisionRow(c.req.param("id"));
  if (!row) return c.json({ error: "Provision not found." }, 404);
  return c.json({ provision: row });
});

adminExtraRoutes.patch("/corpus/provisions/:id", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const patch: { title?: string; text?: string; ratio?: string | null } = {};
  if (typeof body.title === "string") patch.title = body.title.slice(0, 400);
  if (typeof body.text === "string") {
    if (body.text.trim().length < 12) return c.json({ error: "The text is too short." }, 400);
    patch.text = body.text.slice(0, 200_000);
  }
  if (body.ratio === null || typeof body.ratio === "string") patch.ratio = body.ratio ? body.ratio.slice(0, 4000) : null;
  const row = await updateProvisionRow(c.req.param("id"), patch);
  if (!row) return c.json({ error: "Provision not found." }, 404);
  await audit(c, "corpus.provision.update", "provision", row.id, { act: row.act, section: row.section });
  return c.json({ provision: row });
});

adminExtraRoutes.delete("/corpus/provisions/:id", async (c) => {
  const removed = await deleteProvisionRows([c.req.param("id")]);
  if (!removed) return c.json({ error: "Provision not found." }, 404);
  await audit(c, "corpus.provision.delete", "provision", c.req.param("id"));
  return c.json({ success: true });
});

adminExtraRoutes.delete("/corpus/acts", async (c) => {
  const act = (c.req.query("act") || "").trim();
  if (!act) return c.json({ error: "Name the Act to remove." }, 400);
  const removed = await deleteAct(act);
  await audit(c, "corpus.act.delete", "act", act, { removed });
  return c.json({ success: true, removed });
});

/** Dry run: how would this file be split into sections? Nothing is stored. */
adminExtraRoutes.post("/corpus/preview", async (c) => {
  const form = await c.req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return c.json({ error: "Missing file." }, 400);
  if (file.size > config.maxUploadBytes) return c.json({ error: "File is too large." }, 413);
  const result = await previewSections(file.name, file.type || "application/octet-stream", Buffer.from(await file.arrayBuffer()));
  if ("error" in result) return c.json({ error: result.error }, 422);
  return c.json({
    pages: result.pages,
    characters: result.characters,
    count: result.sections.length,
    sections: result.sections.slice(0, 300).map((s) => ({ section: s.section, title: s.title, chars: s.text.length, excerpt: s.text.slice(0, 220) })),
  });
});

adminExtraRoutes.post("/corpus/reindex", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const act = typeof body.act === "string" && body.act.trim() ? body.act.trim() : undefined;
  const job = startReindexJob({
    act,
    pendingOnly: body.pendingOnly === true,
    rebuild: body.rebuild === true && !act,
  });
  await audit(c, "corpus.reindex", "corpus", job.id, { act: act ?? "all", pendingOnly: body.pendingOnly === true, rebuild: body.rebuild === true });
  return c.json({ job }, 202);
});

adminExtraRoutes.get("/corpus/jobs/:id", async (c) => {
  const job = getJob(c.req.param("id"));
  if (!job) return c.json({ error: "Job not found." }, 404);
  return c.json({ job });
});

/** Shows what the platform's two search routes return for a question, side by side. */
adminExtraRoutes.get("/corpus/search", async (c) => {
  const q = (c.req.query("q") || "").trim();
  if (q.length < 2) return c.json({ error: "Type a question." }, 400);
  return c.json(await searchBoth(q.slice(0, 500), Math.min(int(c.req.query("limit"), 5), 15)));
});

// ---------------- Users ----------------

adminExtraRoutes.get("/users", async (c) => {
  const sql = getSql();
  if (!sql) throw new HTTPException(503, { message: "Database is not configured." });
  const q = (c.req.query("q") || "").trim().toLowerCase();
  const like = q ? `%${q.replace(/[%_\\]/g, (m) => `\\${m}`)}%` : null;
  const rows = await sql`
    SELECT u.id, u.name, u.email, u.role, u.created_at,
           (SELECT COUNT(*)::int FROM sessions s WHERE s.user_id = u.id AND s.expires_at > NOW()) AS active_sessions,
           (SELECT COUNT(*)::int FROM chat_conversations c WHERE c.user_id = u.id::text) AS conversations,
           (SELECT COUNT(*)::int FROM app_matters m WHERE m.user_id = u.id::text) AS matters
    FROM users u
    WHERE (${like}::text IS NULL OR LOWER(u.email) LIKE ${like} OR LOWER(u.name) LIKE ${like})
    ORDER BY u.created_at DESC
    LIMIT 200`;
  return c.json({
    users: rows.map((r) => ({
      id: r.id,
      name: r.name,
      email: r.email,
      role: r.role,
      createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
      activeSessions: Number(r.active_sessions),
      conversations: Number(r.conversations),
      matters: Number(r.matters),
    })),
  });
});

/** Signs a person out everywhere (for a lost device or a suspected leak). Their data is not touched. */
adminExtraRoutes.post("/users/:id/revoke-sessions", async (c) => {
  const sql = getSql();
  if (!sql) throw new HTTPException(503, { message: "Database is not configured." });
  const id = c.req.param("id");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return c.json({ error: "Unknown user." }, 404);
  const rows = await sql`DELETE FROM sessions WHERE user_id = ${id} RETURNING id`;
  await audit(c, "user.sessions.revoke", "user", id, { revoked: rows.length });
  return c.json({ success: true, revoked: rows.length });
});

// ---------------- System ----------------

/** Which provider and services the platform is configured to use. Addresses are shown without credentials. */
adminExtraRoutes.get("/system", (c) => {
  const host = (value: string) => {
    try {
      return new URL(value).host;
    } catch {
      return value ? "configured" : "";
    }
  };
  return c.json({
    environment: config.nodeEnv,
    node: process.version,
    uptimeSeconds: Math.floor(process.uptime()),
    // The provider chats use when none is picked, and which of the three are set up (never their keys).
    provider: defaultProvider().label,
    providers: publicProviders().map((p) => ({ id: p.id, label: p.label, model: p.model, available: p.available, isDefault: p.isDefault })),
    llm: { host: host(config.customLlmBaseUrl), model: config.customLlmModel, keyConfigured: Boolean(config.customLlmApiKey && config.customLlmApiKey !== "not-needed") },
    embeddings: { model: config.customEmbeddingModel, dimensions: config.embeddingDimensions },
    qdrant: { host: host(config.qdrantUrl), collection: config.qdrantCollection, keyConfigured: Boolean(config.qdrantApiKey) },
    database: { configured: Boolean(config.databaseUrl) },
    limits: { upstreamTimeoutMs: config.upstreamTimeoutMs, maxUploadBytes: config.maxUploadBytes, topK: config.topK },
    signup: {
      inviteCodes: config.signupInviteCodes.length,
      allowedDomains: config.signupAllowedDomains,
      openSignup: config.allowOpenSignup,
    },
    adminEmails: config.adminEmails.length,
    connectors: { composioConfigured: Boolean(config.composioApiKey) },
  });
});
