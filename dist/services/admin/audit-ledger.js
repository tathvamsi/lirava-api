import { getDb } from "../db/index.js";
import crypto from "node:crypto";
export function logAuditEvent(event) {
    const db = getDb();
    const id = `audit-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    // Auto-redact secrets from details
    let sanitizedDetails = event.details;
    try {
        const parsed = JSON.parse(event.details);
        if (parsed.secret)
            parsed.secret = "[REDACTED]";
        if (parsed.apiKey)
            parsed.apiKey = "[REDACTED]";
        if (parsed.password)
            parsed.password = "[REDACTED]";
        sanitizedDetails = JSON.stringify(parsed);
    }
    catch { }
    const record = {
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
  `).run(record.id, record.actor_id, record.actor_email, record.actor_role, record.organization_id, record.action, record.target_type, record.target_id, record.status, record.ip_address, record.user_agent, record.details, record.created_at);
    return record;
}
export function listAuditLogs(orgId = "org-legal-corp", limit = 50) {
    const db = getDb();
    return db.prepare(`
    SELECT * FROM admin_audit_events
    WHERE organization_id = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(orgId, limit);
}
