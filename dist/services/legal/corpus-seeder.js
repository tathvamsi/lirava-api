import crypto from "node:crypto";
import { getQdrant, upsertLegalChunks, ensureLegalCorpusCollection } from "./qdrant.js";
import { embedBatch } from "./embeddings.js";
import { config } from "../../config.js";
import { getSql } from "../db/postgres.js";
import { ensureLegalProvisionsSchema } from "./provisions.js";
import { ensureLegalCasesSchema, insertLegalCase } from "./cases.js";
import { ensureConcordanceSchema, CANONICAL_CONCORDANCE_DATA } from "./concordance.js";
import { STATUTORY_CORPUS_SEED, PRECEDENT_CORPUS_SEED, } from "./seeds/index.js";
export { STATUTORY_CORPUS_SEED, PRECEDENT_CORPUS_SEED, };
/**
 * Deterministic RFC-4122 v5 UUID generator based on SHA-1 hash of provision/precedent ID.
 */
export function pointId(provisionId) {
    const h = crypto.createHash("sha1").update(`provision:${provisionId}`).digest("hex");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
/**
 * Returns strongly typed statutory provisions across all 8 target Bare Acts.
 */
export function getFoundationalProvisions() {
    return STATUTORY_CORPUS_SEED;
}
/**
 * Returns strongly typed landmark Supreme Court judicial precedents.
 */
export function getFoundationalPrecedents() {
    return PRECEDENT_CORPUS_SEED;
}
/**
 * Converts rich statutory provisions and precedents into the backward-compatible
 * LegalSeedDefinition representation consumed by PostgreSQL built-in seeder and legacy callers.
 */
function buildFoundationalCorpus() {
    const statutoryItems = STATUTORY_CORPUS_SEED.map((p) => {
        let cat = "criminal_procedure";
        if (p.category === "penal_code")
            cat = "penal_code";
        else if (p.category === "evidence")
            cat = "evidence";
        else if (p.category === "civil_procedure")
            cat = "civil_procedure";
        else if (p.category === "commercial" || p.category === "contract_law")
            cat = "commercial";
        else if (p.category === "limitation")
            cat = "limitation";
        return {
            id: p.id,
            act: p.act_title,
            section: p.section,
            title: p.title,
            category: cat,
            year: p.year,
            statutoryText: p.text,
            ratio: p.ratio,
            source: p.act_title,
            act_code: p.act_code,
            section_num: p.section_num,
            replaces: p.replaces,
            replaced_by: p.replaced_by,
        };
    });
    const precedentItems = PRECEDENT_CORPUS_SEED.map((prec) => {
        const principlesText = prec.principles.map((pr) => `- ${pr}`).join("\n");
        const sourceStr = prec.neutral_citation
            ? `Judicial Citation: ${prec.primary_citation} / ${prec.neutral_citation}`
            : `Judicial Citation: ${prec.primary_citation}`;
        return {
            id: prec.id,
            act: "Supreme Court of India Precedent",
            section: prec.primary_citation,
            title: `${prec.case_title}, ${prec.primary_citation}`,
            category: "judicial_precedent",
            court: prec.court,
            year: prec.year,
            statutoryText: `${prec.case_title}: ${prec.ratio}\nPrinciples:\n${principlesText}`,
            ratio: prec.ratio,
            source: sourceStr,
            neutral_citation: prec.neutral_citation,
            coram: prec.bench_description,
            principles: prec.principles,
            statutory_citations: prec.statutory_citations,
        };
    });
    return [...statutoryItems, ...precedentItems];
}
export const LEGAL_FOUNDATIONAL_CORPUS = buildFoundationalCorpus();
/**
 * Seeds 132 statutory provisions into PostgreSQL 'legal_provisions'.
 */
export async function seedProvisionsToPostgres(sqlInstance) {
    const sql = sqlInstance || getSql();
    if (!sql)
        return 0;
    await ensureLegalProvisionsSchema();
    const now = Date.now();
    let count = 0;
    for (const p of STATUTORY_CORPUS_SEED) {
        await sql `
      INSERT INTO legal_provisions (
        id, act, act_code, section, section_num, title, text, ratio, source, year, category, created_at
      ) VALUES (
        ${p.id}, ${p.act_title}, ${p.act_code}, ${p.section}, ${p.section_num}, ${p.title},
        ${p.text}, ${p.ratio ?? null}, ${p.act_title}, ${p.year}, ${p.category}, ${now}
      )
      ON CONFLICT (id) DO UPDATE SET
        act = EXCLUDED.act,
        act_code = EXCLUDED.act_code,
        section = EXCLUDED.section,
        section_num = EXCLUDED.section_num,
        title = EXCLUDED.title,
        text = EXCLUDED.text,
        ratio = EXCLUDED.ratio,
        year = EXCLUDED.year,
        category = EXCLUDED.category`;
        count++;
    }
    return count;
}
/**
 * Seeds 9 landmark precedents into PostgreSQL 'legal_cases'.
 */
export async function seedCasesToPostgres(sqlInstance) {
    const sql = sqlInstance || getSql();
    if (!sql)
        return 0;
    await ensureLegalCasesSchema();
    let count = 0;
    for (const prec of PRECEDENT_CORPUS_SEED) {
        await insertLegalCase(prec);
        count++;
    }
    return count;
}
/**
 * Seeds concordance pairs into PostgreSQL 'statute_concordance'.
 */
export async function seedConcordanceToPostgres(sqlInstance) {
    const sql = sqlInstance || getSql();
    if (!sql)
        return 0;
    await ensureConcordanceSchema();
    const now = Date.now();
    let count = 0;
    for (const m of CANONICAL_CONCORDANCE_DATA) {
        const id = `${m.old_act.toLowerCase()}-${m.old_section.toLowerCase()}-to-${m.new_act.toLowerCase()}-${m.new_section.toLowerCase()}`;
        await sql `
      INSERT INTO statute_concordance (
        id, old_act, old_section, new_act, new_section, subject, notes, created_at
      ) VALUES (
        ${id}, ${m.old_act}, ${m.old_section}, ${m.new_act}, ${m.new_section}, ${m.subject}, ${m.notes ?? null}, ${now}
      )
      ON CONFLICT (id) DO UPDATE SET
        subject = EXCLUDED.subject,
        notes = EXCLUDED.notes`;
        count++;
    }
    return count;
}
/**
 * Seeds legal corpus (provisions + precedents) into Qdrant collection 'soli_legal_corpus'.
 */
export async function seedCorpusToQdrant(force = false) {
    const collectionName = config.qdrantCollection || "soli_legal_corpus";
    await ensureLegalCorpusCollection();
    const qdrant = getQdrant();
    let existingCount = 0;
    try {
        const info = await qdrant.getCollection(collectionName);
        existingCount = info.points_count || 0;
    }
    catch {
        existingCount = 0;
    }
    const totalItems = STATUTORY_CORPUS_SEED.length + PRECEDENT_CORPUS_SEED.length;
    if (existingCount >= totalItems && !force) {
        return { count: existingCount, status: "already_seeded" };
    }
    // Build points for statutory provisions
    const provisionTexts = STATUTORY_CORPUS_SEED.map((p) => `${p.act_title} - ${p.section}: ${p.title}\n${p.text}\nRatio: ${p.ratio || ""}`);
    // Build texts for precedents
    const precedentTexts = PRECEDENT_CORPUS_SEED.map((pr) => `${pr.case_title} (${pr.primary_citation})\nRatio: ${pr.ratio}\nPrinciples:\n${pr.principles.join("\n")}`);
    const allTexts = [...provisionTexts, ...precedentTexts];
    const vectors = await embedBatch(allTexts);
    const points = [];
    // Statutory points
    STATUTORY_CORPUS_SEED.forEach((p, index) => {
        const payload = {
            id: p.id,
            entity_type: "provision",
            act_code: p.act_code,
            act_title: p.act_title,
            section: p.section,
            section_num: p.section_num,
            title: p.title,
            text: provisionTexts[index],
            statutoryText: p.text,
            ratio: p.ratio,
            category: p.category,
            year: p.year,
            source: p.act_title,
            replaces: p.replaces,
            replaced_by: p.replaced_by,
            act: p.act_title,
        };
        points.push({
            id: pointId(p.id),
            vector: vectors[index],
            payload,
        });
    });
    // Precedent points
    const provCount = STATUTORY_CORPUS_SEED.length;
    PRECEDENT_CORPUS_SEED.forEach((pr, index) => {
        const vIndex = provCount + index;
        const payload = {
            id: pr.id,
            entity_type: "precedent",
            case_title: pr.case_title,
            primary_citation: pr.primary_citation,
            equivalent_citations: pr.equivalent_citations,
            neutral_citation: pr.neutral_citation,
            court: pr.court,
            year: pr.year,
            bench_description: pr.bench_description,
            ratio: pr.ratio,
            principles: pr.principles,
            statutory_citations: pr.statutory_citations,
            category: pr.category,
            source: pr.neutral_citation
                ? `Judicial Citation: ${pr.primary_citation} / ${pr.neutral_citation}`
                : `Judicial Citation: ${pr.primary_citation}`,
            act: "Supreme Court of India Precedent",
            section: pr.primary_citation,
            title: `${pr.case_title}, ${pr.primary_citation}`,
            text: precedentTexts[index],
            statutoryText: `${pr.case_title}: ${pr.ratio}\nPrinciples:\n${pr.principles.map((x) => `- ${x}`).join("\n")}`,
        };
        points.push({
            id: pointId(pr.id),
            vector: vectors[vIndex],
            payload,
        });
    });
    await upsertLegalChunks(points);
    return { count: points.length, status: "success" };
}
/**
 * Seeds foundational Indian statutory provisions and leading precedents
 * into PostgreSQL and Qdrant with deterministic UUIDs.
 */
export async function seedLegalCorpus(options = false) {
    const opts = typeof options === "boolean" ? { force: options } : options || {};
    let provisionsCount = 0;
    let casesCount = 0;
    let concordanceCount = 0;
    let qdrantPointsCount = 0;
    const errors = [];
    if (!opts.skipPostgres) {
        try {
            provisionsCount = await seedProvisionsToPostgres();
            casesCount = await seedCasesToPostgres();
            concordanceCount = await seedConcordanceToPostgres();
        }
        catch (err) {
            errors.push(`Postgres seeding error: ${err.message}`);
        }
    }
    if (!opts.skipVectors) {
        try {
            const qRes = await seedCorpusToQdrant(opts.force);
            qdrantPointsCount = qRes.count;
        }
        catch (err) {
            errors.push(`Qdrant seeding error: ${err.message}`);
        }
    }
    const status = errors.length === 0
        ? "success"
        : provisionsCount > 0 || qdrantPointsCount > 0
            ? "partial"
            : "error";
    return {
        provisionsCount,
        casesCount,
        concordanceCount,
        qdrantPointsCount,
        status,
        errors: errors.length > 0 ? errors : undefined,
    };
}
