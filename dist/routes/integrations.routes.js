import { Hono } from "hono";
import { sessionTokenFrom } from "../middleware/auth.js";
import { verifySession } from "../services/auth/index.js";
import { config } from "../config.js";
import { completeConnectorAuthorization, disconnectConnector, hasUserComposioKey, installPlugin, isConnectorSlug, listConnectors, listInstalledPlugins, PLUGIN_CATALOG, removeUserComposioKey, saveUserComposioKey, setPluginEnabled, startConnectorAuthorization, } from "../services/integrations/index.js";
export const integrationsRoutes = new Hono();
/** The signed-in user, checked against the sessions table so a logged-out token stops working. */
async function signedInUserId(c) {
    const token = sessionTokenFrom(c);
    if (!token)
        return null;
    const user = await verifySession(token).catch(() => null);
    return user ? user.id : null;
}
integrationsRoutes.get("/connectors", async (c) => {
    const id = await signedInUserId(c);
    if (!id)
        return c.json({ error: "Sign in required." }, 401);
    try {
        return c.json(await listConnectors(id));
    }
    catch (err) {
        console.error("[connectors] list failed:", err);
        return c.json({ error: "Could not load connectors." }, 502);
    }
});
integrationsRoutes.get("/connectors/key", async (c) => {
    const id = await signedInUserId(c);
    if (!id)
        return c.json({ error: "Sign in required." }, 401);
    return c.json({ configured: await hasUserComposioKey(id) });
});
integrationsRoutes.put("/connectors/key", async (c) => {
    const id = await signedInUserId(c);
    const body = (await c.req.json().catch(() => null));
    if (!id)
        return c.json({ error: "Sign in required." }, 401);
    if (typeof body?.apiKey !== "string" || !body.apiKey.startsWith("ak_"))
        return c.json({ error: "Enter a valid Composio project key." }, 400);
    try {
        await saveUserComposioKey(id, body.apiKey.trim());
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
    await removeUserComposioKey(id);
    return c.json({ deleted: true });
});
integrationsRoutes.post("/connectors/:slug/connect", async (c) => {
    const id = await signedInUserId(c);
    const slug = c.req.param("slug");
    if (!id)
        return c.json({ error: "Sign in required." }, 401);
    if (!isConnectorSlug(slug))
        return c.json({ error: "Invalid connection request." }, 400);
    if (!(await hasUserComposioKey(id)) && !config.composioApiKey)
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
    return c.json({ installed: await listInstalledPlugins(id) });
});
integrationsRoutes.post("/plugins", async (c) => {
    const body = (await c.req.json().catch(() => null));
    const id = await signedInUserId(c);
    const plugin = typeof body?.pluginId === "string" ? PLUGIN_CATALOG.find((item) => item.id === body.pluginId) : undefined;
    if (!id)
        return c.json({ error: "Sign in required." }, 401);
    if (!plugin)
        return c.json({ error: "Invalid plugin request." }, 400);
    const { installed, created } = await installPlugin(id, plugin);
    return created ? c.json({ installed }, 201) : c.json({ installed });
});
integrationsRoutes.patch("/plugins/:id", async (c) => {
    const body = (await c.req.json().catch(() => null));
    const id = await signedInUserId(c);
    if (!id)
        return c.json({ error: "Sign in required." }, 401);
    if (typeof body?.enabled !== "boolean")
        return c.json({ error: "Invalid plugin request." }, 400);
    return (await setPluginEnabled(id, c.req.param("id"), body.enabled)) ? c.json({ updated: true }) : c.json({ error: "Plugin not found." }, 404);
});
