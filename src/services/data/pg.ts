/**
 * PostgreSQL storage for Vakils, matters, saved documents and uploaded files, alongside users, sessions
 * and chats. Tables are prefixed `app_` so they never collide with the web app's own schema.
 *
 * Uploaded files are stored in the database (`bytea`) rather than on this machine's disk, so a second
 * backend instance sees the same files and one database backup covers everything a lawyer has stored.
 */
import fs from "node:fs";
import path from "node:path";
import { config } from "../../config.js";
import { getSql } from "../db/postgres.js";
import { getLegacyDb } from "../db/index.js";
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

/** The Postgres client once the tables exist, the built-in Vakils are present, and old local data is imported. */
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
      await importLegacyData().catch((err) => console.error("[data] could not import the old local data:", err.message));
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

/**
 * Copies Vakils, matters, documents and files from the old local (SQLite) store into PostgreSQL, once.
 * Only rows with a known owner are copied: unowned rows cannot be attributed to anyone, so they are left
 * behind rather than shown to every user. The local file is left untouched.
 */
export async function importLegacyData(force = false): Promise<{ vakils: number; matters: number; artifacts: number; files: number } | null> {
  const sql = getSql();
  if (!sql) return null;
  // The old local file, if this machine has one. A new installation has none and nothing to import.
  const db = getLegacyDb();
  if (!db) return null;
  const flagKey = "data_imported_to_postgres_v1";
  if (!force && (await sql`SELECT 1 FROM app_settings WHERE key = ${flagKey}`).length) return null;

  const counts = { vakils: 0, matters: 0, artifacts: 0, files: 0 };
  const rows = (query: string) => db.prepare(query).all() as Array<Record<string, any>>;
  const parse = (value: unknown, fallback: unknown) => {
    try {
      return typeof value === "string" ? JSON.parse(value) : fallback;
    } catch {
      return fallback;
    }
  };

  for (const r of rows("SELECT * FROM dots WHERE user_id <> ''")) {
    const done = await sql`
      INSERT INTO app_vakils (id, user_id, name, purpose, instructions, look, status, local_access, model, created_at)
      VALUES (${r.id}, ${r.user_id}, ${r.name}, ${r.purpose ?? ""}, ${r.instructions ?? ""}, ${sql.json(parse(r.look, {}))}, 'idle',
              ${r.local_access === 1}, ${r.model ?? null}, ${r.created_at})
      ON CONFLICT (id) DO NOTHING RETURNING id`;
    counts.vakils += done.length;
  }
  for (const r of rows("SELECT * FROM matters WHERE user_id <> ''")) {
    const done = await sql`
      INSERT INTO app_matters (id, user_id, title, client, court, status, next_date, notes, created_at, updated_at)
      VALUES (${r.id}, ${r.user_id}, ${r.title}, ${r.client ?? ""}, ${r.court ?? ""}, ${r.status ?? "active"}, ${r.next_date ?? null},
              ${r.notes ?? ""}, ${r.created_at}, ${r.updated_at})
      ON CONFLICT (id) DO NOTHING RETURNING id`;
    counts.matters += done.length;
  }
  for (const r of rows("SELECT * FROM artifacts WHERE user_id <> ''")) {
    const done = await sql`
      INSERT INTO app_artifacts (id, user_id, vakil_id, conversation_id, title, filename, kind, content, summary, metadata, file_id, pdf_file_id, docx_file_id, created_at, updated_at)
      VALUES (${r.id}, ${r.user_id}, ${r.dot_id}, ${r.conversation_id ?? null}, ${r.title}, ${r.filename ?? ""}, ${r.kind ?? "document"}, ${r.content ?? ""},
              ${r.summary ?? null}, ${r.metadata ? sql.json(parse(r.metadata, null)) : null}, ${r.file_id ?? null}, ${r.pdf_file_id ?? null},
              ${r.docx_file_id ?? null}, ${r.created_at}, ${r.updated_at})
      ON CONFLICT (id) DO NOTHING RETURNING id`;
    counts.artifacts += done.length;
  }
  const filesDir = path.join(config.legacyDataDir, "files");
  for (const r of rows("SELECT * FROM files WHERE user_id <> ''")) {
    const blob = path.join(filesDir, String(r.id));
    if (!fs.existsSync(blob)) continue;
    const data = fs.readFileSync(blob);
    const done = await sql`
      INSERT INTO app_files (id, user_id, vakil_id, name, mime, size, data, created_at)
      VALUES (${r.id}, ${r.user_id}, ${r.dot_id ?? null}, ${r.name}, ${r.mime || r.type || "application/octet-stream"}, ${data.length}, ${data}, ${r.created_at})
      ON CONFLICT (id) DO NOTHING RETURNING id`;
    counts.files += done.length;
  }

  await importLegacyAdmin(sql, db).catch((err) => console.warn("[data] could not import the old admin settings:", err.message));
  await sql`INSERT INTO app_settings (key, value) VALUES (${flagKey}, ${JSON.stringify({ at: Date.now(), ...counts })}) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
  if (counts.vakils + counts.matters + counts.artifacts + counts.files > 0) {
    console.log(`[soli-backend] Imported local data into PostgreSQL: ${counts.vakils} Vakils, ${counts.matters} matters, ${counts.artifacts} documents, ${counts.files} files`);
  }
  return counts;
}

/** A small system setting, e.g. whether an import has already run. */
export async function getSetting(key: string): Promise<string | null> {
  const sql = await pgData();
  const rows = await sql`SELECT value FROM app_settings WHERE key = ${key}`;
  return rows[0] ? (rows[0].value as string) : null;
}

export async function setSetting(key: string, value: string): Promise<void> {
  const sql = await pgData();
  await sql`INSERT INTO app_settings (key, value) VALUES (${key}, ${value}) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
}

type LegacyDb = NonNullable<ReturnType<typeof getLegacyDb>>;

/** Copies administrator and connector settings from the old local file. Existing rows are never overwritten. */
async function importLegacyAdmin(sql: ReturnType<typeof getSql> & object, db: LegacyDb): Promise<void> {
  const rows = (query: string): Array<Record<string, any>> => {
    try {
      return db.prepare(query).all() as Array<Record<string, any>>;
    } catch {
      return []; // that table does not exist in this file
    }
  };
  for (const r of rows("SELECT * FROM admin_models")) {
    await sql`INSERT INTO app_models (id, name, provider, gguf_file, quantization, context_window, disk_size_bytes, status, storage_path, temperature, top_p, active_node_id, error_message, created_at, updated_at)
      VALUES (${r.id}, ${r.name}, ${r.provider}, ${r.gguf_file}, ${r.quantization}, ${r.context_window}, ${r.disk_size_bytes}, ${r.status}, ${r.storage_path}, ${r.temperature}, ${r.top_p}, ${r.active_node_id ?? null}, ${r.error_message ?? null}, ${r.created_at}, ${r.updated_at})
      ON CONFLICT (id) DO NOTHING`;
  }
  for (const r of rows("SELECT * FROM admin_inference_nodes")) {
    await sql`INSERT INTO app_nodes (id, name, address, status, enabled, is_draining, active_connections, vram_used_bytes, vram_total_bytes, latency_ms, loaded_model_id, last_heartbeat_at, created_at)
      VALUES (${r.id}, ${r.name}, ${r.address}, ${r.status}, ${r.enabled}, ${r.is_draining}, ${r.active_connections}, ${r.vram_used_bytes}, ${r.vram_total_bytes}, ${r.latency_ms}, ${r.loaded_model_id ?? null}, ${r.last_heartbeat_at}, ${r.created_at})
      ON CONFLICT (id) DO NOTHING`;
  }
  for (const r of rows("SELECT * FROM admin_api_keys")) {
    await sql`INSERT INTO app_api_keys (id, organization_id, name, key_prefix, key_hash, scopes, rate_limit_rpm, monthly_budget_usd, is_active, expires_at, last_used_at, created_at)
      VALUES (${r.id}, ${r.organization_id}, ${r.name}, ${r.key_prefix}, ${r.key_hash}, ${r.scopes}, ${r.rate_limit_rpm}, ${r.monthly_budget_usd}, ${r.is_active}, ${r.expires_at ?? null}, ${r.last_used_at ?? null}, ${r.created_at})
      ON CONFLICT (id) DO NOTHING`;
  }
  for (const r of rows("SELECT * FROM admin_audit_events")) {
    await sql`INSERT INTO app_audit_events (id, actor_id, actor_email, actor_role, organization_id, action, target_type, target_id, status, ip_address, user_agent, details, created_at)
      VALUES (${r.id}, ${r.actor_id}, ${r.actor_email}, ${r.actor_role}, ${r.organization_id}, ${r.action}, ${r.target_type}, ${r.target_id}, ${r.status}, ${r.ip_address}, ${r.user_agent}, ${r.details}, ${r.created_at})
      ON CONFLICT (id) DO NOTHING`;
  }
  for (const r of rows("SELECT * FROM connector_connections")) {
    await sql`INSERT INTO app_connector_connections (user_id, toolkit_slug, composio_connected_account_id, status, connected_at, last_used_at, updated_at)
      VALUES (${r.user_id}, ${r.toolkit_slug}, ${r.composio_connected_account_id ?? null}, ${r.status}, ${r.connected_at ?? null}, ${r.last_used_at ?? null}, ${r.updated_at})
      ON CONFLICT (user_id, toolkit_slug) DO NOTHING`;
  }
  for (const r of rows("SELECT * FROM plugins_installed")) {
    await sql`INSERT INTO app_plugins_installed (id, user_id, plugin_id, version, enabled, scope, installed_at)
      VALUES (${r.id}, ${r.user_id}, ${r.plugin_id}, ${r.version}, ${r.enabled}, ${r.scope}, ${r.installed_at})
      ON CONFLICT (user_id, plugin_id) DO NOTHING`;
  }
  for (const r of rows("SELECT * FROM composio_user_keys")) {
    await sql`INSERT INTO app_composio_user_keys (user_id, api_key_enc, updated_at) VALUES (${r.user_id}, ${r.api_key_enc}, ${r.updated_at}) ON CONFLICT (user_id) DO NOTHING`;
  }
}
