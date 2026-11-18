import { pgData } from "../data/pg.js";
const RANGES = {
    "1h": { ms: 3600_000, bucketMs: 5 * 60_000 },
    "24h": { ms: 24 * 3600_000, bucketMs: 3600_000 },
    "7d": { ms: 7 * 24 * 3600_000, bucketMs: 24 * 3600_000 },
    "30d": { ms: 30 * 24 * 3600_000, bucketMs: 24 * 3600_000 },
};
/**
 * What the system actually did: answers written, counted from stored chats. Token counts and latency are
 * not recorded by the service, so they are reported as zero / unavailable rather than invented.
 */
export async function getTelemetryMetrics(timeRange = "24h", orgId) {
    const range = RANGES[timeRange] ?? RANGES["24h"];
    const since = Date.now() - range.ms;
    const sql = await pgData();
    const rows = await sql `
    SELECT (created_at / ${range.bucketMs})::bigint * ${range.bucketMs} AS bucket, COUNT(*)::int AS n
    FROM chat_messages
    WHERE role = 'vakil' AND created_at >= ${since}
    GROUP BY 1 ORDER BY 1`;
    const timeSeries = rows.map((r) => ({
        bucket: new Date(Number(r.bucket)).toISOString().slice(range.bucketMs >= 86_400_000 ? 5 : 11, range.bucketMs >= 86_400_000 ? 10 : 16),
        requests: Number(r.n),
        tokens: 0,
        errors: 0,
    }));
    const total = timeSeries.reduce((sum, p) => sum + p.requests, 0);
    return {
        totalRequests: total,
        successfulRequests: total,
        failedRequests: 0,
        errorRatePercentage: 0,
        totalPromptTokens: 0,
        totalCompletionTokens: 0,
        totalTokens: 0,
        tokenSource: "not recorded",
        isEstimated: true,
        avgLatencyMs: null,
        avgTtftMs: null,
        ttftAvailable: false,
        byModel: {},
        byOrg: { [orgId || "org-legal-corp"]: { requests: total, promptTokens: 0, completionTokens: 0, totalTokens: 0, failures: 0 } },
        byApiKey: {},
        timeSeries,
    };
}
