import type { CasePara } from "./types.js";

/**
 * Word-for-word quote checking against judgment text. Same rule as the case-file feature: the quote must appear in
 * the source after only case, spacing, quote-mark and dash differences are ignored. One changed word fails.
 */

export const MIN_QUOTE_CHARS = 12;

export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”„]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

/** A quote can skip words with "..." or "…". Each piece must be found; pieces too short to mean anything are ignored. */
export function quotePieces(quote: string): string[] {
  return quote
    .split(/\.{3,}|…|\[\s*\.{2,}\s*\]/)
    .map((p) => normalize(p).replace(/^["'\s,;:]+|["'\s,;:.]+$/g, ""))
    .filter((p) => p.length >= MIN_QUOTE_CHARS);
}

export interface QuoteMatch {
  found: boolean;
  /** Paragraph the first piece of the quote appears in. */
  para?: string;
}

/** Whether every piece of the quote appears word for word in the paragraphs, and which paragraph holds it. */
export function findQuote(quote: string, paras: CasePara[], preferPara?: string): QuoteMatch {
  const pieces = quotePieces(quote);
  if (pieces.length === 0) return { found: false };
  const norm = paras.map((p) => ({ para_no: p.para_no, text: normalize(p.text) }));
  const whole = norm.map((p) => p.text).join(" ");
  if (!pieces.every((piece) => whole.includes(piece) || norm.some((p) => p.text.includes(piece)))) return { found: false };
  const holders = norm.filter((p) => p.text.includes(pieces[0]));
  if (holders.length === 0) return { found: true }; // the first piece spans two paragraphs
  const chosen = holders.find((p) => p.para_no === preferPara) ?? holders[0];
  return { found: true, para: chosen.para_no };
}
