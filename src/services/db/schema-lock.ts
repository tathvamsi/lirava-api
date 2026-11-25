import type postgres from "postgres";

export const DEFAULT_SCHEMA_LOCK_KEY = 727_001;
export const LEGAL_SCHEMA_LOCK_KEY = 742_918;

/** Identifies the running deployment. Empty outside Vercel (development and tests), where setup always runs as before. */
const BUILD = process.env.VERCEL_DEPLOYMENT_ID || process.env.VERCEL_GIT_COMMIT_SHA || "";

/** How long to wait for the lock before going ahead without it. Setup is all CREATE ... IF NOT EXISTS, so this is safe. */
const LOCK_WAIT_MS = Number(process.env.SCHEMA_LOCK_WAIT_MS || 15_000);

/**
 * Which schema steps this deployment has already finished, read with ONE query per process. Before this, every cold start
 * of every instance re-ran all of the setup (about sixteen transactions of DDL, each several round trips to a database in
 * another region) and queued behind a single lock, so a request that landed on a fresh instance could wait for minutes.
 * Now an instance whose deployment has already set the schema up skips it.
 */
let applied: Promise<Set<string>> | null = null;
function appliedSteps(sql: postgres.Sql): Promise<Set<string>> {
  if (!applied) {
    applied = (async () => {
      try {
        await sql`CREATE TABLE IF NOT EXISTS schema_runs (key TEXT NOT NULL, build TEXT NOT NULL, applied_at BIGINT NOT NULL, PRIMARY KEY (key, build))`;
      } catch {
        /* two instances creating it at once: one loses the race, and the table exists either way */
      }
      const rows = await sql`SELECT key FROM schema_runs WHERE build = ${BUILD}`;
      return new Set<string>(rows.map((row) => row.key as string));
    })().catch(() => {
      applied = null;
      return new Set<string>();
    });
  }
  return applied;
}

/** The place in our code that asked for the setup, so each setup step has its own stable name within a deployment. */
function callerKey(): string | null {
  const frames = (new Error().stack ?? "").split("\n").slice(1);
  const frame = frames.find((line) => !/schema-lock/.test(line) && /\.(ts|js|mjs|cjs):\d+/.test(line));
  // File, line and column: a bundled build can put several call sites on one line, but never at the same column.
  const match = frame && /([^\\/():\s]+\.(?:ts|js|mjs|cjs)):(\d+):(\d+)/.exec(frame);
  return match ? `${match[1]}:${match[2]}:${match[3]}` : null;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs schema setup (CREATE / ALTER / renames) while holding a PostgreSQL advisory lock, so that when several
 * processes start at once (two backend instances, or tests running in parallel) they set up one at a time
 * instead of deadlocking on each other's table locks. The lock is released when the transaction ends.
 *
 * Two safeguards keep a stuck holder from freezing the app. A holder that is frozen or killed mid-setup (a serverless
 * instance can be) keeps the lock until the database drops its connection, so waiting is bounded: after LOCK_WAIT_MS the
 * setup goes ahead without it, and its own lock waits are capped. And on Vercel a step that this deployment has already
 * completed is not run again.
 */
export async function withSchemaLock<T>(
  sql: postgres.Sql,
  work: (tx: postgres.Sql) => Promise<T>,
  lockKey: number = DEFAULT_SCHEMA_LOCK_KEY,
): Promise<T> {
  const key = BUILD ? callerKey() : null;
  const done = key ? await appliedSteps(sql) : null;
  if (key && done?.has(key)) return undefined as T;

  const result = (await sql.begin(async (tx) => {
    await tx`SET LOCAL lock_timeout = '20s'`;
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      const [{ ok }] = await tx`SELECT pg_try_advisory_xact_lock(${lockKey}) AS ok`;
      if (ok) break;
      if (Date.now() >= deadline) {
        console.warn(`[schema] lock ${lockKey} still held after ${LOCK_WAIT_MS}ms; continuing without it`);
        break;
      }
      await sleep(250);
    }
    const out = await work(tx as unknown as postgres.Sql);
    if (key) await tx`INSERT INTO schema_runs (key, build, applied_at) VALUES (${key}, ${BUILD}, ${Date.now()}) ON CONFLICT DO NOTHING`;
    return out;
  })) as T;
  if (key) done?.add(key);
  return result;
}
