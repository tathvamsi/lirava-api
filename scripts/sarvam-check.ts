/**
 * Asks the default model (Sarvam when DEFAULT_LLM_PROVIDER=sarvam) five legal questions with known answers, then runs each
 * answer through the real citation checker. Prints the answer, what the checker said, and the fact a lawyer should look for.
 * It reads the library only; it writes nothing.
 *
 * Usage:  node --import tsx scripts/sarvam-check.ts
 */
import "dotenv/config";
import { defaultProvider } from "../src/services/agent/providers.js";
import { PgLibraryStore } from "../src/services/library/pg-store.js";
import { verifyAnswer } from "../src/services/library/verify.js";

const QUESTIONS: Array<{ q: string; expect: string }> = [
  { q: "Which section of the BNSS deals with anticipatory bail, and which CrPC section did it replace?", expect: "BNSS 482, replacing CrPC 438" },
  { q: "What is the punishment for murder under the Bharatiya Nyaya Sanhita, and which IPC section was it?", expect: "BNS 103 (death or life imprisonment, and fine), replacing IPC 302" },
  { q: "For a cheque bounce under Section 138 of the Negotiable Instruments Act, what are the time limits for the notice, for payment, and for filing the complaint?", expect: "Notice within 30 days of dishonour information; 15 days to pay; complaint within 1 month after that period ends (s.142)" },
  { q: "What did the Supreme Court direct in Arnesh Kumar v. State of Bihar about arrest?", expect: "(2014) 8 SCC 273: no automatic arrest for offences up to 7 years; police must give reasons using the s.41 CrPC checklist; notice of appearance under s.41A" },
  { q: "What is the limitation period for filing a suit to recover money lent, and under which law?", expect: "3 years, Limitation Act 1963, Schedule Article 19 (money lent), running from when the loan is made" },
];

const provider = defaultProvider();
console.log(`Model: ${provider.label} (${provider.model})\n`);
const store = new PgLibraryStore();

for (const [i, { q, expect }] of QUESTIONS.entries()) {
  const started = Date.now();
  const res = await fetch(`${provider.baseURL}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${provider.apiKey}`, ...provider.headers },
    body: JSON.stringify({
      model: provider.model,
      max_tokens: provider.answerMax,
      ...provider.body,
      messages: [
        { role: "system", content: "You are a careful legal research assistant for Indian lawyers. Answer concisely. Cite only sections and cases you are certain of." },
        { role: "user", content: q },
      ],
    }),
  });
  const json: any = await res.json().catch(() => ({}));
  const answer: string = json?.choices?.[0]?.message?.content ?? `(no answer: HTTP ${res.status} ${JSON.stringify(json).slice(0, 200)})`;
  const { verdicts } = await verifyAnswer(answer, store);
  console.log(`=== Q${i + 1}: ${q}\n(${((Date.now() - started) / 1000).toFixed(1)}s)\nEXPECT: ${expect}\nANSWER:\n${answer.trim()}\nCITATION CHECK: ${verdicts.length ? verdicts.map((v) => `${v.raw} -> ${v.status} (${v.reason})`).join("; ") : "no citations found"}\n`);
}
process.exit(0);
