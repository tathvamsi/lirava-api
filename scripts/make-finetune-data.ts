/**
 * Builds a fine-tuning dataset from the statute library (legal_provisions).
 * Teaches behaviour, not new law: answer only from the retrieved sections, cite them, and say so when they don't cover the question.
 *
 *   cd lirava-api && npx tsx scripts/make-finetune-data.ts
 *
 * The question/answer writer ("teacher") is NVIDIA NIM (NVIDIA_API_KEY, NIM_LLM_MODEL from .env).
 * Output: ../finetune/data/{train,val}.jsonl in chat format.
 */
import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { listProvisionRows, type ProvisionRow } from "../src/services/admin/corpus.js";

const BASE = (process.env.NIM_BASE_URL || "https://integrate.api.nvidia.com/v1").replace(/\/+$/, "");
const KEY = process.env.NVIDIA_API_KEY || "";
const MODEL = process.env.NIM_LLM_MODEL || "nvidia/nemotron-3.5-super-vl-120b-a12b";
const PER_SECTION = Number(process.env.PER_SECTION || 10);
const OUT = path.resolve(process.cwd(), "../finetune/data");
if (!KEY) throw new Error("NVIDIA_API_KEY is not set in .env");

export const SYSTEM = [
  "You are Lirava, a legal research assistant for Indian lawyers.",
  "Answer ONLY from the retrieved sections provided. Cite each point as (Act, Section).",
  "If the sections do not cover the question, say so plainly and do not guess.",
  "Be precise and concise. This is research support, not legal advice.",
].join(" ");

const NOT_COVERED = [
  "The retrieved sections do not cover this question, so I can't answer it reliably from them.",
  "I'd need the relevant provision or judgment. Please run a search on the specific Act or section, or share the text, and I'll work from that.",
];

type Pair = { question: string; answer: string };

/** Stored section names already read "Section 193" or "Order VII Rule 11"; only bare numbers need the word added. */
const label = (section: string) => (/^(section|sec\.?|order|rule|article)\b/i.test(section.trim()) ? section.trim() : `Section ${section.trim()}`);
const clean = (text: string) => text.replace(/\b(Section|Order|Rule)\s+\1\b/gi, "$1").trim();

async function teacher(p: ProvisionRow): Promise<Pair[]> {
  const prompt = `You write training data for a legal assistant used by Indian lawyers.
Source provision:
ACT: ${p.act}
SECTION: ${label(p.section)} - ${p.title}
TEXT:
${p.text.slice(0, 5000)}

Write ${PER_SECTION} different question-answer pairs about THIS provision only. Mix these kinds:
- direct questions a lawyer would ask (scope, ingredients, punishment, exceptions)
- short fact scenarios ("My client ... does this apply?")
- plain-language explanations for a client
Rules for every answer: use ONLY the provision text above, never outside knowledge; cite as (${p.act}, ${label(p.section)}); 2-6 sentences; no invented case law or numbers.
Return ONLY a JSON array: [{"question":"...","answer":"..."}]`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${BASE}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
        body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: prompt }], temperature: 0.7, max_tokens: 6000 }),
        signal: AbortSignal.timeout(180_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const content: string = (await res.json()).choices?.[0]?.message?.content ?? "";
      const start = content.indexOf("[");
      const end = content.lastIndexOf("]");
      const arr = JSON.parse(content.slice(start, end + 1)) as Pair[];
      return arr.filter((x) => x?.question && x?.answer && /section|order|rule/i.test(x.answer));
    } catch (e: any) {
      console.warn(`  retry ${attempt + 1} for ${p.act} s.${p.section}: ${e.message}`);
    }
  }
  return [];
}

const fmt = (s: ProvisionRow) => `[${s.act}, ${label(s.section)} - ${s.title}]\n${s.text.slice(0, 2500)}`;
const shuffle = <T,>(a: T[]) => a.map((v) => [Math.random(), v] as const).sort((x, y) => x[0] - y[0]).map((x) => x[1]);
const example = (ctx: ProvisionRow[], q: string, a: string) => ({
  messages: [
    { role: "system", content: SYSTEM },
    { role: "user", content: `Retrieved sections:\n${ctx.map(fmt).join("\n\n")}\n\nQuestion: ${q}` },
    { role: "assistant", content: a },
  ],
});

const { provisions } = await listProvisionRows({ limit: 200 });
const usable = provisions.filter((p) => p.text.length > 80);
console.log(`${usable.length} provisions, ${PER_SECTION} pairs each, teacher ${MODEL}`);

const rows: any[] = [];
const pairsBySection = new Map<string, Pair[]>();
let next = 0;
await Promise.all(Array.from({ length: 3 }, async () => {
  while (next < usable.length) {
    const p = usable[next++];
    const pairs = await teacher(p);
    pairsBySection.set(p.id, pairs);
    console.log(`  ${p.act} s.${p.section}: ${pairs.length} pairs`);
  }
}));

for (const p of usable) {
  for (const pair of pairsBySection.get(p.id) ?? []) {
    // The right section plus 0-2 unrelated ones, shuffled, so the model learns to pick the relevant text.
    const distractors = shuffle(usable.filter((x) => x.id !== p.id)).slice(0, Math.floor(Math.random() * 3));
    rows.push(example(shuffle([p, ...distractors]), pair.question, clean(pair.answer)));
    // The same question with ONLY unrelated sections: the right behaviour is to decline.
    if (Math.random() < 0.35) {
      const wrong = shuffle(usable.filter((x) => x.id !== p.id && x.act !== p.act)).slice(0, 1 + Math.floor(Math.random() * 2));
      if (wrong.length) rows.push(example(wrong, pair.question, NOT_COVERED.join(" ")));
    }
  }
}

const mixed = shuffle(rows);
const cut = Math.max(1, Math.floor(mixed.length * 0.1));
mkdirSync(OUT, { recursive: true });
const write = (f: string, r: any[]) => writeFileSync(path.join(OUT, f), r.map((x) => JSON.stringify(x)).join("\n") + "\n");
write("val.jsonl", mixed.slice(0, cut));
write("train.jsonl", mixed.slice(cut));
console.log(`Wrote ${mixed.length - cut} train and ${cut} val examples to ${OUT}`);
process.exit(0);
