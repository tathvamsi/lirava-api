/**
 * Sends five legal questions with known answers through the REAL chat pipeline (retrieval gate, library search, grounding
 * rules, the default model, citation check) as a throwaway user, and prints each answer with the sources it was grounded in.
 * Compare with scripts/sarvam-check.ts, which asks the bare model with no pipeline.
 *
 * Usage:  node --import tsx scripts/pipeline-check.ts
 */
import "dotenv/config";
import { registerUser } from "../src/services/auth/index.js";
import { sendMessage } from "../src/services/agent/runtime.js";
import { defaultProvider } from "../src/services/agent/providers.js";
import { PgLibraryStore } from "../src/services/library/pg-store.js";
import { verifyAnswer } from "../src/services/library/verify.js";

const VAKIL = "soli_master";
const QUESTIONS: Array<{ q: string; expect: string }> = [
  { q: "Which section of the BNSS deals with anticipatory bail, and which CrPC section did it replace?", expect: "BNSS 482, replacing CrPC 438" },
  { q: "What is the punishment for murder under the Bharatiya Nyaya Sanhita, and which IPC section was it?", expect: "BNS 103 (death or life imprisonment, and fine), replacing IPC 302" },
  { q: "For a cheque bounce under Section 138 of the Negotiable Instruments Act, what are the time limits for the notice, for payment, and for filing the complaint?", expect: "Notice within 30 days of dishonour information; 15 days to pay; complaint within 1 month after that period ends (s.142)" },
  { q: "What did the Supreme Court direct in Arnesh Kumar v. State of Bihar about arrest?", expect: "(2014) 8 SCC 273: no automatic arrest for offences up to 7 years; reasons recorded using the s.41 CrPC checklist; notice of appearance under s.41A" },
  { q: "What is the limitation period for filing a suit to recover money lent, and under which law?", expect: "3 years, Limitation Act 1963, Schedule Article 19 (money lent)" },
];

const email = `pipeline_check_${Date.now()}@example.com`;
const { user } = await registerUser({ name: "Pipeline check", email, password: "Password123!Secure" });
console.log(`Model: ${defaultProvider().label}\n`);
const store = new PgLibraryStore();

for (const [i, { q, expect }] of QUESTIONS.entries()) {
  const started = Date.now();
  const { assistantMessage } = await sendMessage(VAKIL, q, user.id);
  const text = assistantMessage.text;
  const { verdicts } = await verifyAnswer(text, store);
  const cites = (assistantMessage.citations ?? []).map((c: any) => c.title ?? c.name ?? c.label ?? JSON.stringify(c).slice(0, 80));
  console.log(
    `=== Q${i + 1}: ${q}\n(${((Date.now() - started) / 1000).toFixed(1)}s)\nEXPECT: ${expect}\nSOURCES SHOWN: ${cites.length ? cites.join(" | ") : "none"}\nANSWER:\n${text.trim()}\nCITATION CHECK: ${verdicts.length ? verdicts.map((v) => `${v.raw} -> ${v.status} (${v.reason})`).join("; ") : "no citations found"}\n`,
  );
}
process.exit(0);
