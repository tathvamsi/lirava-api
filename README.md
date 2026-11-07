# Soli Backend Service (Standalone)

High-performance, decoupled backend service for the **Soli Legal AI Platform**.

This standalone service extracts the heavy AI agent execution runtime, statutory RAG vector search, legal court document generator, and operational administration APIs out of Next.js serverless functions into a dedicated, persistent Node.js/TypeScript process.

---

## Architecture Overview

```
                           ┌────────────────────────┐
                           │   soli-web (Next.js)   │
                           │     Port: 3100         │
                           └───────────┬────────────┘
                                       │
                                       │ REST / SSE
                                       ▼
┌────────────────────────┐ ───► ┌────────────────────────┐ ◄─── ┌────────────────────────┐
│  soli-admin (Next.js)  │      │  soli-backend (Hono)   │      │ soli-desktop (Electron)│
│     Port: 3200         │      │     Port: 4000         │      │                        │
└────────────────────────┘      └───────────┬────────────┘      └────────────────────────┘
                                            │
               ┌────────────────────────────┼────────────────────────────┐
               │                            │                            │
               ▼                            ▼                            ▼
      ┌─────────────────┐          ┌─────────────────┐          ┌─────────────────┐
      │  Local LLM Node │          │ Qdrant Vector DB│          │  dots.db Vault  │
      │   (llama.cpp)   │          │ (Statutory RAG) │          │  (SQLite Sync)  │
      └─────────────────┘          └─────────────────┘          └─────────────────┘
```

---

## Key Benefits of Decoupling

1. **No Next.js Route Timeout Constraints**: Heavy ReAct loops, multi-step legal drafting, and OCR processing run continuously without hitting 15s/30s serverless gateway timeouts.
2. **Persistent Event-Driven Architecture**: Native Server-Sent Events (SSE) and in-memory event bus stream agent thinking steps, approvals, and status transitions reliably.
3. **Independent Scaling**: Scale the backend compute horizontally on GPU/high-memory instances while serving frontend assets via lightweight edge CDNs.
4. **Resilient Hot Reloads**: Frontend UI edits in `soli-web` and `soli-admin` hot-reload instantly without terminating long-running agent threads or database locks.

---

## API Endpoints

### 1. Health & System
- `GET /` - Service status & endpoint discovery
- `GET /api/ping` - Health check & local llama.cpp node heartbeat

### 2. Autonomous Agent
- `POST /api/agent/message` - Send message to litigation persona / dot
- `POST /api/agent/abort` - Terminate active running agent step
- `GET /api/agent/state/:dotId` - Inspect agent run state and step counter

### 3. Real-Time Streaming
- `GET /api/events` - SSE event stream delivering real-time agent output & status

### 4. Legal Document & RAG Engine
- `GET /api/legal/search?q=query&act=BNS` - Statutory similarity search via Qdrant
- `POST /api/legal/generate-pdf` - Generate court-margin PDF pleading
- `POST /api/legal/generate-docx` - Generate editable Microsoft Word pleading

### 5. Unified Administration
- `GET/POST /api/admin/models` - Model Registry & llama.cpp orchestration
- `GET/POST /api/admin/nodes` - Inference Nodes & VRAM tracking
- `GET/POST/DELETE /api/admin/documents` - Multi-tenant confidential vault & OCR pipeline
- `GET/POST/DELETE /api/admin/api-keys` - High-entropy SHA-256 API key management
- `GET /api/admin/analytics` - Operational usage telemetry & token analytics
- `GET /api/admin/audit-logs` - Security audit ledger with auto-redaction

---

## Getting Started

### 1. Installation
```bash
cd soli-backend
pnpm install
```

### 2. Development Mode
```bash
pnpm dev
# Running at http://localhost:4000
```

### 3. Run Test Suite
```bash
pnpm test
```

### 4. Production Build
```bash
pnpm build
pnpm start
```

---

## Consuming with `SoliBackendClient`

```typescript
import { SoliBackendClient } from "soli-backend/client";

const client = new SoliBackendClient({
  baseUrl: "http://localhost:4000",
});

// Send message to legal agent
const response = await client.sendMessage({
  dotId: "dot-criminal-lawyer",
  text: "Draft grounds for a bail petition under BNSS Section 482.",
});

// Search statutory database
const statutes = await client.searchStatutes("bailable offenses under BNS");
```
