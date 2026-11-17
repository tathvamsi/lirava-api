import { canonicalKey, extractCitations } from "./cite-parse.js";
import { findQuote } from "./text-match.js";
import type { CiteVerdict, LibraryStore, ParsedCite, VerifyResult } from "./types.js";

/**
 * Checks every citation in a piece of text against the library. Nothing here asks a model anything: the answer is
 * decided by lookups and a word-for-word comparison.
 *
 *   verified    the citation matches a library record (level "citation"), and when a quote was given it was found
 *               word for word in the judgment (level "quote")
 *   partial     the case is in the library but something does not hold: wrong case name, quote not found, paragraph
 *               out of range, two records share the citation, or the judgment text is not held so a quote can't be checked
 *   unverified  not in the library. This does NOT mean the case does not exist; it means we cannot vouch for it.
 */

export interface VerifyOptions {
  /** ISO date of the offence, to warn when the Act cited was not yet in force (BNS/BNSS/BSA from 1 July 2024). */
  offenceDate?: string;
}

const NEW_CODES_IN_FORCE = "2024-07-01";
const NEW_CODES = new Set(["BNS", "BNSS", "BSA"]);
const OLD_CODES = new Set(["IPC", "CRPC", "IEA"]);

const STOP = new Set(["state", "union", "india", "another", "others", "anr", "ors", "versus", "of", "the", "and", "through", "its", "secretary", "ltd", "limited", "pvt", "private", "company", "government", "govt", "from", "with", "under"]);

const tokens = (s: string) =>
  new Set(
    s
      .toLowerCase()
      .replace(/[^a-z\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length >= 4 && !STOP.has(t)),
  );

/** The last "X v. Y" written just before a citation, or null when the text gives no case name. */
function caseNameBefore(slice: string): string | null {
  const re = /([A-Z][\w.&'’ -]{1,60}?)\s+(?:v\.?|vs\.?|versus)\s+([A-Z][\w.&'’, -]{1,60}?)(?=\s*[,(\[]|\s*$)/g;
  let last: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(slice))) last = `${m[1]} v. ${m[2]}`;
  return last;
}

function quoteNear(text: string, before: [number, number], after: [number, number]): string | null {
  const re = /["“]([^"“”]{12,}?)["”]/g;
  const afterSlice = text.slice(after[0], after[1]);
  const mAfter = re.exec(afterSlice);
  if (mAfter && mAfter.index <= 300) return mAfter[1];
  const beforeSlice = text.slice(before[0], before[1]);
  re.lastIndex = 0;
  let last: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(beforeSlice))) last = m;
  if (last && beforeSlice.length - (last.index + last[0].length) <= 250) return last[1];
  return null;
}

function paraNear(paraCites: Extract<ParsedCite, { kind: "para" }>[], spanStart: number, spanEnd: number, limit: number): string | null {
  const hit = paraCites.find((p) => (p.span[0] >= spanEnd && p.span[0] <= Math.min(limit, spanEnd + 120)) || (p.span[1] <= spanStart && p.span[1] >= spanStart - 60));
  return hit ? hit.para.split("-")[0] : null;
}

export async function verifyAnswer(text: string, store: LibraryStore, options: VerifyOptions = {}): Promise<VerifyResult> {
  const all = extractCitations(text);
  const paraCites = all.filter((c): c is Extract<ParsedCite, { kind: "para" }> => c.kind === "para");
  const cites = all.filter((c) => c.kind !== "para");
  const verdicts: CiteVerdict[] = [];

  for (let i = 0; i < cites.length; i++) {
    const cite = cites[i];
    const prevEnd = i > 0 ? Math.max(...cites.slice(0, i).map((c) => c.span[1])) : 0;
    const nextStart = cites.slice(i + 1).find((c) => c.span[0] >= cite.span[1])?.span[0] ?? text.length;
    const base = { raw: cite.raw, span: cite.span, kind: cite.kind } as const;

    if (cite.kind === "statute") {
      const provision = await store.findProvision(cite.act_code, cite.section);
      let warning: string | undefined;
      const d = options.offenceDate;
      if (d && NEW_CODES.has(cite.act_code) && d < NEW_CODES_IN_FORCE) warning = `The offence date (${d}) is before 1 July 2024, so the old law (IPC, CrPC or Evidence Act) applies, not ${cite.act_code}.`;
      if (d && OLD_CODES.has(cite.act_code) && d >= NEW_CODES_IN_FORCE) warning = `The offence date (${d}) is on or after 1 July 2024, so the new law (BNS, BNSS or BSA) applies, not ${cite.act_code}.`;
      if (!warning && provision?.repealed) warning = `${cite.act_code} was repealed on 1 July 2024. It still governs offences committed before that date; for later offences the new law applies.`;
      verdicts.push(
        provision
          ? { ...base, status: "verified", reason: "ok", level: "citation", library_id: provision.id, library_title: provision.title, source_url: provision.source ?? null, ...(warning ? { warning } : {}) }
          : { ...base, status: "unverified", reason: "not_in_library", ...(warning ? { warning } : {}) },
      );
      continue;
    }

    const matches = await store.findCases(canonicalKey(cite));
    if (matches.length === 0) {
      verdicts.push({ ...base, status: "unverified", reason: "not_in_library" });
      continue;
    }
    if (matches.length > 1) {
      verdicts.push({ ...base, status: "partial", reason: "ambiguous", warning: "More than one library record has this citation, so it cannot be matched to a single case." });
      continue;
    }

    const record = matches[0];
    const found = { ...base, library_id: record.id, library_citation: record.citation_text, library_title: record.title, source_url: record.source_url ?? null } as const;

    // A real citation written next to the wrong case name is the classic made-up reference.
    const named = caseNameBefore(text.slice(Math.max(prevEnd, cite.span[0] - 200), cite.span[0]));
    if (named) {
      const a = tokens(named);
      const b = tokens(record.title);
      if (a.size > 0 && b.size > 0 && ![...a].some((t) => b.has(t))) {
        verdicts.push({ ...found, status: "partial", reason: "title_mismatch", warning: `The citation belongs to "${record.title}", not "${named}".` });
        continue;
      }
    }

    const quote = quoteNear(text, [prevEnd, cite.span[0]], [cite.span[1], nextStart]);
    const citedPara = paraNear(paraCites, cite.span[0], cite.span[1], nextStart);

    if (record.para_count === 0) {
      verdicts.push(
        quote
          ? { ...found, status: "partial", reason: "no_text", quote, warning: "The case is in the library but its judgment text is not, so the quote could not be checked." }
          : { ...found, status: "verified", reason: "ok", level: "citation" },
      );
      continue;
    }

    const paras = await store.getParas(record.id);
    if (citedPara && !paras.some((p) => p.para_no === citedPara) && Number(citedPara) > record.para_count) {
      verdicts.push({ ...found, status: "partial", reason: "para_out_of_range", para: citedPara, warning: `This judgment has ${record.para_count} paragraphs; paragraph ${citedPara} does not exist.` });
      continue;
    }

    if (quote) {
      const hit = findQuote(quote, paras, citedPara ?? undefined);
      if (!hit.found) {
        verdicts.push({ ...found, status: "partial", reason: "quote_not_found", quote, ...(citedPara ? { para: citedPara } : {}), warning: "The quoted words were not found in this judgment." });
        continue;
      }
      const para = hit.para ?? citedPara ?? undefined;
      verdicts.push({
        ...found,
        status: "verified",
        reason: "ok",
        level: "quote",
        quote,
        ...(para ? { para } : {}),
        ...(citedPara && hit.para && hit.para !== citedPara ? { warning: `The quote is in paragraph ${hit.para}, not paragraph ${citedPara}.` } : {}),
      });
      continue;
    }

    verdicts.push({ ...found, status: "verified", reason: "ok", level: "citation", ...(citedPara ? { para: citedPara } : {}) });
  }

  const counts = { verified: 0, partial: 0, unverified: 0 };
  for (const v of verdicts) counts[v.status]++;
  return { verdicts, counts };
}
