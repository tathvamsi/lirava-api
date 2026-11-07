import { getDb } from "../db/index.js";
import crypto from "node:crypto";

export interface ApiKeyRecord {
  id: string;
  organization_id: string;
  name: string;
  key_prefix: string;
  key_hash: string;
  scopes: string;
  rate_limit_rpm: number;
  monthly_budget_usd: number;
  is_active: number;
  expires_at?: string | null;
  last_used_at?: string | null;
  created_at: string;
}

export function listApiKeys(orgId: string = "org-legal-corp"): Omit<ApiKeyRecord, "key_hash">[] {
  const db = getDb();
  return db.prepare(`
    SELECT id, organization_id, name, key_prefix, scopes, rate_limit_rpm,
           monthly_budget_usd, is_active, expires_at, last_used_at, created_at
    FROM admin_api_keys
    WHERE organization_id = ?
    ORDER BY created_at DESC
  `).all(orgId) as Omit<ApiKeyRecord, "key_hash">[];
}

export function createApiKey(data: {
  organizationId: string;
  name: string;
  scopes: string[];
  rateLimitRpm?: number;
  monthlyBudgetUsd?: number;
  expiresInDays?: number;
}): { record: Omit<ApiKeyRecord, "key_hash">; fullSecret: string } {
  const db = getDb();
  const id = `key-${crypto.randomUUID()}`;
  const now = new Date().toISOString();

  // High entropy secret generation
  const randomBytes = crypto.randomBytes(24).toString("hex");
  const fullSecret = `soli_live_${randomBytes}`;
  const keyPrefix = fullSecret.substring(0, 14); // e.g. "soli_live_ab12"
  const keyHash = crypto.createHash("sha256").update(fullSecret).digest("hex");

  const expiresAt = data.expiresInDays 
    ? new Date(Date.now() + data.expiresInDays * 86400000).toISOString()
    : null;

  const scopesJoined = data.scopes.join(",");

  db.prepare(`
    INSERT INTO admin_api_keys (
      id, organization_id, name, key_prefix, key_hash, scopes,
      rate_limit_rpm, monthly_budget_usd, is_active, expires_at, created_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?
    )
  `).run(
    id, data.organizationId, data.name, keyPrefix, keyHash, scopesJoined,
    data.rateLimitRpm || 60, data.monthlyBudgetUsd || 100.0, expiresAt, now
  );

  return {
    record: {
      id,
      organization_id: data.organizationId,
      name: data.name,
      key_prefix: keyPrefix,
      scopes: scopesJoined,
      rate_limit_rpm: data.rateLimitRpm || 60,
      monthly_budget_usd: data.monthlyBudgetUsd || 100.0,
      is_active: 1,
      expires_at: expiresAt,
      last_used_at: null,
      created_at: now,
    },
    fullSecret,
  };
}

export function revokeApiKey(keyId: string, orgId: string = "org-legal-corp"): boolean {
  const db = getDb();
  const res = db.prepare(`
    UPDATE admin_api_keys
    SET is_active = 0
    WHERE id = ? AND organization_id = ?
  `).run(keyId, orgId);

  return res.changes > 0;
}
