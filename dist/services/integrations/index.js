import { randomUUID } from "node:crypto";
import { Composio } from "@composio/core";
import { config } from "../../config.js";
import { pgData } from "../data/pg.js";
import { decrypt, encrypt } from "./crypto.js";
export const CONNECTORS = [
    { slug: "gmail", name: "Gmail", description: "Find and reference correspondence.", category: "Email" },
    { slug: "outlook", name: "Outlook", description: "Find and reference correspondence.", category: "Email" },
    { slug: "googledrive", name: "Google Drive", description: "Locate files for a matter.", category: "Documents & Storage" },
    { slug: "googledocs", name: "Google Docs", description: "Reference working drafts and notes.", category: "Documents & Storage" },
    { slug: "googlesheets", name: "Google Sheets", description: "Reference matter trackers and tables.", category: "Documents & Storage" },
    { slug: "dropbox", name: "Dropbox", description: "Reference shared case files.", category: "Documents & Storage" },
    { slug: "googlecalendar", name: "Google Calendar", description: "Review upcoming dates and hearings.", category: "Calendar" },
    { slug: "slack", name: "Slack", description: "Reference team communications.", category: "Messaging" },
    { slug: "notion", name: "Notion", description: "Reference workspace knowledge.", category: "Documents & Storage" },
    { slug: "zoom", name: "Zoom", description: "Reference meeting information.", category: "Meetings" },
];
export const isConnectorSlug = (value) => CONNECTORS.some((connector) => connector.slug === value);
export const PLUGIN_CATALOG = [
    { id: "litigation-research", name: "Litigation Research", version: "1.0.0", category: "Litigation", description: "Structure research questions, spot issues, and prepare case briefs.", commands: ["/research", "/issue-spot", "/case-brief"] },
    { id: "hearing-prep", name: "Hearing Prep", version: "1.0.0", category: "Litigation", description: "Prepare next-date summaries and hearing checklists.", commands: ["/hearing-prep", "/next-date-summary", "/checklist"] },
];
async function keyForUser(userId) {
    const sql = await pgData();
    const rows = await sql `SELECT api_key_enc FROM app_composio_user_keys WHERE user_id = ${userId}`;
    return rows[0] ? decrypt(rows[0].api_key_enc) : null;
}
async function client(userId) {
    const apiKey = (await keyForUser(userId)) || config.composioApiKey;
    if (!apiKey)
        throw new Error("Connectors are not configured for this workspace.");
    return new Composio({ apiKey });
}
async function session(userId) {
    return (await client(userId)).sessions.create(`soli:${userId}`, {
        toolkits: { enable: CONNECTORS.map((connector) => connector.slug) },
        manageConnections: false,
        sandbox: { enable: false },
        proxyExecute: false,
    });
}
export async function saveUserComposioKey(userId, apiKey) {
    if (!config.tokenEncryptionKey)
        throw new Error("TOKEN_ENCRYPTION_KEY is required for user-managed connector keys.");
    const sql = await pgData();
    await sql `
    INSERT INTO app_composio_user_keys (user_id, api_key_enc, updated_at) VALUES (${userId}, ${encrypt(apiKey)}, ${Date.now()})
    ON CONFLICT (user_id) DO UPDATE SET api_key_enc = EXCLUDED.api_key_enc, updated_at = EXCLUDED.updated_at`;
}
export async function removeUserComposioKey(userId) {
    const sql = await pgData();
    await sql `DELETE FROM app_composio_user_keys WHERE user_id = ${userId}`;
}
export async function hasUserComposioKey(userId) {
    const sql = await pgData();
    return (await sql `SELECT 1 FROM app_composio_user_keys WHERE user_id = ${userId}`).length > 0;
}
export async function listConnectors(userId) {
    if (!(await keyForUser(userId)) && !config.composioApiKey) {
        return { configured: false, connectors: CONNECTORS.map((connector) => ({ ...connector, connected: false })) };
    }
    const states = await (await session(userId)).toolkits();
    const bySlug = new Map(states.items.map((item) => [item.slug, item]));
    const now = Date.now();
    const sql = await pgData();
    const connectors = [];
    for (const connector of CONNECTORS) {
        const state = bySlug.get(connector.slug);
        const connected = Boolean(state?.connection?.isActive);
        const accountId = state?.connection?.connectedAccount?.id ?? null;
        const providerStatus = state?.connection?.connectedAccount?.status?.toLowerCase() ?? "initiated";
        const status = connected ? "active" : providerStatus === "expired" ? "expired" : "initiated";
        await sql `
      INSERT INTO app_connector_connections (user_id, toolkit_slug, composio_connected_account_id, status, connected_at, updated_at)
      VALUES (${userId}, ${connector.slug}, ${accountId}, ${status}, ${connected ? now : null}, ${now})
      ON CONFLICT (user_id, toolkit_slug) DO UPDATE SET composio_connected_account_id = EXCLUDED.composio_connected_account_id,
        status = EXCLUDED.status, updated_at = EXCLUDED.updated_at`;
        connectors.push({ ...connector, connected, connectedAccountId: accountId, status });
    }
    return { configured: true, connectors };
}
export async function startConnectorAuthorization(userId, toolkit) {
    const attempt = randomUUID();
    const sql = await pgData();
    await sql `INSERT INTO app_connector_attempts (id, user_id, toolkit_slug, created_at) VALUES (${attempt}, ${userId}, ${toolkit}, ${Date.now()})`;
    const request = await (await session(userId)).authorize(toolkit, {
        callbackUrl: `${config.publicUrl}/api/connectors/callback?attempt=${encodeURIComponent(attempt)}&slug=${encodeURIComponent(toolkit)}`,
    });
    return request.redirectUrl;
}
export async function completeConnectorAuthorization(attempt, toolkit) {
    const sql = await pgData();
    // An attempt can be completed once.
    const rows = await sql `DELETE FROM app_connector_attempts WHERE id = ${attempt} RETURNING user_id, toolkit_slug`;
    const row = rows[0];
    if (!row || row.toolkit_slug !== toolkit || !isConnectorSlug(toolkit))
        return false;
    return (await listConnectors(row.user_id)).connectors.some((connector) => connector.slug === toolkit && connector.connected);
}
export async function disconnectConnector(userId, toolkit) {
    const sql = await pgData();
    const rows = await sql `SELECT composio_connected_account_id FROM app_connector_connections WHERE user_id = ${userId} AND toolkit_slug = ${toolkit}`;
    const accountId = rows[0]?.composio_connected_account_id;
    if (accountId)
        await (await client(userId)).connectedAccounts.delete(accountId);
    await sql `DELETE FROM app_connector_connections WHERE user_id = ${userId} AND toolkit_slug = ${toolkit}`;
}
const toInstalled = (r) => ({
    id: r.id,
    pluginId: r.plugin_id,
    version: r.version,
    enabled: Number(r.enabled),
    scope: r.scope,
    installedAt: Number(r.installed_at),
});
export async function listInstalledPlugins(userId) {
    const sql = await pgData();
    return (await sql `SELECT * FROM app_plugins_installed WHERE user_id = ${userId} ORDER BY installed_at DESC`).map(toInstalled);
}
/** Installs a plugin for the user; installing one that is already installed returns the existing install. */
export async function installPlugin(userId, plugin) {
    const sql = await pgData();
    const rows = await sql `
    INSERT INTO app_plugins_installed (id, user_id, plugin_id, version, enabled, scope, installed_at)
    VALUES (${randomUUID()}, ${userId}, ${plugin.id}, ${plugin.version}, 1, 'user', ${Date.now()})
    ON CONFLICT (user_id, plugin_id) DO NOTHING RETURNING *`;
    if (rows[0])
        return { installed: toInstalled(rows[0]), created: true };
    const [existing] = await sql `SELECT * FROM app_plugins_installed WHERE user_id = ${userId} AND plugin_id = ${plugin.id}`;
    return { installed: toInstalled(existing), created: false };
}
export async function setPluginEnabled(userId, installId, enabled) {
    const sql = await pgData();
    const rows = await sql `UPDATE app_plugins_installed SET enabled = ${enabled ? 1 : 0} WHERE id = ${installId} AND user_id = ${userId} RETURNING id`;
    return rows.length > 0;
}
