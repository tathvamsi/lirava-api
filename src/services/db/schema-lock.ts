import type postgres from "postgres";

/** One lock for all schema setup in the database (any number from the project's own range). */
const SCHEMA_LOCK_KEY = 727_001;

/**
 * Runs schema setup (CREATE / ALTER / renames) while holding a PostgreSQL advisory lock, so that when several
 * processes start at once (two backend instances, or tests running in parallel) they set up one at a time
 * instead of deadlocking on each other's table locks. The lock is released when the transaction ends.
 */
export async function withSchemaLock<T>(sql: postgres.Sql, work: (tx: postgres.Sql) => Promise<T>): Promise<T> {
  return (await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(${SCHEMA_LOCK_KEY})`;
    return work(tx as unknown as postgres.Sql);
  })) as T;
}
