import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { jwtVerify } from "jose";
import { config } from "../config.js";
import { completeConnectorAuthorization, disconnectConnector, hasUserComposioKey, isConnectorSlug, listConnectors, PLUGIN_CATALOG, removeUserComposioKey, saveUserComposioKey, startConnectorAuthorization } from "../services/integrations/index.js";
import { getDb } from "../services/db/index.js";
export const integrationsRoutes = new Hono();
async function signedInUserId(c) {
    const token = c.req.header("cookie")?.match(/(?:^|;\s*)soli_session=([^;]+)/)?.[1];
    if (!token)
        return null;
    try {
        const { payload } = await jwtVerify(token, new TextEncoder().encode(config.sessionSecret), { algorithms: ["HS256"] });
        return typeof payload.sub === "string" ? payload.sub : null;
    }
    catch {
        return null;
    }
}
integrationsRoutes.get("/connectors", async (c) => {
    const id = await signedInUserId(c);
    if (!id)
        return c.json({ error: "Sign in required." }, 401);
    return c.json(await listConnectors(id));
});
integrationsRoutes.get("/connectors/key", async (c) => {
    const id = await signedInUserId(c);
    if (!id)
        return c.json({ error: "Sign in required." }, 401);
    return c.json({ configured: hasUserComposioKey(id) });
});
integrationsRoutes.put("/connectors/key", async (c) => {
    const id = await signedInUserId(c);
    const body = await c.req.json().catch(() => null);
    if (!id)
        return c.json({ error: "Sign in required." }, 401);
    if (typeof body?.apiKey !== "string" || !body.apiKey.startsWith("ak_"))
        return c.json({ error: "Enter a valid Composio project key." }, 400);
    try {
        saveUserComposioKey(id, body.apiKey.trim());
        return c.json({ configured: true });
    }
    catch (error) {
        return c.json({ error: error instanceof Error ? error.message : "Could not save the connector key." }, 503);
    }
});
integrationsRoutes.delete("/connectors/key", async (c) => {
    const id = await signedInUserId(c);
    if (!id)
        return c.json({ error: "Sign in required." }, 401);
    removeUserComposioKey(id);
    return c.json({ deleted: true });
});
integrationsRoutes.post("/connectors/:slug/connect", async (c) => {
    const id = await signedInUserId(c);
    const slug = c.req.param("slug");
    if (!id)
        return c.json({ error: "Sign in required." }, 401);
    if (!isConnectorSlug(slug))
        return c.json({ error: "Invalid connection request." }, 400);
    if (!hasUserComposioKey(id) && !config.composioApiKey)
        return c.json({ error: "Add your Composio project key before connecting an account." }, 503);
    return c.json({ url: await startConnectorAuthorization(id, slug) });
});
integrationsRoutes.get("/connectors/callback", async (c) => {
    const attempt = c.req.query("attempt") || "";
    const slug = c.req.query("slug") || "";
    let connected = false;
    try {
        connected = await completeConnectorAuthorization(attempt, slug);
    }
    catch {
        connected = false;
    }
    return c.redirect(`${config.webUrl}/settings/connectors?result=${connected ? "connected" : "failed"}`);
});
integrationsRoutes.delete("/connectors/:slug", async (c) => {
    const id = await signedInUserId(c);
    const slug = c.req.param("slug");
    if (!id)
        return c.json({ error: "Sign in required." }, 401);
    if (!isConnectorSlug(slug))
        return c.json({ error: "Invalid connection request." }, 400);
    await disconnectConnector(id, slug);
    return c.json({ deleted: true });
});
integrationsRoutes.get("/plugins/catalog", async (c) => {
    const id = await signedInUserId(c);
    if (!id)
        return c.json({ error: "Sign in required." }, 401);
    return c.json({ plugins: PLUGIN_CATALOG });
});
integrationsRoutes.get("/plugins", async (c) => {
    const id = await signedInUserId(c);
    if (!id)
        return c.json({ error: "Sign in required." }, 401);
    const installed = getDb().prepare("SELECT id, plugin_id AS pluginId, version, enabled, scope, installed_at AS installedAt FROM plugins_installed WHERE user_id = ? ORDER BY installed_at DESC").all(id);
    return c.json({ installed });
});
integrationsRoutes.post("/plugins", async (c) => {
    const body = await c.req.json().catch(() => null);
    const id = await signedInUserId(c);
    const plugin = typeof body?.pluginId === "string" ? PLUGIN_CATALOG.find((item) => item.id === body.pluginId) : undefined;
    if (!id)
        return c.json({ error: "Sign in required." }, 401);
    if (!plugin)
        return c.json({ error: "Invalid plugin request." }, 400);
    const db = getDb();
    const existing = db.prepare("SELECT id, plugin_id AS pluginId, version, enabled, scope, installed_at AS installedAt FROM plugins_installed WHERE user_id = ? AND plugin_id = ?").get(id, plugin.id);
    if (existing)
        return c.json({ installed: existing });
    const installed = { id: randomUUID(), pluginId: plugin.id, version: plugin.version, enabled: 1, scope: "user", installedAt: Date.now() };
    db.prepare("INSERT INTO plugins_installed (id, user_id, plugin_id, version, enabled, scope, installed_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(installed.id, id, installed.pluginId, installed.version, installed.enabled, installed.scope, installed.installedAt);
    return c.json({ installed }, 201);
});
integrationsRoutes.patch("/plugins/:id", async (c) => {
    const body = await c.req.json().catch(() => null);
    const id = await signedInUserId(c);
    if (!id)
        return c.json({ error: "Sign in required." }, 401);
    if (typeof body?.enabled !== "boolean")
        return c.json({ error: "Invalid plugin request." }, 400);
    const result = getDb().prepare("UPDATE plugins_installed SET enabled = ? WHERE id = ? AND user_id = ?").run(body.enabled ? 1 : 0, c.req.param("id"), id);
    return result.changes ? c.json({ updated: true }) : c.json({ error: "Plugin not found." }, 404);
});
