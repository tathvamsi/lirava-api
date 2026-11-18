import { serve } from "@hono/node-server";
import { assertProductionConfig, config } from "./config.js";
// Refuse to start with missing or unsafe production settings.
assertProductionConfig();
const { default: app } = await import("./index.js");
const { closeSql } = await import("./services/db/postgres.js");
const server = serve({
    fetch: app.fetch,
    port: config.port,
    hostname: config.host,
}, (info) => {
    console.log(`[soli-backend] listening on http://${config.host}:${info.port} (${config.nodeEnv})`);
});
let shuttingDown = false;
const shutdown = (signal) => {
    if (shuttingDown)
        return;
    shuttingDown = true;
    console.log(`[soli-backend] ${signal} received, shutting down...`);
    // Give in-flight requests a few seconds, then exit regardless (event streams stay open indefinitely).
    const force = setTimeout(() => process.exit(0), 8000);
    force.unref();
    server.close(async () => {
        await closeSql().catch(() => undefined);
        process.exit(0);
    });
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("unhandledRejection", (reason) => console.error("[soli-backend] Unhandled rejection:", reason));
