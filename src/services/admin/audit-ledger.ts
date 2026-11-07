import { getDb } from "../db/index.js";
import crypto from "node:crypto";

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

export function logAuditEvent(event: Omit<AuditEventRecord, "id" | "created_at">): AuditEventRecord {
  const db = getDb();
  const id = `audit-${crypto.randomUUID()}`;
  const now = new Date().toISOString();

  // Auto-redact secrets from details
  let sanitizedDetails = event.details;
  try {
    const parsed = JSON.parse(event.details);
    if (parsed.secret) parsed.secret = "[REDACTED]";
    if (parsed.apiKey) parsed.apiKey = "[REDACTED]";
    if (parsed.password) parsed.password = "[REDACTED]";
    sanitizedDetails = JSON.stringify(parsed);
  } catch {}

  const record: AuditEventRecord = {
    id,
    ...event,
    details: sanitizedDetails,
    created_at: now,
  };

  db.prepare(`
    INSERT INTO admin_audit_events (
      id, actor_id, actor_email, actor_role, organization_id,
      action, target_type, target_id, status, ip_address, user_agent, details, created_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    )
  `).run(
    record.id, record.actor_id, record.actor_email, record.actor_role,
    record.organization_id, record.action, record.target_type, record.target_id,
    record.status, record.ip_address, record.user_agent, record.details, record.created_at
  );

  return record;
}

export function listAuditLogs(orgId: string = "org-legal-corp", limit: number = 50): AuditEventRecord[] {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM admin_audit_events
    WHERE organization_id = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(orgId, limit) as unknown as AuditEventRecord[];
}
