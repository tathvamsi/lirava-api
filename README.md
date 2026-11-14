# Lirava backend

Hono + TypeScript service behind the Lirava web app. It owns authentication, chats, matters, documents, uploads, the agent runtime and legal search.

## Storage

Everything is stored in **PostgreSQL** (`DATABASE_URL`), each row tied to its owner and every query filtered by it. Nothing is kept on the server's disk or in the browser:

- users, sessions and **all chats** (`chat_conversations`, `chat_messages`, with the sources each answer used; chats can be pinned or archived)
- Vakils, matters, saved documents and **uploaded files** (`app_vakils`, `app_matters`, `app_artifacts`, `app_files`; file bytes are in the database, so a second instance sees the same files)
- the page-by-page **search index of matter documents** (`matter_documents`, `document_chunks`) and the **statute library** (`legal_provisions`, plus the uploaded Acts in `app_admin_documents`)
- administrator settings (models, nodes, API keys, audit log), connector and plugin settings, and per-user preferences (`user_preferences`: when each Vakil was last read, the document preview width)

Tables are created on startup, with a PostgreSQL advisory lock so several instances starting together set up one at a time. Data stored under the older names ("dot", "agent") is renamed to "Vakil" automatically.

If an older installation kept data in a local file (`dots.db` in `LEGACY_DATA_DIR`), that file is read **once** and its rows with a known owner are copied into PostgreSQL. It is never written to again, and a new installation never creates it.

A "Vakil" is the AI advocate a user chats with (Soli Master, Nyaya, Vakil, Pramaan, Docket, or one they create).

## How answers are made

1. **Your documents:** files attached to a chat are read page by page and indexed. A question searches the documents of that chat and of its matter, and the matching passages (with their page) go to the model as labelled excerpts. The answer shows them under "Sources consulted", linking to the page.
2. **Statutes:** provisions come from the statute library by full-text search and, when the embedding server is up, by semantic search too. Administrators load an Act (PDF, Word or text) in the admin console; it is split into sections and searchable at once. **You supply the official text**: the built-in set is a small starter.
3. **Background replies:** a message is saved and returned at once; the answer streams in through the live event stream. At most `MAX_RUNS_PER_USER` (2) answers per user and `MAX_CONCURRENT_RUNS` (4) overall are generated at a time; the rest show as "waiting". Stop keeps the part already written.
4. With no sources found, or the model down, the answer says so plainly instead of citing anything.

## Run locally

```bash
pnpm install
cp .env.example .env      # development only needs DATABASE_URL (and the model/Qdrant addresses to get real answers)
pnpm dev                  # http://localhost:4000
pnpm test                 # needs a reachable PostgreSQL in DATABASE_URL
```

## Production

`NODE_ENV=production` makes the server **refuse to start** unless `SESSION_SECRET` (32+ characters, same as the web app), `DATABASE_URL`, `CORS_ORIGINS`, `CUSTOM_LLM_BASE_URL`, `ADMIN_EMAILS` and a signup gate (`SIGNUP_INVITE_CODES` / `SIGNUP_ALLOWED_DOMAINS`, or `ALLOW_OPEN_SIGNUP=true`) are set. See `.env.example`.

- `GET /health` is liveness; `GET /ready` checks PostgreSQL. The Docker health check uses `/ready`.
- Set `TRUST_PROXY=true` only when the backend is reached through the web app or a trusted proxy.
- `docker build -t lirava-api .` then run with the env file and a volume on `/data`.

## Known limits

- With the model server unreachable, the service answers with a clearly labelled reference summary from the built-in statute library instead of an AI answer.
- The statute library is a small hand-written seed set. Case law, and indexing of uploaded matter documents, are not built: admin uploads are stored but marked `uploaded` (not indexed).
- PDF export covers Latin text. Documents with Hindi or other scripts export to Word (.docx) in full.
