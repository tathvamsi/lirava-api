/**
 * PostgreSQL tables for administrator settings (model registry, inference nodes, API keys, audit log,
 * statute uploads), connector and plugin settings, and small system settings. These used to live in a
 * local SQLite file; the same fields are kept so the admin console and clients see the same shapes.
 */
export const ADMIN_SCHEMA = `
CREATE TABLE IF NOT EXISTS app_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_preferences (
  user_id    TEXT NOT NULL,
  key        TEXT NOT NULL,
  value      JSONB NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (user_id, key)
);

CREATE TABLE IF NOT EXISTS app_models (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  provider        TEXT NOT NULL DEFAULT 'llama.cpp',
  gguf_file       TEXT NOT NULL,
  quantization    TEXT NOT NULL DEFAULT 'Q4_K_M',
  context_window  INT NOT NULL DEFAULT 4096,
  disk_size_bytes BIGINT NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'ready',
  storage_path    TEXT NOT NULL,
  temperature     REAL NOT NULL DEFAULT 0.2,
  top_p           REAL NOT NULL DEFAULT 0.85,
  active_node_id  TEXT,
  error_message   TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS app_nodes (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  address            TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'healthy',
  enabled            INT NOT NULL DEFAULT 1,
  is_draining        INT NOT NULL DEFAULT 0,
  active_connections INT NOT NULL DEFAULT 0,
  vram_used_bytes    BIGINT NOT NULL DEFAULT 0,
  vram_total_bytes   BIGINT NOT NULL DEFAULT 0,
  latency_ms         INT NOT NULL DEFAULT 0,
  loaded_model_id    TEXT,
  last_heartbeat_at  TEXT NOT NULL,
  created_at         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS app_admin_documents (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  title           TEXT NOT NULL,
  file_name       TEXT NOT NULL,
  mime_type       TEXT NOT NULL,
  size_bytes      BIGINT NOT NULL,
  page_count      INT NOT NULL DEFAULT 0,
  chunk_count     INT NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'pending',
  requires_ocr    INT NOT NULL DEFAULT 0,
  job_stage       TEXT,
  error_message   TEXT,
  storage_path    TEXT NOT NULL,
  checksum_sha256 TEXT NOT NULL,
  data            BYTEA,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS app_admin_documents_org_idx ON app_admin_documents (organization_id, created_at DESC);

CREATE TABLE IF NOT EXISTS app_api_keys (
  id                 TEXT PRIMARY KEY,
  organization_id    TEXT NOT NULL,
  name               TEXT NOT NULL,
  key_prefix         TEXT NOT NULL,
  key_hash           TEXT NOT NULL,
  scopes             TEXT NOT NULL,
  rate_limit_rpm     INT NOT NULL DEFAULT 60,
  monthly_budget_usd REAL NOT NULL DEFAULT 100.0,
  is_active          INT NOT NULL DEFAULT 1,
  expires_at         TEXT,
  last_used_at       TEXT,
  created_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS app_api_keys_hash_idx ON app_api_keys (key_hash);

CREATE TABLE IF NOT EXISTS app_audit_events (
  id              TEXT PRIMARY KEY,
  actor_id        TEXT NOT NULL,
  actor_email     TEXT NOT NULL,
  actor_role      TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  action          TEXT NOT NULL,
  target_type     TEXT NOT NULL,
  target_id       TEXT NOT NULL,
  status          TEXT NOT NULL,
  ip_address      TEXT NOT NULL,
  user_agent      TEXT NOT NULL,
  details         TEXT NOT NULL,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS app_audit_events_org_idx ON app_audit_events (organization_id, created_at DESC);

CREATE TABLE IF NOT EXISTS app_connector_connections (
  user_id                       TEXT NOT NULL,
  toolkit_slug                  TEXT NOT NULL,
  composio_connected_account_id TEXT,
  status                        TEXT NOT NULL DEFAULT 'initiated',
  connected_at                  BIGINT,
  last_used_at                  BIGINT,
  updated_at                    BIGINT NOT NULL,
  PRIMARY KEY (user_id, toolkit_slug)
);

CREATE TABLE IF NOT EXISTS app_connector_attempts (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  toolkit_slug TEXT NOT NULL,
  created_at   BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS app_plugins_installed (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  plugin_id    TEXT NOT NULL,
  version      TEXT NOT NULL,
  enabled      INT NOT NULL DEFAULT 1,
  scope        TEXT NOT NULL DEFAULT 'user',
  installed_at BIGINT NOT NULL,
  UNIQUE (user_id, plugin_id)
);

CREATE TABLE IF NOT EXISTS app_composio_user_keys (
  user_id     TEXT PRIMARY KEY,
  api_key_enc TEXT NOT NULL,
  updated_at  BIGINT NOT NULL
);
`;
