/**
 * Runs the hypothetical cases in scripts/sim/scenarios.ts through the platform exactly as a lawyer would:
 * a matter, uploaded documents, a case-file build, then each question put to the real assistant (the model the app is configured for).
 * Every citation in every answer is then checked against the library, and the answer is saved in full for a person to read.
 *
 *   node --import tsx scripts/sim/run-scenarios.ts [--only=S1,S3] [--no-casefile] [--out=data/sim]
 *
 * It writes real rows (one throwaway user, matters, chats, messages) to the database named by DATABASE_URL, like the test suite does.
 * The user's email is printed; the rows can be removed by deleting that user's data.
 * Each answer can take minutes: the model runs on the project's own server.
 */
process.env.NODE_ENV = "test"; // import the app without opening a port

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SCENARIOS, type Scenario, type Step } from "./scenarios.js";

const args = process.argv.slice(2);
const only = args.find((a) => a.startsWith("--only="))?.slice(7).split(",") ?? null;
const skipCaseFile = args.includes("--no-casefile");
const outDir = args.find((a) => a.startsWith("--out="))?.slice(6) ?? "data/sim";
mkdirSync(outDir, { recursive: true });

const { default: app } = await import("../../src/index.js");
const { registerUser } = await import("../../src/services/auth/index.js");
const { createMatter } = await import("../../src/services/repo/index.js");
const { createConversation } = await import("../../src/services/chats/store.js");
const { linkDocuments } = await import("../../src/services/documents/index.js");
const { advanceCaseFile } = await import("../../src/services/casefile/index.js");
const { sendMessage } = await import("../../src/services/agent/runtime.js");
const { verifyAnswer } = await import("../../src/services/library/verify.js");
const { PgLibraryStore } = await import("../../src/services/library/pg-store.js");
const { getSql } = await import("../../src/services/db/postgres.js");

const store = new PgLibraryStore();
const sql = getSql()!;

/** A network name-lookup failure is a short outage, not a result: wait and try again. */
async function patient<T>(label: string, fn: () => Promise<T>, tries = 5): Promise<T> {
  let last: unknown;
  for (let i = 1; i <= tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      const msg = String((e as Error)?.message ?? e);
      if (!/EAI_AGAIN|ENOTFOUND|getaddrinfo|ECONNRESET|fetch failed|timed out/i.test(msg) || i === tries) break;
      console.log(`  (${label}: ${msg.slice(0, 80)}; waiting ${20 * i}s)`);
      await new Promise((r) => setTimeout(r, 20000 * i));
    }
  }
  throw last;
}

// ---- resolve each scenario's past cases from the library (never typed) ----
type Resolved = { name: string; use: string; ids: string[]; citations: string[] };
async function resolveRefs(s: Scenario): Promise<Record<string, Resolved>> {
  const out: Record<string, Resolved> = {};
  for (const [name, r] of Object.entries(s.references)) {
    const rows = await patient("refs", async () => sql<Array<{ id: string; title: string; neutral_citation: string | null; scr_citation: string | null }>>`
      SELECT id, title, neutral_citation, scr_citation FROM library_judgments WHERE title ILIKE ${"%" + r.titleLike + "%"} AND year = ${r.year}`);
    if (!rows.length) throw new Error(`reference "${name}" (${r.titleLike}, ${r.year}) is not in the library`);
    out[name] = { name, use: r.use, ids: rows.map((x) => x.id), citations: rows.map((x) => [x.neutral_citation, x.scr_citation].filter(Boolean).join(" ; ")) };
  }
  return out;
}

const scriptCount = (text: string, script: "kannada" | "devanagari") => (text.match(script === "kannada" ? /[ಀ-೿]/g : /[ऀ-ॿ]/g) ?? []).length;

interface StepResult {
  id: string;
  ask: string;
  seconds: number;
  answer: string;
  error?: string;
  checks: Array<{ label: string; ok: boolean }>;
  citations: Array<{ raw: string; status: string; reason: string; title?: string; warning?: string }>;
  refHits: Record<string, boolean>;
  languageQuestionAsked: boolean;
  scriptLetters?: number;
}

async function runStep(step: Step, userId: string, conversationId: string, refs: Record<string, Resolved>): Promise<StepResult> {
  const t0 = Date.now();
  let answer = "";
  let error: string | undefined;
  try {
    const r = await patient(step.id, () => sendMessage("soli_master", step.ask, userId, conversationId, undefined, undefined, { background: false }));
    answer = r.assistantMessage?.text ?? "";
  } catch (e) {
    error = String((e as Error)?.message ?? e);
  }
  const seconds = Math.round((Date.now() - t0) / 1000);
  const verdicts = answer ? (await patient("verify", () => verifyAnswer(answer, store))).verdicts : [];
  const checks = step.checks.map((c) => {
    const must = c.must ? new RegExp(c.must, "i").test(answer) : true;
    const mustNot = c.mustNot ? !new RegExp(c.mustNot, "i").test(answer) : true;
    return { label: c.label, ok: must && mustNot };
  });
  const refHits: Record<string, boolean> = {};
  for (const name of step.expectRefs ?? []) refHits[name] = verdicts.some((v) => v.status === "verified" && v.library_id && refs[name].ids.includes(v.library_id));
  const asked = /which language|in which language/i.test(answer);
  if (step.expectLanguageQuestion) checks.push({ label: "asks the language before drafting", ok: asked });
  const letters = step.expectScript ? scriptCount(answer, step.expectScript) : undefined;
  if (step.expectScript) {
    checks.push({ label: `writes in ${step.expectScript} (at least 100 letters)`, ok: (letters ?? 0) >= 100 });
    checks.push({ label: "does not stop to ask the language", ok: !asked });
  }
  return {
    id: step.id,
    ask: step.ask,
    seconds,
    answer,
    error,
    checks,
    citations: verdicts.map((v) => ({ raw: v.raw, status: v.status, reason: v.reason, title: v.library_title, warning: v.warning })),
    refHits,
    languageQuestionAsked: asked,
    scriptLetters: letters,
  };
}

async function runScenario(s: Scenario, userId: string) {
  console.log(`\n=== ${s.id}: ${s.title}`);
  const refs = await resolveRefs(s);
  for (const r of Object.values(refs)) console.log(`  reference: ${r.name} -> ${r.citations.join(" | ")}`);

  const matter = await patient("matter", () => createMatter({ userId, title: s.matter.title, client: s.matter.client, court: s.matter.court, nextDate: s.matter.nextDate, notes: s.matter.notes }));
  const conversationId = `conv_sim_${s.id}_${Date.now()}`;
  const chat = await patient("chat", () => createConversation("soli_master", s.title.slice(0, 60), userId, conversationId, matter.id));

  const fileIds: string[] = [];
  for (const d of s.documents) {
    const form = new FormData();
    form.append("file", new File([d.text], d.name, { type: "text/plain" }));
    const res = await app.request("/api/vakils/soli_master/files", { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form });
    if (res.status !== 200) throw new Error(`upload of ${d.name} failed with ${res.status}`);
    fileIds.push((await res.json()).files[0].id as string);
  }
  await patient("link", () => linkDocuments(userId, fileIds, chat.id, matter.id));

  let caseFile: unknown = null;
  let caseFileScore: unknown = null;
  if (!skipCaseFile) {
    const t0 = Date.now();
    try {
      let view = await patient("casefile", () => advanceCaseFile(userId, matter.id));
      for (let i = 0; i < 30 && view.status === "building"; i++) view = await patient("casefile", () => advanceCaseFile(userId, matter.id));
      const content = view.content;
      const names = (content?.parties ?? []).map((p: { name: string }) => p.name);
      const dates = (content?.chronology ?? []).map((e: { date: string }) => e.date);
      const found = (want: string) => names.some((n: string) => n.toLowerCase().includes(want.toLowerCase()) || want.toLowerCase().includes(n.toLowerCase()));
      caseFileScore = {
        seconds: Math.round((Date.now() - t0) / 1000),
        status: view.status,
        partiesFound: s.truth.parties.filter(found),
        partiesMissed: s.truth.parties.filter((p) => !found(p)),
        partiesExtra: names.filter((n: string) => !s.truth.parties.some((p) => p.toLowerCase().includes(n.toLowerCase()) || n.toLowerCase().includes(p.toLowerCase()))),
        datesFound: s.truth.dates.filter((d) => dates.includes(d)),
        datesMissed: s.truth.dates.filter((d) => !dates.includes(d)),
        datesExtra: dates.filter((d: string) => !s.truth.dates.includes(d)),
        dropped: content?.stats?.dropped,
      };
      caseFile = content;
      console.log(`  case file: ${view.status} in ${(caseFileScore as { seconds: number }).seconds}s; parties ${(caseFileScore as { partiesFound: string[] }).partiesFound.length}/${s.truth.parties.length}, dates ${(caseFileScore as { datesFound: string[] }).datesFound.length}/${s.truth.dates.length}`);
    } catch (e) {
      caseFileScore = { error: String((e as Error)?.message ?? e) };
      console.log(`  case file failed: ${(caseFileScore as { error: string }).error.slice(0, 120)}`);
    }
  }

  const results: StepResult[] = [];
  for (const step of s.steps) {
    const r = await runStep(step, userId, conversationId, refs);
    results.push(r);
    const failed = r.checks.filter((c) => !c.ok).map((c) => c.label);
    const cites = r.citations.reduce((acc, c) => ({ ...acc, [c.status === "verified" ? "verified" : c.reason === "not_covered" ? "not_covered" : "other"]: (acc[c.status === "verified" ? "verified" : c.reason === "not_covered" ? "not_covered" : "other"] ?? 0) + 1 }), {} as Record<string, number>);
    console.log(`  ${step.id} ${r.error ? "ERROR " + r.error.slice(0, 80) : `${r.seconds}s`} | checks ${r.checks.length - failed.length}/${r.checks.length}${failed.length ? " FAILED: " + failed.join("; ") : ""} | citations ${JSON.stringify(cites)}${Object.keys(r.refHits).length ? " | refs " + JSON.stringify(r.refHits) : ""}`);
    writeFileSync(join(outDir, `${s.id}.json`), JSON.stringify({ scenario: s.id, title: s.title, matterId: matter.id, conversationId, references: refs, caseFileScore, caseFile, steps: results }, null, 1));
  }
  return { scenario: s, matterId: matter.id, refs, caseFileScore, results };
}

const email = `sim_${Date.now()}@example.com`;
const reg = await patient("register", () => registerUser({ name: "Simulation user", email, password: "Password123!Secure" }));
const token = reg.token;
console.log(`Throwaway user for this run: ${email}`);

const all = [];
for (const s of SCENARIOS) {
  if (only && !only.includes(s.id)) continue;
  try {
    all.push(await runScenario(s, reg.user.id));
  } catch (e) {
    console.log(`  ${s.id} stopped: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
  }
}
writeFileSync(join(outDir, "summary.json"), JSON.stringify({ user: email, ranAt: new Date().toISOString(), scenarios: all.map((a) => ({ id: a.scenario.id, matterId: a.matterId, caseFileScore: a.caseFileScore, steps: a.results.map((r) => ({ id: r.id, seconds: r.seconds, error: r.error, failed: r.checks.filter((c) => !c.ok).map((c) => c.label), refHits: r.refHits, citations: r.citations.length })) })) }, null, 1));
console.log(`\nDone. Transcripts are in ${outDir}/ (one file per case).`);
process.exit(0);
