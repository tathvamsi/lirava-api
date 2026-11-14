import crypto from "node:crypto";
import { pgData } from "../data/pg.js";

export interface AuditEventRecord {
  id: string;
  actor_id: string;
  actor_email: string;
  actor_role: string;
  organization_id: string;
  action: string;
  target_type: string;
  target_id: string;
  status: "SUCCESS" | "DENIED" | "ERROR";
  ip_address: string;
  user_agent: string;
  details: string;
  created_at: string;
}

export async function logAuditEvent(event: Omit<AuditEventRecord, "id" | "created_at">): Promise<AuditEventRecord> {
  const sql = await pgData();
  const id = `audit-${crypto.randomUUID()}`;
  const now = new Date().toISOString();

  // Secrets never reach the ledger.
  let details = event.details;
  try {
    const parsed = JSON.parse(event.details);
    for (const key of ["secret", "apiKey", "password"]) if (parsed[key]) parsed[key] = "[REDACTED]";
    details = JSON.stringify(parsed);
  } catch {
    // Not JSON: stored as given.
  }

  const record: AuditEventRecord = { id, ...event, details, created_at: now };
  await sql`
    INSERT INTO app_audit_events (id, actor_id, actor_email, actor_role, organization_id, action, target_type, target_id, status, ip_address, user_agent, details, created_at)
    VALUES (${record.id}, ${record.actor_id}, ${record.actor_email}, ${record.actor_role}, ${record.organization_id}, ${record.action},
            ${record.target_type}, ${record.target_id}, ${record.status}, ${record.ip_address}, ${record.user_agent}, ${record.details}, ${record.created_at})`;
  return record;
}

export async function listAuditLogs(orgId: string = "org-legal-corp", limit: number = 50): Promise<AuditEventRecord[]> {
  const sql = await pgData();
  const rows = await sql`SELECT * FROM app_audit_events WHERE organization_id = ${orgId} ORDER BY created_at DESC LIMIT ${limit}`;
  return rows as unknown as AuditEventRecord[];
}
