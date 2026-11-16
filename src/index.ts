import { Hono } from "hono";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import { HTTPException } from "hono/http-exception";
import { config, isProduction } from "./config.js";
import { agentRoutes } from "./routes/agent.routes.js";
import { eventsRoutes } from "./routes/events.routes.js";
import { legalRoutes } from "./routes/legal.routes.js";
import { adminRoutes } from "./routes/admin.routes.js";
import { vakilsRoutes } from "./routes/vakils.routes.js";
import { conversationsRoutes } from "./routes/conversations.routes.js";
import { mattersRoutes } from "./routes/matters.routes.js";
import { artifactsRoutes } from "./routes/artifacts.routes.js";
import { filesRoutes } from "./routes/files.routes.js";
import { integrationsRoutes } from "./routes/integrations.routes.js";
import { authRoutes } from "./routes/auth.routes.js";
import { publicRoutes } from "./routes/public.routes.js";
import { documentsRoutes } from "./routes/documents.routes.js";
import { preferencesRoutes } from "./routes/preferences.routes.js";
import { checkLlmHealth } from "./services/agent/client.js";
import { getSnapshot } from "./services/repo/index.js";
import { seedLegalCorpus } from "./services/legal/corpus-seeder.js";
import { requireAuth } from "./middleware/auth.js";
import { pgData } from "./services/data/pg.js";
import { runningFor } from "./services/agent/runtime.js";
import { corsOrigin } from "./middleware/security.js";
import { initChatStore } from "./services/chats/store.js";
import { seedBuiltInProvisions } from "./services/legal/provisions.js";
import { LEGAL_FOUNDATIONAL_CORPUS } from "./services/legal/corpus-seeder.js";
import { getSql } from "./services/db/postgres.js";

const app = new Hono();

// Vakils, matters, documents and files live in PostgreSQL too: create the tables and add the built-in Vakils.
if (config.nodeEnv !== "test") {
  pgData().catch((err) => console.error("[soli-backend] Data storage is unavailable:", err.message));
}

// Chats live in PostgreSQL. Create the tables.
initChatStore().catch((err) => {
  console.error("[soli-backend] Chat storage is unavailable:", err.message);
});

// The built-in starter provisions are also kept in PostgreSQL, so statute search works without the embedding server.
if (config.nodeEnv !== "test") {
  seedBuiltInProvisions(LEGAL_FOUNDATIONAL_CORPUS as Parameters<typeof seedBuiltInProvisions>[0]).catch((err) =>
    console.warn("[soli-backend] Could not store the starter provisions:", err.message),
  );
}

// Seed legal corpus into Qdrant asynchronously if not already present (skipped when Qdrant is not configured)
if (config.qdrantUrl && config.nodeEnv !== "test") {
  seedLegalCorpus(false).catch((err) => {
    console.warn("[soli-backend] Auto-seeding warning:", err.message);
  });
}

// ---------------- Global middleware ----------------

app.use(
  "*",
  secureHeaders({
    // This service returns JSON and file downloads, never pages.
    // `sandbox` also covers file downloads: anything a browser opens from here runs with no privileges.
    contentSecurityPolicy: { defaultSrc: ["'none'"], frameAncestors: ["'none'"], sandbox: [] },
    strictTransportSecurity: isProduction ? "max-age=63072000; includeSubDomains" : false,
    referrerPolicy: "no-referrer",
    xFrameOptions: "DENY",
  }),
);

app.use(
  "*",
  cors({
    origin: (origin) => corsOrigin(origin),
    credentials: true,
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization", "x-session-token"],
    maxAge: 600,
  }),
);

// Request size limits: small for JSON, larger only for file uploads.
app.use("/api/*", async (c, next) => {
  const isUpload = (c.req.header("content-type") || "").toLowerCase().startsWith("multipart/form-data");
  const limit = isUpload ? config.maxUploadBytes * 10 + 1024 * 1024 : 2 * 1024 * 1024;
  return bodyLimit({
    maxSize: limit,
    onError: (ctx) => ctx.json({ error: "The request is too large." }, 413),
  })(c, next);
});

// Request log: one line per request, no ANSI colours in production, quiet for the long-lived event stream.
app.use("*", async (c, next) => {
  const start = Date.now();
  await next();
  if (c.req.path === "/api/events" || c.req.path === "/health") return;
  const status = c.res.status;
  if (isProduction) {
    console.log(JSON.stringify({ t: new Date().toISOString(), method: c.req.method, path: c.req.path, status, ms: Date.now() - start }));
  } else {
    console.log(`${c.req.method} ${c.req.path} ${status} (${Date.now() - start}ms)`);
  }
});

app.onError((err, c) => {
  if (err instanceof HTTPException) {
    return c.json({ error: err.message || "Request failed" }, err.status);
  }
  console.error(`[soli-backend] Uncaught error on ${c.req.method} ${c.req.path}:`, err);
  // Internal details (stack traces, SQL, hostnames) stay in the server log.
  return c.json({ error: "Internal Server Error" }, 500);
});

app.notFound((c) => c.json({ error: "Not found" }, 404));

// ---------------- Health ----------------

/** Liveness: the process is up. No dependencies are touched. */
app.get("/health", (c) => c.json({ status: "ok", uptimeSeconds: Math.floor(process.uptime()) }));

/** Readiness: the dependencies a request needs are reachable. */
app.get("/ready", async (c) => {
  const checks: Record<string, "ok" | "down"> = {};
  try {
    const sql = getSql();
    if (!sql) throw new Error("no database");
    await sql`SELECT 1`;
    checks.postgres = "ok";
  } catch {
    checks.postgres = "down";
  }
  const ready = checks.postgres === "ok";
  return c.json({ status: ready ? "ready" : "not_ready", checks }, ready ? 200 : 503);
});

app.get("/", (c) => c.json({ service: "soli-backend", status: "running" }));

app.get("/api/ping", async (c) => {
  const llm = await checkLlmHealth();
  return c.json({
    service: "soli-backend",
    status: "online",
    // Only whether the model answers: its address and any error text stay private.
    llm: { status: llm.status },
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

// ---------------- Routes ----------------
app.route("/api/auth", authRoutes);
app.route("/api/public", publicRoutes);
app.route("/api/agent", agentRoutes);
app.route("/api/events", eventsRoutes);
app.route("/api/legal", legalRoutes);
app.route("/api/admin", adminRoutes);
app.route("/api/vakils", vakilsRoutes);
app.route("/api/conversations", conversationsRoutes);
app.route("/api/matters", mattersRoutes);
app.route("/api/artifacts", artifactsRoutes);
app.route("/api/files", filesRoutes);
app.route("/api/documents", documentsRoutes);
app.route("/api/preferences", preferencesRoutes);
app.route("/api", integrationsRoutes);

app.get("/api/snapshot", requireAuth, async (c) => {
  const userId = c.get("user").id;
  return c.json({ ...(await getSnapshot(userId)), running: runningFor(userId) });
});

export default app;
