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

/** Letters of the Indian scripts the product supports: Devanagari, Bengali, Gurmukhi, Gujarati, Odia, Tamil, Telugu, Kannada, Malayalam. */
const INDIC_LETTERS = /[ऀ-ൿ]/;

const STOP = new Set(["state", "union", "india", "another", "others", "anr", "ors", "versus", "of", "the", "and", "through", "its", "secretary", "ltd", "limited", "pvt", "private", "company", "government", "govt", "from", "with", "under"]);

const tokens = (s: string) =>
  new Set(
    s
      .toLowerCase()
      .replace(/[^a-z\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length >= 4 && !STOP.has(t)),
  );

/**
 * Kinds of case citation the library holds no records for. The Supreme Court source has INSC and SCR only, so a citation in one
 * of these forms that matches nothing is "not covered", not "not in library". (A record that does carry such a key still verifies:
 * this is only consulted after the lookup finds nothing.) Returns a plain-words label, or null when the form is one we cover.
 */
const UNCOVERED_SERIES: Record<string, string> = { SCC: "SCC", SCCOL: "SCC OnLine", AIR: "AIR", SCALE: "SCALE" };
function uncoveredSeries(cite: ParsedCite): string | null {
  if (cite.kind === "reporter") return UNCOVERED_SERIES[cite.series] ?? null;
  if (cite.kind === "neutral" && cite.scheme === "HC") return "High Court neutral";
  return null;
}

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
      // "Section 103(1)(a)" is looked up as section 103. The sub-clause is not checked, only that the section exists.
      const sectionBase = cite.section.replace(/\(.*$/, "");
      const provision = await store.findProvision(cite.act_code, sectionBase);
      let warning: string | undefined;
      const d = options.offenceDate;
      if (d && NEW_CODES.has(cite.act_code) && d < NEW_CODES_IN_FORCE) warning = `The offence date (${d}) is before 1 July 2024, so the old law (IPC, CrPC or Evidence Act) applies, not ${cite.act_code}.`;
      if (d && OLD_CODES.has(cite.act_code) && d >= NEW_CODES_IN_FORCE) warning = `The offence date (${d}) is on or after 1 July 2024, so the new law (BNS, BNSS or BSA) applies, not ${cite.act_code}.`;
      if (!warning && provision?.repealed) warning = `${cite.act_code} was repealed on 1 July 2024. It still governs offences committed before that date; for later offences the new law applies.`;
      if (provision) {
        verdicts.push({ ...base, status: "verified", reason: "ok", level: "citation", library_id: provision.id, library_title: provision.title, source_url: provision.source ?? null, ...(warning ? { warning } : {}) });
        continue;
      }
      // An Act whose text is not loaded at all is "not covered": the library can say nothing about it. An Act it does hold,
      // with no such section, is "not in library". When the store cannot say which Acts it holds, the old answer stands.
      const covered = store.holdsAct ? await store.holdsAct(cite.act_code).catch(() => true) : true;
      if (/^O\d+_R/.test(cite.section)) {
        // CPC Orders and Rules are in the Act's First Schedule, which is not loaded, so the library cannot say either way.
        const note = "The library does not hold the Orders and Rules of the CPC yet, so this could not be checked either way.";
        verdicts.push({ ...base, status: "unverified", reason: "not_covered", warning: warning ? `${warning} ${note}` : note });
      } else if (!covered) {
        const note = `The library does not hold the text of ${cite.act_code} yet, so this section could not be checked either way.`;
        verdicts.push({ ...base, status: "unverified", reason: "not_covered", warning: warning ? `${warning} ${note}` : note });
      } else {
        verdicts.push({ ...base, status: "unverified", reason: "not_in_library", ...(warning ? { warning } : {}) });
      }
      continue;
    }

    const matches = await store.findCases(canonicalKey(cite));
    if (matches.length === 0) {
      const gap = uncoveredSeries(cite);
      verdicts.push(
        gap
          ? { ...base, status: "unverified", reason: "not_covered", warning: `The library does not hold ${gap} citations yet, so it cannot say whether this one is genuine. Check it against the reporter.` }
          : { ...base, status: "unverified", reason: "not_in_library" },
      );
      continue;
    }
    if (matches.length > 1) {
      verdicts.push({ ...base, status: "partial", reason: "ambiguous", warning: "More than one library record has this citation, so it cannot be matched to a single case." });
      continue;
    }

    const record = matches[0];
    const translations = (record.languages ?? []).filter((l) => l !== "ENG");
    const found = { ...base, library_id: record.id, library_citation: record.citation_text, library_title: record.title, source_url: record.source_url ?? null, ...(translations.length ? { translations } : {}) } as const;

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

    // A case name written in another script cannot be compared with the record's English title. Say so, and show the record.
    const nameNote =
      !named && INDIC_LETTERS.test(text.slice(Math.max(prevEnd, cite.span[0] - 120), cite.span[0]))
        ? `The case name was written in another script, so it was not compared with the record. The library lists this citation as "${record.title}".`
        : null;

    const quote = quoteNear(text, [prevEnd, cite.span[0]], [cite.span[1], nextStart]);
    const citedPara = paraNear(paraCites, cite.span[0], cite.span[1], nextStart);

    if (record.para_count === 0) {
      verdicts.push(
        quote
          ? { ...found, status: "partial", reason: "no_text", quote, warning: "The case is in the library but its judgment text is not, so the quote could not be checked." }
          : { ...found, status: "verified", reason: "ok", level: "citation", ...(nameNote ? { warning: nameNote } : {}) },
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

    verdicts.push({ ...found, status: "verified", reason: "ok", level: "citation", ...(citedPara ? { para: citedPara } : {}), ...(nameNote ? { warning: nameNote } : {}) });
  }

  const counts = { verified: 0, partial: 0, unverified: 0 };
  for (const v of verdicts) counts[v.status]++;
  return { verdicts, counts };
}
