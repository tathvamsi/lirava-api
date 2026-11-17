import type postgres from "postgres";

export const DEFAULT_SCHEMA_LOCK_KEY = 727_001;
export const LEGAL_SCHEMA_LOCK_KEY = 742_918;

/**
 * Runs schema setup (CREATE / ALTER / renames) while holding a PostgreSQL advisory lock, so that when several
 * processes start at once (two backend instances, or tests running in parallel) they set up one at a time
 * instead of deadlocking on each other's table locks. The lock is released when the transaction ends.
 */
export async function withSchemaLock<T>(
  sql: postgres.Sql,
  work: (tx: postgres.Sql) => Promise<T>,
  lockKey: number = DEFAULT_SCHEMA_LOCK_KEY,
): Promise<T> {
  return (await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(${lockKey})`;
    return work(tx as unknown as postgres.Sql);
  })) as T;
}
