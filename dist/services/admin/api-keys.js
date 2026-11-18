import crypto from "node:crypto";
import { pgData } from "../data/pg.js";
const toKey = (r) => ({
    id: r.id,
    organization_id: r.organization_id,
    name: r.name,
    key_prefix: r.key_prefix,
    scopes: r.scopes,
    rate_limit_rpm: Number(r.rate_limit_rpm),
    monthly_budget_usd: Number(r.monthly_budget_usd),
    is_active: Number(r.is_active),
    expires_at: r.expires_at ?? null,
    last_used_at: r.last_used_at ?? null,
    created_at: r.created_at,
});
/** Lists keys without their hashes: a secret is shown once, when created, and never again. */
export async function listApiKeys(orgId = "org-legal-corp") {
    const sql = await pgData();
    const rows = await sql `SELECT * FROM app_api_keys WHERE organization_id = ${orgId} ORDER BY created_at DESC`;
    return rows.map(toKey);
}
export async function createApiKey(data) {
    const sql = await pgData();
    const id = `key-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    // High entropy secret; only its hash is stored.
    const fullSecret = `soli_live_${crypto.randomBytes(24).toString("hex")}`;
    const keyPrefix = fullSecret.substring(0, 14);
    const keyHash = crypto.createHash("sha256").update(fullSecret).digest("hex");
    const expiresAt = data.expiresInDays ? new Date(Date.now() + data.expiresInDays * 86400000).toISOString() : null;
    const rows = await sql `
    INSERT INTO app_api_keys (id, organization_id, name, key_prefix, key_hash, scopes, rate_limit_rpm, monthly_budget_usd, is_active, expires_at, created_at)
    VALUES (${id}, ${data.organizationId}, ${data.name}, ${keyPrefix}, ${keyHash}, ${data.scopes.join(",")}, ${data.rateLimitRpm || 60},
            ${data.monthlyBudgetUsd || 100.0}, 1, ${expiresAt}, ${now})
    RETURNING *`;
    return { record: toKey(rows[0]), fullSecret };
}
export async function revokeApiKey(keyId, orgId = "org-legal-corp") {
    const sql = await pgData();
    const rows = await sql `UPDATE app_api_keys SET is_active = 0 WHERE id = ${keyId} AND organization_id = ${orgId} RETURNING id`;
    return rows.length > 0;
}
