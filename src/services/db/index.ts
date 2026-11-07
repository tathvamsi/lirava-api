import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { config } from "../../config.js";

let dbInstance: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (dbInstance) return dbInstance;

  const dbDir = config.dotsDataDir;
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  const dbPath = path.join(dbDir, "dots.db");
  dbInstance = new DatabaseSync(dbPath);

  initSchema(dbInstance);
  return dbInstance;
}

function initSchema(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS dots (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      purpose TEXT NOT NULL DEFAULT '',
      instructions TEXT NOT NULL DEFAULT '',
      look TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'idle',
      local_access INTEGER NOT NULL DEFAULT 0,
      thread TEXT,
      pending TEXT,
      user_id TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      dot_id TEXT NOT NULL,
      conversation_id TEXT,
      role TEXT NOT NULL,
      text TEXT NOT NULL DEFAULT '',
      title TEXT,
      card TEXT,
      source TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_dot ON messages(dot_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at);

    CREATE TABLE IF NOT EXISTS matters (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL,
      client TEXT NOT NULL DEFAULT '',
      court TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
      next_date TEXT,
      notes TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_matters_user ON matters(user_id, updated_at);

    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      dot_id TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      user_id TEXT NOT NULL DEFAULT '',
      matter_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_conversations_dot ON conversations(dot_id, created_at);

    CREATE TABLE IF NOT EXISTS artifacts (
      id TEXT PRIMARY KEY,
      dot_id TEXT NOT NULL,
      conversation_id TEXT,
      title TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'document',
      content TEXT NOT NULL DEFAULT '',
      user_id TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_artifacts_user ON artifacts(user_id, created_at);


    CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY,
      dot_id TEXT,
      name TEXT NOT NULL,
      size INTEGER NOT NULL,
      type TEXT NOT NULL,
      data BLOB,
      user_id TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS rules (
      id TEXT PRIMARY KEY,
      dot_id TEXT,
      action TEXT NOT NULL,
      decision TEXT NOT NULL,
      user_id TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      dot_id TEXT NOT NULL,
      text TEXT NOT NULL,
      user_id TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS skills (
      id TEXT PRIMARY KEY,
      dot_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      body TEXT NOT NULL,
      user_id TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS routines (
      id TEXT PRIMARY KEY,
      dot_id TEXT NOT NULL,
      name TEXT NOT NULL,
      instruction TEXT NOT NULL,
      schedule TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      last_run_at INTEGER,
      user_id TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );


    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- Admin Models Table
    CREATE TABLE IF NOT EXISTS admin_models (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'llama.cpp',
      gguf_file TEXT NOT NULL,
      quantization TEXT NOT NULL DEFAULT 'Q4_K_M',
      context_window INTEGER NOT NULL DEFAULT 4096,
      disk_size_bytes INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'ready',
      storage_path TEXT NOT NULL,
      temperature REAL NOT NULL DEFAULT 0.2,
      top_p REAL NOT NULL DEFAULT 0.85,
      active_node_id TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    -- Admin Inference Nodes Table
    CREATE TABLE IF NOT EXISTS admin_inference_nodes (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      address TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'healthy',
      enabled INTEGER NOT NULL DEFAULT 1,
      is_draining INTEGER NOT NULL DEFAULT 0,
      active_connections INTEGER NOT NULL DEFAULT 0,
      vram_used_bytes INTEGER NOT NULL DEFAULT 0,
      vram_total_bytes INTEGER NOT NULL DEFAULT 0,
      latency_ms INTEGER NOT NULL DEFAULT 0,
      loaded_model_id TEXT,
      last_heartbeat_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    -- Admin Documents & Collections
    CREATE TABLE IF NOT EXISTS admin_documents (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      title TEXT NOT NULL,
      file_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      page_count INTEGER NOT NULL DEFAULT 0,
      chunk_count INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      requires_ocr INTEGER NOT NULL DEFAULT 0,
      job_stage TEXT,
      error_message TEXT,
      storage_path TEXT NOT NULL,
      checksum_sha256 TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_admin_docs_org ON admin_documents(organization_id);

    CREATE TABLE IF NOT EXISTS admin_collections (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      document_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS admin_collection_documents (
      collection_id TEXT NOT NULL,
      document_id TEXT NOT NULL,
      organization_id TEXT NOT NULL,
      added_at TEXT NOT NULL,
      PRIMARY KEY (collection_id, document_id)
    );

    -- Admin API Keys Table
    CREATE TABLE IF NOT EXISTS admin_api_keys (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      name TEXT NOT NULL,
      key_prefix TEXT NOT NULL,
      key_hash TEXT NOT NULL,
      scopes TEXT NOT NULL,
      rate_limit_rpm INTEGER NOT NULL DEFAULT 60,
      monthly_budget_usd REAL NOT NULL DEFAULT 100.0,
      is_active INTEGER NOT NULL DEFAULT 1,
      expires_at TEXT,
      last_used_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_admin_api_keys_hash ON admin_api_keys(key_hash);

    -- Operational Audit Log
    CREATE TABLE IF NOT EXISTS admin_audit_events (
      id TEXT PRIMARY KEY,
      actor_id TEXT NOT NULL,
      actor_email TEXT NOT NULL,
      actor_role TEXT NOT NULL,
      organization_id TEXT NOT NULL,
      action TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      status TEXT NOT NULL,
      ip_address TEXT NOT NULL,
      user_agent TEXT NOT NULL,
      details TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_audit_org ON admin_audit_events(organization_id, created_at);

    -- Operational Jobs Queue
    CREATE TABLE IF NOT EXISTS admin_jobs (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      organization_id TEXT NOT NULL,
      stage TEXT NOT NULL DEFAULT 'QUEUED',
      status TEXT NOT NULL DEFAULT 'QUEUED',
      progress_pct INTEGER NOT NULL DEFAULT 0,
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      error_message TEXT,
      error_category TEXT,
      payload TEXT NOT NULL DEFAULT '{}',
      started_at TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_admin_jobs_status ON admin_jobs(status);

    CREATE TABLE IF NOT EXISTS connector_connections (
      user_id TEXT NOT NULL,
      toolkit_slug TEXT NOT NULL,
      composio_connected_account_id TEXT,
      status TEXT NOT NULL DEFAULT 'initiated',
      connected_at INTEGER,
      last_used_at INTEGER,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, toolkit_slug)
    );

    CREATE TABLE IF NOT EXISTS connector_attempts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      toolkit_slug TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS connector_tool_permissions (
      user_id TEXT NOT NULL,
      toolkit_slug TEXT NOT NULL,
      tool_slug TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'needs_approval',
      PRIMARY KEY (user_id, toolkit_slug, tool_slug)
    );

    CREATE TABLE IF NOT EXISTS firm_connector_policy (
      organization_id TEXT NOT NULL,
      toolkit_slug TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      allow_write_tools INTEGER NOT NULL DEFAULT 0,
      default_mode TEXT NOT NULL DEFAULT 'needs_approval',
      PRIMARY KEY (organization_id, toolkit_slug)
    );

    CREATE TABLE IF NOT EXISTS plugins_installed (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      plugin_id TEXT NOT NULL,
      version TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      scope TEXT NOT NULL DEFAULT 'user',
      installed_at INTEGER NOT NULL,
      UNIQUE (user_id, plugin_id)
    );

    CREATE TABLE IF NOT EXISTS tool_call_audit (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      chat_id TEXT,
      toolkit_slug TEXT NOT NULL,
      tool_slug TEXT NOT NULL,
      input_summary TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS mcp_connections (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      connector_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'initiated',
      account_label TEXT,
      scopes TEXT NOT NULL DEFAULT '',
      access_token_enc TEXT,
      refresh_token_enc TEXT,
      expires_at INTEGER,
      client_registration TEXT,
      connected_at INTEGER,
      last_used_at INTEGER,
      UNIQUE (user_id, connector_id)
    );

    CREATE TABLE IF NOT EXISTS oauth_states (
      state TEXT PRIMARY KEY,
      code_verifier TEXT NOT NULL,
      user_id TEXT NOT NULL,
      connector_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS composio_user_keys (
      user_id TEXT PRIMARY KEY,
      api_key_enc TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  migrate(db);
}

/** Add columns that were introduced after the first schema was deployed. */
function migrate(db: DatabaseSync) {
  const columns = (table: string) =>
    new Set(
      (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name),
    );

  // conversations.updated_at was added after the initial schema; older DBs
  // still carry the NOT NULL variant, so backfill before dropping the flag.
  const convCols = columns("conversations");
  if (!convCols.has("matter_id")) {
    db.exec(`ALTER TABLE conversations ADD COLUMN matter_id TEXT`);
  }
  if (!convCols.has("updated_at")) {
    db.exec(`ALTER TABLE conversations ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0`);
    db.exec(`UPDATE conversations SET updated_at = created_at WHERE updated_at = 0 OR updated_at IS NULL`);
  }

  const artCols = columns("artifacts");
  if (!artCols.has("filename")) {
    db.exec(`ALTER TABLE artifacts ADD COLUMN filename TEXT NOT NULL DEFAULT ''`);
  }
  if (!artCols.has("summary")) {
    db.exec(`ALTER TABLE artifacts ADD COLUMN summary TEXT`);
  }
  if (!artCols.has("metadata")) {
    db.exec(`ALTER TABLE artifacts ADD COLUMN metadata TEXT`);
  }
  if (!artCols.has("file_id")) {
    db.exec(`ALTER TABLE artifacts ADD COLUMN file_id TEXT`);
  }
  if (!artCols.has("pdf_file_id")) {
    db.exec(`ALTER TABLE artifacts ADD COLUMN pdf_file_id TEXT`);
  }
  if (!artCols.has("docx_file_id")) {
    db.exec(`ALTER TABLE artifacts ADD COLUMN docx_file_id TEXT`);
  }

  seedChamberDots(db);
}

function seedChamberDots(db: DatabaseSync) {
  const dots = [
    {
      id: "soli_master",
      name: "Soli Master",
      purpose: "Autonomous Legal Orchestrator & Chamber Director. Automatically evaluates tasks and coordinates specialist counsel.",
      look: JSON.stringify({ color: "#D4AF37", shape: "circle" }),
    },
    {
      id: "nyaya",
      name: "Nyaya",
      purpose: "Senior Legal Researcher & Constitutional Jurist. Precedent ratio extraction, statutory interpretation & comparative law.",
      look: JSON.stringify({ color: "#2563EB", shape: "circle" }),
    },
    {
      id: "vakil",
      name: "Vakil",
      purpose: "Courtroom Drafting Counsel & Advocate. Court pleadings, bail applications, statutory notices & petitions.",
      look: JSON.stringify({ color: "#059669", shape: "circle" }),
    },
    {
      id: "pramaan",
      name: "Pramaan",
      purpose: "Forensic Case Scrutiny & Evidence Auditor. Contradiction matrices, Section 63 BSA compliance & timelines.",
      look: JSON.stringify({ color: "#D97706", shape: "circle" }),
    },
    {
      id: "docket",
      name: "Docket",
      purpose: "Chamber Practice Manager & Limitation Coordinator. Limitation calculations, cause list tracking & hearing preparation.",
      look: JSON.stringify({ color: "#7C3AED", shape: "circle" }),
    },
  ];

  const insertStmt = db.prepare(`
    INSERT OR REPLACE INTO dots (id, name, purpose, look, status, user_id, created_at)
    VALUES (?, ?, ?, ?, 'idle', '', ?)
  `);

  const now = Date.now();
  for (const d of dots) {
    const existing = db.prepare("SELECT id FROM dots WHERE id = ?").get(d.id);
    if (!existing) {
      insertStmt.run(d.id, d.name, d.purpose, d.look, now);
    }
  }
}
