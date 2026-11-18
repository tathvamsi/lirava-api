import crypto from "node:crypto";
import { pgData } from "../data/pg.js";
export async function logAuditEvent(event) {
    const sql = await pgData();
    const id = `audit-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    // Secrets never reach the ledger.
    let details = event.details;
    try {
        const parsed = JSON.parse(event.details);
        for (const key of ["secret", "apiKey", "password"])
            if (parsed[key])
                parsed[key] = "[REDACTED]";
        details = JSON.stringify(parsed);
    }
    catch {
        // Not JSON: stored as given.
    }
    const record = { id, ...event, details, created_at: now };
    await sql `
    INSERT INTO app_audit_events (id, actor_id, actor_email, actor_role, organization_id, action, target_type, target_id, status, ip_address, user_agent, details, created_at)
    VALUES (${record.id}, ${record.actor_id}, ${record.actor_email}, ${record.actor_role}, ${record.organization_id}, ${record.action},
            ${record.target_type}, ${record.target_id}, ${record.status}, ${record.ip_address}, ${record.user_agent}, ${record.details}, ${record.created_at})`;
    return record;
}
export async function listAuditLogs(orgId = "org-legal-corp", limit = 50) {
    const sql = await pgData();
    const rows = await sql `SELECT * FROM app_audit_events WHERE organization_id = ${orgId} ORDER BY created_at DESC LIMIT ${limit}`;
    return rows;
}
