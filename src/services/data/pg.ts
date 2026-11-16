/**
 * PostgreSQL storage for Vakils, matters, saved documents and uploaded files, alongside users, sessions
 * and chats. Tables are prefixed `app_` so they never collide with the web app's own schema.
 *
 * Uploaded files are stored in the database (`bytea`) rather than on this machine's disk, so a second
 * backend instance sees the same files and one database backup covers everything a lawyer has stored.
 */
import { getSql } from "../db/postgres.js";
import { ADMIN_SCHEMA } from "./admin-schema.js";
import { migrateVakilNaming } from "../db/migrate-naming.js";
import { withSchemaLock } from "../db/schema-lock.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS app_vakils (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL DEFAULT '',
  name          TEXT NOT NULL,
  purpose       TEXT NOT NULL DEFAULT '',
  instructions  TEXT NOT NULL DEFAULT '',
  look          JSONB NOT NULL DEFAULT '{}'::jsonb,
  status        TEXT NOT NULL DEFAULT 'idle',
  local_access  BOOLEAN NOT NULL DEFAULT FALSE,
  model         TEXT,
  created_at    BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS app_vakils_user_idx ON app_vakils (user_id);

CREATE TABLE IF NOT EXISTS app_matters (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  title       TEXT NOT NULL,
  client      TEXT NOT NULL DEFAULT '',
  court       TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'active',
  next_date   TEXT,
  notes       TEXT NOT NULL DEFAULT '',
  created_at  BIGINT NOT NULL,
  updated_at  BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS app_matters_user_idx ON app_matters (user_id, updated_at DESC);
ALTER TABLE app_matters ADD COLUMN IF NOT EXISTS stage TEXT NOT NULL DEFAULT 'received';
ALTER TABLE app_matters ADD COLUMN IF NOT EXISTS intake JSONB;
ALTER TABLE app_matters ADD COLUMN IF NOT EXISTS handed_over_at BIGINT;

-- What happened on a matter, newest last: stage changes, notes from counsel, approval checkpoints and finished work.
CREATE TABLE IF NOT EXISTS app_matter_events (
  id              TEXT PRIMARY KEY,
  matter_id       TEXT NOT NULL,
  user_id         TEXT NOT NULL,
  type            TEXT NOT NULL,
  stage           TEXT,
  title           TEXT NOT NULL,
  body            TEXT NOT NULL DEFAULT '',
  conversation_id TEXT,
  artifact_id     TEXT,
  status          TEXT,
  resolution_note TEXT,
  created_at      BIGINT NOT NULL,
  resolved_at     BIGINT
);
CREATE INDEX IF NOT EXISTS app_matter_events_matter_idx ON app_matter_events (matter_id, created_at);

CREATE TABLE IF NOT EXISTS app_artifacts (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL,
  vakil_id          TEXT NOT NULL,
  conversation_id TEXT,
  title           TEXT NOT NULL,
  filename        TEXT NOT NULL DEFAULT '',
  kind            TEXT NOT NULL DEFAULT 'document',
  content         TEXT NOT NULL DEFAULT '',
  summary         TEXT,
  metadata        JSONB,
  file_id         TEXT,
  pdf_file_id     TEXT,
  docx_file_id    TEXT,
  created_at      BIGINT NOT NULL,
  updated_at      BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS app_artifacts_user_idx ON app_artifacts (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS app_artifacts_conv_idx ON app_artifacts (conversation_id);

CREATE TABLE IF NOT EXISTS app_files (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  vakil_id      TEXT,
  name        TEXT NOT NULL,
  mime        TEXT NOT NULL,
  size        INT NOT NULL,
  data        BYTEA NOT NULL,
  created_at  BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS app_files_user_idx ON app_files (user_id);
`;

/** The shared, built-in Vakils every user can chat with. They have no owner. */
export const BUILT_IN_VAKILS = [
  { id: "soli_master", name: "Soli Master", color: "#D4AF37", purpose: "Autonomous Legal Orchestrator & Chamber Director. Automatically evaluates tasks and coordinates specialist counsel." },
  { id: "nyaya", name: "Nyaya", color: "#2563EB", purpose: "Senior Legal Researcher & Constitutional Jurist. Precedent ratio extraction, statutory interpretation & comparative law." },
  { id: "vakil", name: "Vakil", color: "#059669", purpose: "Courtroom Drafting Counsel & Advocate. Court pleadings, bail applications, statutory notices & petitions." },
  { id: "pramaan", name: "Pramaan", color: "#D97706", purpose: "Forensic Case Scrutiny & Evidence Auditor. Contradiction matrices, Section 63 BSA compliance & timelines." },
  { id: "docket", name: "Docket", color: "#7C3AED", purpose: "Chamber Practice Manager & Limitation Coordinator. Limitation calculations, cause list tracking & hearing preparation." },
];

let ready: Promise<void> | null = null;

/** The Postgres client once the tables exist and the built-in Vakils are present. */
export async function pgData() {
  const sql = getSql();
  if (!sql) throw new Error("DATABASE_URL is not configured. Application data is stored in PostgreSQL.");
  if (!ready) {
    ready = (async () => {
      // Rename anything still stored under the old "dot" / "agent" names (see migrate-naming) before the tables are (re)created.
      await withSchemaLock(sql, async (tx) => {
        await migrateVakilNaming(tx);
        await tx.unsafe(SCHEMA + ADMIN_SCHEMA);
        const now = Date.now();
        for (const [index, vakil] of BUILT_IN_VAKILS.entries()) {
          await tx`
            INSERT INTO app_vakils (id, user_id, name, purpose, look, status, created_at)
            VALUES (${vakil.id}, '', ${vakil.name}, ${vakil.purpose}, ${tx.json({ color: vakil.color, shape: "circle" })}, 'idle', ${now + index})
            ON CONFLICT (id) DO NOTHING`;
        }
      });
    })().catch((err) => {
      ready = null;
      throw err;
    });
  }
  await ready;
  return sql;
}

/** Whether `matterId` is one of this user's matters. */
export async function matterOwned(matterId: string, userId: string): Promise<boolean> {
  const sql = await pgData();
  const rows = await sql`SELECT 1 FROM app_matters WHERE id = ${matterId} AND user_id = ${userId} LIMIT 1`;
  return rows.length > 0;
}
