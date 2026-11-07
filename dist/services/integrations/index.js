import { randomUUID } from "node:crypto";
import { Composio } from "@composio/core";
import { config } from "../../config.js";
import { getDb } from "../db/index.js";
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
const keyForUser = (userId) => { const row = getDb().prepare("SELECT api_key_enc FROM composio_user_keys WHERE user_id = ?").get(userId); return row ? decrypt(row.api_key_enc) : null; };
const client = (userId) => { const apiKey = keyForUser(userId) || config.composioApiKey; if (!apiKey)
    throw new Error("Connectors are not configured for this workspace."); return new Composio({ apiKey }); };
const session = (userId) => client(userId).sessions.create(`soli:${userId}`, { toolkits: { enable: CONNECTORS.map((connector) => connector.slug) }, manageConnections: false, sandbox: { enable: false }, proxyExecute: false });
export function saveUserComposioKey(userId, apiKey) { if (!config.tokenEncryptionKey)
    throw new Error("TOKEN_ENCRYPTION_KEY is required for user-managed connector keys."); getDb().prepare("INSERT INTO composio_user_keys (user_id, api_key_enc, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET api_key_enc=excluded.api_key_enc, updated_at=excluded.updated_at").run(userId, encrypt(apiKey), Date.now()); }
export function removeUserComposioKey(userId) { getDb().prepare("DELETE FROM composio_user_keys WHERE user_id = ?").run(userId); }
export function hasUserComposioKey(userId) { return Boolean(getDb().prepare("SELECT 1 FROM composio_user_keys WHERE user_id = ?").get(userId)); }
export async function listConnectors(userId) {
    if (!keyForUser(userId) && !config.composioApiKey)
        return { configured: false, connectors: CONNECTORS.map((connector) => ({ ...connector, connected: false })) };
    const states = await (await session(userId)).toolkits();
    const bySlug = new Map(states.items.map((item) => [item.slug, item]));
    const now = Date.now();
    const db = getDb();
    const upsert = db.prepare("INSERT INTO connector_connections (user_id, toolkit_slug, composio_connected_account_id, status, connected_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(user_id, toolkit_slug) DO UPDATE SET composio_connected_account_id=excluded.composio_connected_account_id, status=excluded.status, updated_at=excluded.updated_at");
    const connectors = CONNECTORS.map((connector) => { const state = bySlug.get(connector.slug); const connected = Boolean(state?.connection?.isActive); const accountId = state?.connection?.connectedAccount?.id ?? null; const providerStatus = state?.connection?.connectedAccount?.status?.toLowerCase() ?? "initiated"; const status = connected ? "active" : providerStatus === "expired" ? "expired" : "initiated"; upsert.run(userId, connector.slug, accountId, status, connected ? now : null, now); return { ...connector, connected, connectedAccountId: accountId, status }; });
    return { configured: true, connectors };
}
export async function startConnectorAuthorization(userId, toolkit) { const attempt = randomUUID(); getDb().prepare("INSERT INTO connector_attempts (id, user_id, toolkit_slug, created_at) VALUES (?, ?, ?, ?)").run(attempt, userId, toolkit, Date.now()); return (await (await session(userId)).authorize(toolkit, { callbackUrl: `${config.publicUrl}/api/connectors/callback?attempt=${encodeURIComponent(attempt)}&slug=${encodeURIComponent(toolkit)}` })).redirectUrl; }
export async function completeConnectorAuthorization(attempt, toolkit) { const row = getDb().prepare("SELECT user_id, toolkit_slug FROM connector_attempts WHERE id = ?").get(attempt); getDb().prepare("DELETE FROM connector_attempts WHERE id = ?").run(attempt); if (!row || row.toolkit_slug !== toolkit || !isConnectorSlug(toolkit))
    return false; return (await listConnectors(row.user_id)).connectors.some((connector) => connector.slug === toolkit && connector.connected); }
export async function disconnectConnector(userId, toolkit) { const row = getDb().prepare("SELECT composio_connected_account_id FROM connector_connections WHERE user_id = ? AND toolkit_slug = ?").get(userId, toolkit); if (row?.composio_connected_account_id)
    await client(userId).connectedAccounts.delete(row.composio_connected_account_id); getDb().prepare("DELETE FROM connector_connections WHERE user_id = ? AND toolkit_slug = ?").run(userId, toolkit); }
