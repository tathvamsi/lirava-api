import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { config } from "./config.js";
import { agentRoutes } from "./routes/agent.routes.js";
import { eventsRoutes } from "./routes/events.routes.js";
import { legalRoutes } from "./routes/legal.routes.js";
import { adminRoutes } from "./routes/admin.routes.js";
import { dotsRoutes } from "./routes/dots.routes.js";
import { conversationsRoutes } from "./routes/conversations.routes.js";
import { mattersRoutes } from "./routes/matters.routes.js";
import { artifactsRoutes } from "./routes/artifacts.routes.js";
import { filesRoutes } from "./routes/files.routes.js";
import { integrationsRoutes } from "./routes/integrations.routes.js";
import { authRoutes } from "./routes/auth.routes.js";
import { checkLlmHealth } from "./services/agent/client.js";
import { getDb } from "./services/db/index.js";
import { getSnapshot } from "./services/repo/index.js";
import { seedLegalCorpus } from "./services/legal/corpus-seeder.js";

const app = new Hono();

// Initialize DB schema on start
getDb();

// Seed legal corpus into Qdrant asynchronously if not already present
seedLegalCorpus(false).catch((err) => {
  console.warn("\x1b[33m[soli-backend] Auto-seeding warning:\x1b[0m", err.message);
});

// Global Request & Response Logger Middleware
app.use("*", async (c, next) => {
  const start = Date.now();
  const method = c.req.method;
  const path = c.req.path;
  const timestamp = new Date().toLocaleTimeString("en-US", { hour12: false });

  if (path !== "/api/events") {
    console.log(`\x1b[90m[${timestamp}]\x1b[0m \x1b[35m➜\x1b[0m \x1b[1m${method}\x1b[0m \x1b[36m${path}\x1b[0m`);
  }

  await next();

  const elapsed = Date.now() - start;
  const status = c.res.status;
  const statusColor =
    status >= 500
      ? "\x1b[41m\x1b[37m"
      : status >= 400
      ? "\x1b[33m"
      : status >= 300
      ? "\x1b[34m"
      : "\x1b[32m";
  const reset = "\x1b[0m";

  if (path !== "/api/events") {
    console.log(
      `\x1b[90m[${timestamp}]\x1b[0m \x1b[32m✔\x1b[0m ${statusColor}${status}${reset} \x1b[1m${method}\x1b[0m \x1b[36m${path}\x1b[0m \x1b[90m(${elapsed}ms)\x1b[0m`
    );
  }
});

// Global CORS Middleware
app.use(
  "*",
  cors({
    origin: (origin) => {
      // Allow localhost or configured origins
      if (!origin || origin.includes("localhost") || origin.includes("127.0.0.1")) {
        return origin || "*";
      }
      return config.corsOrigins.includes(origin) ? origin : null;
    },
    credentials: true,
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization", "x-soli-auth"],
  })
);

// Global Error Handler
app.onError((err, c) => {
  console.error(`[soli-backend] Uncaught error on ${c.req.method} ${c.req.url}:`, err);
  return c.json(
    {
      error: err.message || "Internal Server Error",
      timestamp: new Date().toISOString(),
    },
    500
  );
});

// Root & Health Checks
app.get("/", (c) => {
  return c.json({
    service: "soli-backend",
    version: "1.0.0",
    description: "Soli Legal AI Platform Standalone Backend",
    status: "running",
    port: config.port,
    endpoints: {
      auth: "/api/auth",
      agent: "/api/agent",
      events: "/api/events",
      legal: "/api/legal",
      admin: "/api/admin",
      ping: "/api/ping",
    },
  });
});

app.get("/api/ping", async (c) => {
  const llm = await checkLlmHealth();
  return c.json({
    service: "soli-backend",
    status: "online",
    llm,
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

// Mount Routes
app.route("/api/auth", authRoutes);
app.route("/api/agent", agentRoutes);
app.route("/api/events", eventsRoutes);
app.route("/api/legal", legalRoutes);
app.route("/api/admin", adminRoutes);
app.route("/api/dots", dotsRoutes);
app.route("/api/agents", dotsRoutes);
app.route("/api/conversations", conversationsRoutes);
app.route("/api/matters", mattersRoutes);
app.route("/api/artifacts", artifactsRoutes);
app.route("/api/files", filesRoutes);
app.route("/api", integrationsRoutes);

app.get("/api/snapshot", (c) => {
  const userId = c.req.query("userId") || "";
  return c.json(getSnapshot(userId));
});

export default app;
