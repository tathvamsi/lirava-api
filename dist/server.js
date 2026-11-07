import { serve } from "@hono/node-server";
import app from "./index.js";
import { config } from "./config.js";
const server = serve({
    fetch: app.fetch,
    port: config.port,
    hostname: config.host,
}, (info) => {
    console.log(`\n========================================================`);
    console.log(`🚀 Soli Standalone Backend Service Running!`);
    console.log(`📡 URL: http://localhost:${info.port}`);
    console.log(`🧠 Local LLM Node: ${config.customLlmBaseUrl}`);
    console.log(`⚖️ Legal Vector Engine: ${config.qdrantUrl}`);
    console.log(`========================================================\n`);
});
const shutdown = () => {
    console.log("\n[soli-backend] Gracefully shutting down...");
    server.close(() => {
        console.log("[soli-backend] Closed all active connections.");
        process.exit(0);
    });
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
