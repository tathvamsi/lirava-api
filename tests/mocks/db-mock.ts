import crypto from "node:crypto";
import type postgres from "postgres";

export interface MockUserRow {
  id: string;
  name: string;
  email: string;
  password_hash: string;
  role: "admin" | "user";
  created_at: Date;
  updated_at: Date;
}

export interface MockSessionRow {
  id: string;
  user_id: string;
  expires_at: Date;
  created_at: Date;
}

export interface MockProvisionRow {
  id: string;
  act: string;
  act_code?: string;
  section: string;
  section_num?: string;
  title: string;
  text: string;
  ratio?: string | null;
  source?: string | null;
  year?: number | null;
  category?: string | null;
  document_id?: string | null;
  created_at: number;
  indexed_at?: number | null;
}

export interface MockCaseRow {
  id: string;
  case_title: string;
  primary_citation: string;
  equivalent_citations?: string[];
  neutral_citation?: string;
  court: string;
  year: number;
  bench_description?: string;
  ratio: string;
  principles?: string[];
  category: string;
  statutory_citations?: Array<{ act_code: string; section: string }>;
  created_at?: number;
}

export interface MockConcordanceRow {
  id: string;
  old_act: string;
  old_section: string;
  new_act: string;
  new_section: string;
  subject?: string;
  notes?: string;
}

export class MockDatabase {
  public users = new Map<string, MockUserRow>();
  public sessions = new Map<string, MockSessionRow>();
  public legalProvisions = new Map<string, MockProvisionRow>();
  public legalCases = new Map<string, MockCaseRow>();
  public statuteConcordance = new Map<string, MockConcordanceRow>();
  public genericTables = new Map<string, Map<string, any>>();

  constructor() {
    this.seedDefaultConcordance();
  }

  public clear(): void {
    this.users.clear();
    this.sessions.clear();
    this.legalProvisions.clear();
    this.legalCases.clear();
    this.statuteConcordance.clear();
    this.genericTables.clear();
    this.seedDefaultConcordance();
  }

  public seedDefaultConcordance(): void {
    const defaultMappings: Array<{
      old_act: string;
      old_section: string;
      new_act: string;
      new_section: string;
      subject: string;
      notes?: string;
    }> = [
      { old_act: "CRPC_1973", old_section: "482", new_act: "BNSS_2023", new_section: "528", subject: "Inherent powers / Quashing FIR" },
      { old_act: "CRPC_1973", old_section: "438", new_act: "BNSS_2023", new_section: "482", subject: "Anticipatory Bail" },
      { old_act: "CRPC_1973", old_section: "439", new_act: "BNSS_2023", new_section: "483", subject: "Regular Bail" },
      { old_act: "CRPC_1973", old_section: "437", new_act: "BNSS_2023", new_section: "480", subject: "Magisterial Bail" },
      { old_act: "CRPC_1973", old_section: "41A", new_act: "BNSS_2023", new_section: "35", subject: "Notice of appearance before police" },
      { old_act: "CRPC_1973", old_section: "167", new_act: "BNSS_2023", new_section: "187", subject: "Remand and default bail" },
      { old_act: "CRPC_1973", old_section: "173", new_act: "BNSS_2023", new_section: "193", subject: "Police report / Chargesheet" },
      { old_act: "CRPC_1973", old_section: "154", new_act: "BNSS_2023", new_section: "173", subject: "Information in cognizable cases / FIR" },
      { old_act: "CRPC_1973", old_section: "91", new_act: "BNSS_2023", new_section: "94", subject: "Summons to produce document" },
      { old_act: "IPC_1860", old_section: "302", new_act: "BNS_2023", new_section: "103", subject: "Punishment for murder" },
      { old_act: "IPC_1860", old_section: "304", new_act: "BNS_2023", new_section: "105", subject: "Culpable homicide not amounting to murder" },
      { old_act: "IPC_1860", old_section: "307", new_act: "BNS_2023", new_section: "109", subject: "Attempt to murder" },
      { old_act: "IPC_1860", old_section: "378", new_act: "BNS_2023", new_section: "303", subject: "Theft" },
      { old_act: "IPC_1860", old_section: "405", new_act: "BNS_2023", new_section: "316", subject: "Criminal breach of trust" },
      { old_act: "IPC_1860", old_section: "406", new_act: "BNS_2023", new_section: "316", subject: "Punishment for criminal breach of trust" },
      { old_act: "IPC_1860", old_section: "420", new_act: "BNS_2023", new_section: "318", subject: "Cheating and dishonestly inducing delivery of property" },
      { old_act: "IPC_1860", old_section: "120B", new_act: "BNS_2023", new_section: "61", subject: "Criminal conspiracy" },
      { old_act: "IPC_1860", old_section: "34", new_act: "BNS_2023", new_section: "3(5)", subject: "Common intention" },
      { old_act: "IPC_1860", old_section: "124A", new_act: "BNS_2023", new_section: "152", subject: "Sedition / Sovereignty of India" },
      { old_act: "IEA_1872", old_section: "65B", new_act: "BSA_2023", new_section: "63", subject: "Admissibility of electronic records certificate" },
    ];

    for (const m of defaultMappings) {
      const id = `${m.old_act.toLowerCase()}-${m.old_section.toLowerCase()}-to-${m.new_act.toLowerCase()}-${m.new_section.toLowerCase()}`;
      this.statuteConcordance.set(id, {
        id,
        ...m,
      });
    }
  }

  public getTable(name: string): Map<string, any> {
    let t = this.genericTables.get(name);
    if (!t) {
      t = new Map();
      this.genericTables.set(name, t);
    }
    return t;
  }
}

export function createMockSql(dbInstance?: MockDatabase): postgres.Sql {
  const db = dbInstance || new MockDatabase();

  function evaluateFtsRank(provision: MockProvisionRow, terms: string[]): number {
    let score = 0;
    const titleLower = (provision.title || "").toLowerCase();
    const sectionLower = (provision.section || "").toLowerCase();
    const actLower = (provision.act || "").toLowerCase();
    const textLower = (provision.text || "").toLowerCase();
    const ratioLower = (provision.ratio || "").toLowerCase();

    for (const term of terms) {
      const t = term.toLowerCase().trim();
      if (!t) continue;
      // Weight A: Title
      if (titleLower.includes(t)) score += 1.0;
      // Weight B: Section & Act
      if (sectionLower.includes(t) || actLower.includes(t)) score += 0.7;
      // Weight C: Text & Ratio
      if (textLower.includes(t)) score += 0.3;
      if (ratioLower.includes(t)) score += 0.4;
    }
    return score;
  }

  async function executeQuery(queryText: string, params: any[]): Promise<any[]> {
    const trimmed = queryText.trim();
    const upper = trimmed.toUpperCase();

    // Advisory lock
    if (upper.includes("PG_ADVISORY_XACT_LOCK") || upper.includes("PG_ADVISORY_LOCK")) {
      return [{ pg_advisory_xact_lock: null }];
    }

    // Schema inspection
    if (upper.includes("PG_GET_EXPR")) {
      return [{ expr: "to_tsvector('english', coalesce(title, ''))" }];
    }
    if (upper.includes("INFORMATION_SCHEMA.TABLES")) {
      return [{ "?column?": 1 }];
    }
    if (upper.includes("INFORMATION_SCHEMA.COLUMNS")) {
      return [
        { column_name: "id" },
        { column_name: "act" },
        { column_name: "section" },
        { column_name: "title" },
        { column_name: "text" },
        { column_name: "tsv" },
      ];
    }

    // DDL
    if (
      upper.startsWith("CREATE TABLE") ||
      upper.startsWith("CREATE INDEX") ||
      upper.startsWith("ALTER TABLE") ||
      upper.startsWith("DROP ")
    ) {
      return [];
    }

    // USERS: SELECT by email
    if (upper.includes("FROM USERS") && upper.includes("LOWER(EMAIL)")) {
      const emailParam = (params[0] ?? "").toString().trim().toLowerCase();
      for (const u of db.users.values()) {
        if (u.email.toLowerCase() === emailParam) {
          return [u];
        }
      }
      return [];
    }

    // USERS: INSERT
    if (upper.startsWith("INSERT INTO USERS")) {
      const id = params[0] || crypto.randomUUID();
      const name = params[1] || "";
      const email = (params[2] || "").toString().toLowerCase().trim();
      const password_hash = params[3] || "";
      const role = (params[4] || "user") as "admin" | "user";
      const now = new Date();

      const user: MockUserRow = {
        id,
        name,
        email,
        password_hash,
        role,
        created_at: now,
        updated_at: now,
      };
      db.users.set(id, user);
      return [user];
    }

    // USERS: UPDATE role
    if (upper.startsWith("UPDATE USERS SET ROLE")) {
      const role = params[0];
      const id = params[1];
      const user = db.users.get(id);
      if (user) {
        user.role = role;
        user.updated_at = new Date();
      }
      return user ? [user] : [];
    }

    // SESSIONS: INSERT
    if (upper.startsWith("INSERT INTO SESSIONS")) {
      const id = params[0] || crypto.randomUUID();
      const user_id = params[1];
      const expires_at = params[2] instanceof Date ? params[2] : new Date(params[2] || Date.now() + 86400000);
      const session: MockSessionRow = {
        id,
        user_id,
        expires_at,
        created_at: new Date(),
      };
      db.sessions.set(id, session);
      return [session];
    }

    // SESSIONS: JOIN with USERS
    if (upper.includes("FROM USERS U") && upper.includes("INNER JOIN SESSIONS S")) {
      const sessionId = params[0];
      const userId = params[1];
      const session = db.sessions.get(sessionId);
      if (session && session.user_id === userId) {
        if (session.expires_at.getTime() > Date.now()) {
          const user = db.users.get(userId);
          if (user) {
            return [
              {
                id: user.id,
                name: user.name,
                email: user.email,
                password_hash: user.password_hash,
                role: user.role,
                created_at: user.created_at,
                updated_at: user.updated_at,
                session_id: session.id,
                session_expires_at: session.expires_at,
                session_created_at: session.created_at,
              },
            ];
          }
        }
      }
      return [];
    }

    // SESSIONS: DELETE
    if (upper.startsWith("DELETE FROM SESSIONS")) {
      const sessionId = params[0];
      db.sessions.delete(sessionId);
      return [];
    }

    // LEGAL PROVISIONS: TSV SEARCH (FTS)
    if (upper.includes("FROM LEGAL_PROVISIONS") && upper.includes("TSV @@")) {
      const termsStr = (params[0] ?? "").toString();
      const limit = Number(params[1]) || 5;
      const terms = termsStr.split(/\s*\|\s*|\s+/).filter(Boolean);

      const scored: Array<MockProvisionRow & { rank: number }> = [];
      for (const p of db.legalProvisions.values()) {
        const rank = evaluateFtsRank(p, terms);
        if (rank > 0) {
          scored.push({ ...p, rank });
        }
      }
      scored.sort((a, b) => b.rank - a.rank || a.section.localeCompare(b.section));
      return scored.slice(0, limit);
    }

    // LEGAL PROVISIONS: COUNT / GROUP BY
    if (upper.includes("FROM LEGAL_PROVISIONS") && upper.includes("GROUP BY ACT")) {
      const groups = new Map<string, { act: string; year: number; source: string; sections: number; indexed: number; built_in: boolean }>();
      for (const p of db.legalProvisions.values()) {
        const act = p.act;
        let g = groups.get(act);
        if (!g) {
          g = { act, year: p.year || 0, source: p.source || "", sections: 0, indexed: 0, built_in: true };
          groups.set(act, g);
        }
        g.sections++;
        if (p.year && p.year > g.year) g.year = p.year;
        if (p.source) g.source = p.source;
        if (p.indexed_at) g.indexed++;
        if (!p.id.startsWith("builtin-")) g.built_in = false;
      }
      return Array.from(groups.values()).sort((a, b) => a.act.localeCompare(b.act));
    }

    if (upper.includes("SELECT COUNT(*)") && upper.includes("FROM LEGAL_PROVISIONS")) {
      const distinctActs = new Set<string>();
      let indexed = 0;
      for (const p of db.legalProvisions.values()) {
        distinctActs.add(p.act);
        if (p.indexed_at) indexed++;
      }
      return [{ provisions: db.legalProvisions.size, acts: distinctActs.size, indexed }];
    }

    // LEGAL PROVISIONS: BULK INSERT / SINGLE INSERT
    if (upper.includes("INSERT INTO LEGAL_PROVISIONS")) {
      // Check if helper batch was supplied
      const batchHelper = params.find((p) => p && p._isSqlHelper && p.type === "batch");
      if (batchHelper && Array.isArray(batchHelper.data)) {
        for (const item of batchHelper.data) {
          const actCode = item.act_code || (item.act ? item.act.split(/[\s,]+/)[0].toUpperCase() : undefined);
          const secNum = item.section_num || (item.section ? item.section.replace(/^Section\s+/i, "") : undefined);
          db.legalProvisions.set(item.id, {
            ...item,
            act_code: actCode,
            section_num: secNum,
            created_at: item.created_at || Date.now(),
          });
        }
        return batchHelper.data.map((d: any) => ({ id: d.id }));
      }

      // Check single insert
      if (params.length >= 4) {
        const id = params[0];
        const act = params[1];
        const section = params[2];
        const title = params[3];
        const text = params[4];
        const ratio = params[5] ?? null;
        const source = params[6] ?? null;
        const year = params[7] ? Number(params[7]) : null;
        const category = params[8] ?? null;
        const created_at = params[9] ? Number(params[9]) : Date.now();

        const actCode = act ? act.split(/[\s,]+/)[0].toUpperCase() : undefined;
        const secNum = section ? section.replace(/^Section\s+/i, "") : undefined;

        db.legalProvisions.set(id, {
          id,
          act,
          act_code: actCode,
          section,
          section_num: secNum,
          title,
          text,
          ratio,
          source,
          year,
          category,
          created_at,
        });
        return [{ id }];
      }
      return [];
    }

    // LEGAL PROVISIONS: DELETE by id IN
    if (upper.startsWith("DELETE FROM LEGAL_PROVISIONS WHERE ID IN")) {
      const helper = params.find((p) => p && p._isSqlHelper && p.type === "in");
      const ids: string[] = helper ? helper.data : Array.isArray(params[0]) ? params[0] : [params[0]];
      const deleted: Array<{ id: string }> = [];
      for (const id of ids) {
        if (db.legalProvisions.has(id)) {
          db.legalProvisions.delete(id);
          deleted.push({ id });
        }
      }
      return deleted;
    }

    // LEGAL PROVISIONS: UPDATE indexed_at
    if (upper.startsWith("UPDATE LEGAL_PROVISIONS SET INDEXED_AT")) {
      const indexedAt = Number(params[0]) || Date.now();
      const helper = params.find((p) => p && p._isSqlHelper && p.type === "in");
      const ids: string[] = helper ? helper.data : Array.isArray(params[1]) ? params[1] : [];
      for (const id of ids) {
        const p = db.legalProvisions.get(id);
        if (p) p.indexed_at = indexedAt;
      }
      return [];
    }

    // LEGAL PROVISIONS: SELECT BY ID OR ACT/SECTION
    if (
      upper.includes("FROM LEGAL_PROVISIONS") &&
      !upper.includes("TSV @@") &&
      !upper.includes("GROUP BY") &&
      !upper.includes("COUNT(*)")
    ) {
      if (params.length > 0) {
        let actTerm = "";
        let secTerm = "";
        for (const p of params) {
          const s = (p ?? "").toString().replace(/%/g, "").trim().toLowerCase();
          if (/\d/.test(s) || s.startsWith("o") || s.includes("rule") || s.includes("section")) {
            secTerm = s;
          } else if (s.length > 0 && !actTerm) {
            actTerm = s;
          }
        }
        if (!secTerm && params.length >= 2) {
          actTerm = (params[0] ?? "").toString().replace(/%/g, "").trim().toLowerCase();
          secTerm = (params[params.length - 1] ?? "").toString().replace(/%/g, "").trim().toLowerCase();
        } else if (!actTerm && params.length === 1) {
          secTerm = (params[0] ?? "").toString().replace(/%/g, "").trim().toLowerCase();
        }

        for (const p of db.legalProvisions.values()) {
          const actCode = (p.act_code || p.act || "").toLowerCase();
          const secNum = (p.section_num || p.section || "").toLowerCase();
          const pId = p.id.toLowerCase();
          const matchesAct =
            !actTerm ||
            actCode.includes(actTerm) ||
            actTerm.includes(actCode.split("_")[0]) ||
            p.act.toLowerCase().includes(actTerm) ||
            pId.includes(actTerm);
          const matchesSec =
            !secTerm ||
            secNum === secTerm ||
            secNum.includes(secTerm) ||
            p.section.toLowerCase().includes(secTerm) ||
            pId.includes(secTerm);
          if (matchesAct && matchesSec) {
            return [p];
          }
        }
        return [];
      }
      return Array.from(db.legalProvisions.values());
    }

    // LEGAL CASES: SELECT or INSERT
    if (upper.includes("FROM LEGAL_CASES")) {
      if (params.length > 0) {
        const q = (params[0] ?? "").toString().trim().toLowerCase();
        for (const c of db.legalCases.values()) {
          if (
            c.id.toLowerCase() === q ||
            (c.neutral_citation && c.neutral_citation.toLowerCase() === q) ||
            c.primary_citation.toLowerCase() === q ||
            (c.equivalent_citations && c.equivalent_citations.some((eq) => eq.toLowerCase() === q))
          ) {
            return [c];
          }
        }
      }
      return Array.from(db.legalCases.values());
    }

    if (upper.includes("INSERT INTO LEGAL_CASES")) {
      if (params.length >= 3) {
        const id = params[0];
        const case_title = params[1];
        const primary_citation = params[2];
        const c: MockCaseRow = {
          id,
          case_title,
          primary_citation,
          neutral_citation: params[3],
          court: params[4] || "Supreme Court of India",
          year: Number(params[5]) || 2020,
          ratio: params[6] || "",
          category: params[7] || "landmark",
          created_at: Date.now(),
        };
        db.legalCases.set(id, c);
        return [c];
      }
    }

    // STATUTE CONCORDANCE: SELECT
    if (upper.includes("FROM STATUTE_CONCORDANCE")) {
      if (params.length >= 2) {
        const actParam = (params[0] ?? "").toString().trim().toUpperCase();
        const secParam = (params[1] ?? "").toString().trim().toUpperCase();

        for (const conc of db.statuteConcordance.values()) {
          if (
            (conc.old_act.toUpperCase() === actParam && conc.old_section.toUpperCase() === secParam) ||
            (conc.new_act.toUpperCase() === actParam && conc.new_section.toUpperCase() === secParam)
          ) {
            return [conc];
          }
        }
      }
      return Array.from(db.statuteConcordance.values());
    }

    // Generic fallback for any other table
    return [];
  }

  // Tagged template & helper callable
  const mockSql: any = function (first: any, ...rest: any[]): any {
    // Case 1: Called as sql(batch, ...columns) or sql(array)
    if (Array.isArray(first) && !("raw" in first)) {
      if (rest.length > 0) {
        // Bulk insert helper: sql(batch, ...columns)
        return {
          _isSqlHelper: true,
          type: "batch",
          data: first,
          columns: rest,
        };
      } else {
        // IN clause helper: sql(array)
        return {
          _isSqlHelper: true,
          type: "in",
          data: first,
        };
      }
    }

    // Case 2: Tagged template call sql`...`
    if (first && "raw" in first) {
      const strings = first as TemplateStringsArray;
      const queryParts: string[] = [];
      const extractedParams: any[] = [];

      for (let i = 0; i < strings.length; i++) {
        queryParts.push(strings[i]);
        if (i < rest.length) {
          const val = rest[i];
          if (val && val._isSqlHelper) {
            // Helper object interpolated
            extractedParams.push(val);
          } else {
            extractedParams.push(val);
          }
        }
      }

      const fullQuery = queryParts.join(" $? ");
      return executeQuery(fullQuery, extractedParams);
    }

    return Promise.resolve([]);
  };

  mockSql.unsafe = function (queryText: string, params: any[] = []): Promise<any[]> {
    return executeQuery(queryText, params);
  };

  const cloneMap = <K, V>(map: Map<K, V>): Map<K, V> =>
    new Map(
      Array.from(map.entries()).map(([k, v]) => [
        k,
        typeof v === "object" && v !== null ? { ...v } : v,
      ]),
    );

  mockSql.begin = async function <T>(callback: (tx: any) => Promise<T>): Promise<T> {
    const usersSnapshot = cloneMap(db.users);
    const sessionsSnapshot = cloneMap(db.sessions);
    const provisionsSnapshot = cloneMap(db.legalProvisions);
    const casesSnapshot = cloneMap(db.legalCases);
    const concordanceSnapshot = cloneMap(db.statuteConcordance);
    try {
      return await callback(mockSql);
    } catch (err) {
      // Revert in-place object mutations on existing objects to protect any retained references
      const revertInPlace = (current: Map<any, any>, snapshot: Map<any, any>) => {
        for (const [k, snapVal] of snapshot.entries()) {
          const curVal = current.get(k);
          if (curVal && typeof curVal === "object") {
            for (const prop of Object.keys(curVal)) {
              if (!(prop in snapVal)) {
                delete (curVal as any)[prop];
              }
            }
            Object.assign(curVal, snapVal);
          }
        }
      };
      revertInPlace(db.users, usersSnapshot);
      revertInPlace(db.sessions, sessionsSnapshot);
      revertInPlace(db.legalProvisions, provisionsSnapshot);
      revertInPlace(db.legalCases, casesSnapshot);
      revertInPlace(db.statuteConcordance, concordanceSnapshot);

      db.users = cloneMap(usersSnapshot);
      db.sessions = cloneMap(sessionsSnapshot);
      db.legalProvisions = cloneMap(provisionsSnapshot);
      db.legalCases = cloneMap(casesSnapshot);
      db.statuteConcordance = cloneMap(concordanceSnapshot);
      throw err;
    }
  };

  mockSql.json = function (val: any) {
    return JSON.stringify(val);
  };

  mockSql.end = async function (): Promise<void> {
    // No-op for in-memory mock
  };

  // Attach database instance for inspection
  mockSql._db = db;

  return mockSql as unknown as postgres.Sql;
}

let activeMockDb: MockDatabase | null = null;
let activeMockSqlInstance: postgres.Sql | null = null;

export function getMockDatabase(): MockDatabase {
  if (!activeMockDb) {
    activeMockDb = new MockDatabase();
  }
  return activeMockDb;
}

export function getActiveMockSql(): postgres.Sql {
  if (!activeMockSqlInstance) {
    activeMockSqlInstance = createMockSql(getMockDatabase());
  }
  return activeMockSqlInstance;
}

export function resetMockDb(): void {
  if (activeMockDb) {
    activeMockDb.clear();
  }
}
