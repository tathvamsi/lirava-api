import { getSql } from "../db/postgres.js";
import { withSchemaLock, LEGAL_SCHEMA_LOCK_KEY } from "../db/schema-lock.js";
export const CANONICAL_CONCORDANCE_DATA = [
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
const CONCORDANCE_SCHEMA = `
CREATE TABLE IF NOT EXISTS statute_concordance (
  id          TEXT PRIMARY KEY,
  old_act     TEXT NOT NULL,
  old_section TEXT NOT NULL,
  new_act     TEXT NOT NULL,
  new_section TEXT NOT NULL,
  subject     TEXT NOT NULL,
  notes       TEXT,
  created_at  BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS statute_concordance_old_lookup_idx ON statute_concordance (old_act, old_section);
CREATE INDEX IF NOT EXISTS statute_concordance_new_lookup_idx ON statute_concordance (new_act, new_section);
CREATE UNIQUE INDEX IF NOT EXISTS statute_concordance_pair_idx ON statute_concordance (old_act, old_section, new_act, new_section);
`;
let ready = null;
export async function ensureConcordanceSchema() {
    const sql = getSql();
    if (!sql)
        throw new Error("DATABASE_URL is not configured.");
    if (!ready) {
        ready = withSchemaLock(sql, async (tx) => {
            await tx.unsafe(CONCORDANCE_SCHEMA);
        }, LEGAL_SCHEMA_LOCK_KEY).catch((err) => {
            ready = null;
            throw err;
        });
    }
    await ready;
}
export function normalizeActCode(act) {
    const upper = act.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (upper.includes("CRPC"))
        return { base: "CRPC", normalized: "CRPC_1973", candidates: ["CRPC_1973", "CRPC"] };
    if (upper.includes("BNSS"))
        return { base: "BNSS", normalized: "BNSS_2023", candidates: ["BNSS_2023", "BNSS"] };
    if (upper.includes("IPC"))
        return { base: "IPC", normalized: "IPC_1860", candidates: ["IPC_1860", "IPC"] };
    if (upper.includes("BNS"))
        return { base: "BNS", normalized: "BNS_2023", candidates: ["BNS_2023", "BNS"] };
    if (upper.includes("IEA") || upper.includes("EVIDENCE"))
        return { base: "IEA", normalized: "IEA_1872", candidates: ["IEA_1872", "IEA"] };
    if (upper.includes("BSA"))
        return { base: "BSA", normalized: "BSA_2023", candidates: ["BSA_2023", "BSA"] };
    return { base: upper, normalized: upper, candidates: [upper] };
}
export async function lookupModernConcordance(oldAct, oldSection) {
    await ensureConcordanceSchema();
    const sql = getSql();
    if (!sql)
        return [];
    const { normalized, candidates } = normalizeActCode(oldAct);
    const cleanSec = oldSection.replace(/^Section\s+/i, "").trim().toUpperCase();
    const rows = await sql `
    SELECT id, old_act, old_section, new_act, new_section, subject, notes, created_at
    FROM statute_concordance
    WHERE UPPER(old_act) = ${normalized}
      AND UPPER(old_section) = ${cleanSec}`;
    const matched = rows.filter((r) => (r.old_act.toUpperCase() === normalized || candidates.includes(r.old_act.toUpperCase())) &&
        r.old_section.toUpperCase() === cleanSec);
    if (matched.length > 0)
        return matched;
    for (const c of candidates) {
        if (c === normalized)
            continue;
        const fallbackRows = await sql `
      SELECT id, old_act, old_section, new_act, new_section, subject, notes, created_at
      FROM statute_concordance
      WHERE UPPER(old_act) = ${c}
        AND UPPER(old_section) = ${cleanSec}`;
        const fbMatched = fallbackRows.filter((r) => (r.old_act.toUpperCase() === c || candidates.includes(r.old_act.toUpperCase())) &&
            r.old_section.toUpperCase() === cleanSec);
        if (fbMatched.length > 0)
            return fbMatched;
    }
    return [];
}
export async function lookupColonialConcordance(newAct, newSection) {
    await ensureConcordanceSchema();
    const sql = getSql();
    if (!sql)
        return [];
    const { normalized, candidates } = normalizeActCode(newAct);
    const cleanSec = newSection.replace(/^Section\s+/i, "").trim().toUpperCase();
    const rows = await sql `
    SELECT id, old_act, old_section, new_act, new_section, subject, notes, created_at
    FROM statute_concordance
    WHERE UPPER(new_act) = ${normalized}
      AND UPPER(new_section) = ${cleanSec}`;
    const matched = rows.filter((r) => (r.new_act.toUpperCase() === normalized || candidates.includes(r.new_act.toUpperCase())) &&
        r.new_section.toUpperCase() === cleanSec);
    if (matched.length > 0)
        return matched;
    for (const c of candidates) {
        if (c === normalized)
            continue;
        const fallbackRows = await sql `
      SELECT id, old_act, old_section, new_act, new_section, subject, notes, created_at
      FROM statute_concordance
      WHERE UPPER(new_act) = ${c}
        AND UPPER(new_section) = ${cleanSec}`;
        const fbMatched = fallbackRows.filter((r) => (r.new_act.toUpperCase() === c || candidates.includes(r.new_act.toUpperCase())) &&
            r.new_section.toUpperCase() === cleanSec);
        if (fbMatched.length > 0)
            return fbMatched;
    }
    return [];
}
export async function getAllConcordanceMappings() {
    await ensureConcordanceSchema();
    const sql = getSql();
    if (!sql)
        return [];
    const rows = await sql `
    SELECT id, old_act, old_section, new_act, new_section, subject, notes, created_at
    FROM statute_concordance
    ORDER BY old_act, old_section`;
    return rows;
}
export async function lookupConcordance(act, section) {
    const modern = await lookupModernConcordance(act, section);
    if (modern.length > 0)
        return modern[0];
    const colonial = await lookupColonialConcordance(act, section);
    if (colonial.length > 0)
        return colonial[0];
    return null;
}
