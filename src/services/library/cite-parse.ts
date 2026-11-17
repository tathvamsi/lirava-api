import type { ParsedCite } from "./types.js";

/**
 * Finds citations in text and turns each into a canonical key. Pure and deterministic: no model is involved, so
 * the same text always gives the same result, and a made-up citation can only be recognised, never "fixed".
 */

const YEAR = "(?:19|20)\\d{2}";
const ROMAN: Record<string, number> = { I: 1, V: 5, X: 10, L: 50, C: 100 };

function romanToInt(value: string): number | null {
  const s = value.toUpperCase();
  if (!/^[IVXLC]+$/.test(s)) return null;
  let total = 0;
  for (let i = 0; i < s.length; i++) {
    const cur = ROMAN[s[i]];
    const next = ROMAN[s[i + 1]] ?? 0;
    total += cur < next ? -cur : cur;
  }
  return total > 0 ? total : null;
}

/** Act names and abbreviations as lawyers write them, mapped to the library's act codes. Longest names first. */
const ACTS: Array<{ code: string; pattern: string }> = [
  { code: "BNSS", pattern: "BNSS|Bharatiya\\s+Nagarik\\s+Suraksha\\s+Sanhita(?:,?\\s*2023)?" },
  { code: "BNS", pattern: "BNS|Bharatiya\\s+Nyaya\\s+Sanhita(?:,?\\s*2023)?" },
  { code: "BSA", pattern: "BSA|Bharatiya\\s+Sakshya\\s+Adhiniyam(?:,?\\s*2023)?" },
  { code: "IPC", pattern: "I\\.?\\s?P\\.?\\s?C\\.?|Indian\\s+Penal\\s+Code(?:,?\\s*1860)?" },
  { code: "CRPC", pattern: "Cr\\.?\\s?P\\.?\\s?C\\.?|Code\\s+of\\s+Criminal\\s+Procedure(?:,?\\s*1973)?" },
  { code: "CPC", pattern: "C\\.?\\s?P\\.?\\s?C\\.?|Code\\s+of\\s+Civil\\s+Procedure(?:,?\\s*1908)?" },
  { code: "IEA", pattern: "(?:Indian\\s+)?Evidence\\s+Act(?:,?\\s*1872)?|I\\.?\\s?E\\.?\\s?A\\.?" },
  { code: "NIA", pattern: "N\\.?\\s?I\\.?\\s+Act|Negotiable\\s+Instruments?\\s+Act(?:,?\\s*1881)?" },
  { code: "ICA", pattern: "Indian\\s+Contract\\s+Act(?:,?\\s*1872)?|Contract\\s+Act" },
  { code: "NDPS", pattern: "NDPS(?:\\s+Act)?|Narcotic\\s+Drugs\\s+and\\s+Psychotropic\\s+Substances\\s+Act(?:,?\\s*1985)?" },
  { code: "PMLA", pattern: "PMLA|Prevention\\s+of\\s+Money[\\s-]+Laundering\\s+Act(?:,?\\s*2002)?" },
  { code: "POCSO", pattern: "POCSO(?:\\s+Act)?|Protection\\s+of\\s+Children\\s+from\\s+Sexual\\s+Offences\\s+Act(?:,?\\s*2012)?" },
  { code: "PCA", pattern: "Prevention\\s+of\\s+Corruption\\s+Act(?:,?\\s*1988)?|P\\.?\\s?C\\.?\\s+Act" },
  { code: "ITA", pattern: "Information\\s+Technology\\s+Act(?:,?\\s*2000)?|I\\.?\\s?T\\.?\\s+Act" },
];
const ACT_GROUP = ACTS.map((a) => `(?:${a.pattern})`).join("|");

export function actCodeOf(text: string): string | null {
  const t = text.trim();
  for (const a of ACTS) if (new RegExp(`^(?:${a.pattern})$`, "i").test(t)) return a.code;
  return null;
}

const SECTION = "\\d{1,3}[A-Za-z]{0,2}(?:\\(\\w{1,4}\\))*";
const normSection = (s: string) => s.replace(/\s+/g, "").toUpperCase();

function add(out: ParsedCite[], cite: ParsedCite) {
  // Two patterns can match the same text; keep the first and ignore anything overlapping it.
  if (out.some((c) => cite.span[0] < c.span[1] && c.span[0] < cite.span[1])) return;
  out.push(cite);
}

function reporter(series: string, year: string, vol: string, page: string, m: RegExpExecArray, out: ParsedCite[]) {
  add(out, {
    kind: "reporter",
    series,
    year: Number(year),
    vol,
    page: Number(page),
    raw: m[0],
    span: [m.index, m.index + m[0].length],
  });
}

export function extractCitations(text: string): ParsedCite[] {
  const out: ParsedCite[] = [];
  let m: RegExpExecArray | null;

  // Neutral citations first: "2023 INSC 123", "2023:DHC:2720".
  for (const re of [new RegExp(`\\b(${YEAR})\\s+INSC\\s+(\\d{1,5})\\b`, "g")]) {
    while ((m = re.exec(text))) add(out, { kind: "neutral", scheme: "INSC", year: Number(m[1]), n: Number(m[2]), raw: m[0], span: [m.index, m.index + m[0].length] });
  }
  {
    const re = new RegExp(`\\b(${YEAR}):([A-Z]{2,6}):(\\d{1,7})\\b`, "g");
    while ((m = re.exec(text))) add(out, { kind: "neutral", scheme: "HC", year: Number(m[1]), court: m[2], n: Number(m[3]), raw: m[0], span: [m.index, m.index + m[0].length] });
  }

  // SCC Online: "2023 SCC OnLine Del 456"
  {
    const re = new RegExp(`\\b(${YEAR})\\s+SCC\\s+Online\\s+([A-Za-z]{2,6})\\s+(\\d{1,6})\\b`, "gi");
    while ((m = re.exec(text))) reporter("SCCOL", m[1], m[2].toUpperCase(), m[3], m, out);
  }
  // SCC: "(2014) 9 SCC 129", "2014 (9) SCC 129", "1992 Supp (1) SCC 335"
  {
    const re = new RegExp(`\\(\\s*(${YEAR})\\s*\\)\\s*(\\d{1,3})\\s+SCC\\s+(\\d{1,5})\\b`, "g");
    while ((m = re.exec(text))) reporter("SCC", m[1], m[2], m[3], m, out);
  }
  {
    const re = new RegExp(`\\b(${YEAR})\\s*\\(\\s*(\\d{1,3})\\s*\\)\\s*SCC\\s+(\\d{1,5})\\b`, "g");
    while ((m = re.exec(text))) reporter("SCC", m[1], m[2], m[3], m, out);
  }
  {
    const re = new RegExp(`\\b(${YEAR})\\s+Supp\\.?\\s*\\(?\\s*(\\d{1,3})\\s*\\)?\\s+SCC\\s+(\\d{1,5})\\b`, "gi");
    while ((m = re.exec(text))) reporter("SCC", m[1], `S${m[2]}`, m[3], m, out);
  }
  // SCR / SCALE: "[2014] 3 SCR 45", "(2014) 5 SCALE 12"
  for (const series of ["SCR", "SCALE"]) {
    const re = new RegExp(`[\\(\\[]\\s*(${YEAR})\\s*[\\)\\]]\\s*(\\d{1,3})\\s+${series}\\s+(\\d{1,5})\\b`, "g");
    while ((m = re.exec(text))) reporter(series, m[1], m[2], m[3], m, out);
  }
  // AIR: "AIR 2008 SC 123", "A.I.R. 2008 S.C. 123", "AIR 2008 Del 55". Upper-case AIR only, so the word "air" never matches.
  {
    const re = new RegExp(`\\bA\\.?\\s?I\\.?\\s?R\\.?\\s+(${YEAR})\\s+([A-Z][A-Za-z.]{1,9}?)\\s+(\\d{1,5})\\b`, "g");
    while ((m = re.exec(text))) reporter("AIR", m[1], m[2].replace(/\./g, "").toUpperCase(), m[3], m, out);
  }

  // Order XXXIX Rule 1 CPC  ->  CPC O39_R1
  {
    const re = new RegExp(`\\bOrder\\s+([IVXLC]+|\\d{1,2})\\s*,?\\s*Rule\\s+(\\d{1,3}[A-Za-z]?)(?:\\s*\\(\\w{1,3}\\))?\\s*(?:of\\s+(?:the\\s+)?|,\\s*)?(${ACT_GROUP})(?![A-Za-z])`, "gi");
    while ((m = re.exec(text))) {
      const order = /^\d+$/.test(m[1]) ? Number(m[1]) : romanToInt(m[1]);
      const code = actCodeOf(m[3]);
      if (order && code === "CPC") add(out, { kind: "statute", act_code: "CPC", section: `O${order}_R${m[2].toUpperCase()}`, raw: m[0], span: [m.index, m.index + m[0].length] });
    }
  }

  // "Section 138 of the Negotiable Instruments Act", "Sections 3(5) and 61 of BNS", "s.103 BNS", "Sec 302 IPC"
  {
    const list = `${SECTION}(?:\\s*(?:,|and|&|/)\\s*${SECTION})*`;
    const re = new RegExp(`(?<![\\w'’])(?:sections?|secs?|ss?)\\b\\.?\\s*(${list})\\s*(?:of\\s+(?:the\\s+)?|,\\s*)?(${ACT_GROUP})(?![A-Za-z])`, "gi");
    while ((m = re.exec(text))) {
      const code = actCodeOf(m[2]);
      if (!code) continue;
      const sections = m[1].split(/\s*(?:,|and|&|\/)\s*/i).filter(Boolean);
      for (const s of sections) {
        // Each section in a list shares the span of the whole phrase; overlap rules would drop all but the first, so push directly.
        out.push({ kind: "statute", act_code: code, section: normSection(s), raw: m[0], span: [m.index, m.index + m[0].length] });
      }
    }
  }
  // "BNSS 482", "IPC section 302", "BNS, s. 103"
  {
    const re = new RegExp(`(?<![A-Za-z])(${ACT_GROUP})\\s*,?\\s*(?:sections?\\s+|secs?\\.?\\s*|s\\.\\s*)?(${SECTION})(?![\\d\\w])`, "gi");
    while ((m = re.exec(text))) {
      const code = actCodeOf(m[1]);
      if (!code) continue;
      const span: [number, number] = [m.index, m.index + m[0].length];
      if (out.some((c) => c.kind === "statute" && span[0] < c.span[1] && c.span[0] < span[1])) continue;
      out.push({ kind: "statute", act_code: code, section: normSection(m[2]), raw: m[0], span });
    }
  }

  // Paragraph pointers: "para 23", "paras 23-25", "¶ 12"
  {
    const re = /\b(?:paras?\.?|paragraphs?)\s*(\d{1,3}(?:\s*(?:-|–|to)\s*\d{1,3})?)|¶\s*(\d{1,3})/gi;
    while ((m = re.exec(text))) {
      const value = (m[1] ?? m[2]).replace(/\s+/g, "").replace(/to|–/gi, "-");
      out.push({ kind: "para", para: value, raw: m[0], span: [m.index, m.index + m[0].length] });
    }
  }

  return out.sort((a, b) => a.span[0] - b.span[0] || a.span[1] - b.span[1]);
}

/** The key a citation is stored and looked up under. Two writings of the same citation give the same key. */
export function canonicalKey(c: ParsedCite): string {
  switch (c.kind) {
    case "reporter":
      return `${c.series}:${c.year}:${c.vol}:${c.page}`;
    case "neutral":
      return c.scheme === "INSC" ? `INSC:${c.year}:${c.n}` : `NC:${c.year}:${c.court}:${c.n}`;
    case "statute":
      return `${c.act_code}:${c.section}`;
    case "para":
      return `PARA:${c.para}`;
  }
}

/** Every key a stored citation string produces, for example "1992 Supp (1) SCC 335" or "AIR 1992 SC 604". */
export function keysFromCitationString(citation: string | null | undefined): string[] {
  if (!citation) return [];
  return extractCitations(citation)
    .filter((c) => c.kind === "reporter" || c.kind === "neutral")
    .map(canonicalKey);
}
