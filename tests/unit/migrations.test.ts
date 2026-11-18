/**
 * Unit Test Suite: Database Schema Migrations & Advisory Locking
 * Target: lirava-api/tests/unit/migrations.test.ts
 *
 * Verifies:
 * 1. Schema setup DDL for legal_provisions, legal_cases, and statute_concordance.
 * 2. Concurrency resilience via advisory locking (withSchemaLock, LEGAL_SCHEMA_LOCK_KEY).
 * 3. Idempotent re-execution of all migrations without deadlocks or errors.
 * 4. Column structure and queryability of enhanced schema entities.
 */

import "../mocks/setup.js";
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupTestHarness } from "../mocks/index.js";
import { getSql, setSql } from "../../src/services/db/postgres.js";
import {
  withSchemaLock,
  DEFAULT_SCHEMA_LOCK_KEY,
  LEGAL_SCHEMA_LOCK_KEY,
} from "../../src/services/db/schema-lock.js";
import {
  ensureLegalProvisionsSchema,
  lookupProvision,
} from "../../src/services/legal/provisions.js";
import {
  ensureLegalCasesSchema,
  insertLegalCase,
  lookupCaseCitation,
} from "../../src/services/legal/cases.js";
import {
  ensureConcordanceSchema,
  lookupModernConcordance,
} from "../../src/services/legal/concordance.js";

describe("Migrations: DDL Setup & Advisory Locking", () => {
  beforeEach(() => {
    setupTestHarness();
  });

  it("exports valid schema lock keys", () => {
    assert.strictEqual(DEFAULT_SCHEMA_LOCK_KEY, 727_001);
    assert.strictEqual(LEGAL_SCHEMA_LOCK_KEY, 742_918);
  });

  it("executes withSchemaLock under DEFAULT and LEGAL lock keys", async () => {
    const sql = getSql()!;
    let defaultRun = false;
    let legalRun = false;

    await withSchemaLock(sql, async (tx) => {
      defaultRun = true;
      return tx;
    }, DEFAULT_SCHEMA_LOCK_KEY);

    await withSchemaLock(sql, async (tx) => {
      legalRun = true;
      return tx;
    }, LEGAL_SCHEMA_LOCK_KEY);

    assert.ok(defaultRun, "Default schema lock execution must succeed");
    assert.ok(legalRun, "Legal schema lock execution must succeed");
  });

  it("executes ensureLegalProvisionsSchema idempotently", async () => {
    await ensureLegalProvisionsSchema();
    await ensureLegalProvisionsSchema();
    // Subsequent lookup must function normally
    const prov = await lookupProvision("BNSS", "482");
    assert.ok(prov, "Provisions must remain queryable after schema runs");
  });

  it("executes ensureLegalCasesSchema idempotently", async () => {
    await ensureLegalCasesSchema();
    await ensureLegalCasesSchema();
    const c = await lookupCaseCitation("1992 Supp (1) SCC 335");
    assert.ok(c, "Cases must remain queryable after schema runs");
  });

  it("executes ensureConcordanceSchema idempotently", async () => {
    await ensureConcordanceSchema();
    await ensureConcordanceSchema();
    const mappings = await lookupModernConcordance("CRPC_1973", "482");
    assert.ok(mappings.length > 0, "Concordance must remain queryable after schema runs");
  });

  it("handles concurrent migration invocations without deadlock", async () => {
    const callers = Array.from({ length: 10 }, async (_, i) => {
      if (i % 3 === 0) return ensureLegalProvisionsSchema();
      if (i % 3 === 1) return ensureLegalCasesSchema();
      return ensureConcordanceSchema();
    });

    const results = await Promise.allSettled(callers);
    const failures = results.filter((r) => r.status === "rejected");
    assert.strictEqual(failures.length, 0, "No concurrent migration call should reject");
  });

  it("throws clear error when database client is unconfigured", async () => {
    const currentSql = getSql();
    try {
      setSql(null);
      await assert.rejects(
        async () => {
          await ensureLegalProvisionsSchema();
        },
        /DATABASE_URL is not configured/,
      );
    } finally {
      setSql(currentSql);
    }
  });

  it("inserts and retrieves a legal case adhering to schema fields", async () => {
    const testCase = {
      id: "sc-test-mig-2026",
      case_title: "Test State v. Applicant",
      primary_citation: "2026 INSC 999",
      equivalent_citations: ["2026 SCC OnLine SC 123"],
      neutral_citation: "2026 INSC 999",
      court: "Supreme Court of India",
      year: 2026,
      bench_description: "Constitution Bench",
      ratio: "Testing schema insertion for judicial precedents.",
      principles: ["Principle One", "Principle Two"],
      category: "landmark",
      statutory_citations: [{ act_code: "BNSS", section: "Section 528" }],
    };

    const inserted = await insertLegalCase(testCase);
    assert.strictEqual(inserted.id, testCase.id);
    assert.strictEqual(inserted.primary_citation, testCase.primary_citation);

    const retrieved = await lookupCaseCitation(testCase.primary_citation);
    assert.ok(retrieved);
    assert.strictEqual(retrieved.case_title, testCase.case_title);
  });
});
