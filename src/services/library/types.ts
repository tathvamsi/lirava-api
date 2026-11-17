/**
 * The legal library: what a "verified" citation is checked against.
 *
 * A citation is only ever called verified when it resolves to a record in this library. The model never types a
 * citation that is shown as fact: it points at a library id, and the app prints the citation from the record.
 */

export type CiteStatus = "verified" | "partial" | "unverified";

/** What was actually checked. "citation" = the cite matches a library record; "quote" = a quoted passage was found word for word. */
export type CheckLevel = "citation" | "quote";

export type CiteReason =
  | "ok"
  | "not_in_library"
  | "ambiguous"
  | "title_mismatch"
  | "quote_not_found"
  | "para_out_of_range"
  | "no_text";

export type ParsedCite =
  | { kind: "reporter"; series: string; year: number; vol: string; page: number; raw: string; span: [number, number] }
  | { kind: "neutral"; scheme: string; year: number; n: number; court?: string; raw: string; span: [number, number] }
  | { kind: "statute"; act_code: string; section: string; raw: string; span: [number, number] }
  | { kind: "para"; para: string; raw: string; span: [number, number] };

export interface LibraryCase {
  id: string;
  title: string;
  court: string;
  year: number;
  /** How the library prints this case, for example "(1992 Supp (1) SCC 335)". Always built from the record, never from model text. */
  citation_text: string;
  source_url?: string | null;
  /** Number of numbered paragraphs held. 0 means only the record is in the library, not the judgment text. */
  para_count: number;
}

export interface CasePara {
  case_id: string;
  para_no: string;
  text: string;
}

export interface LibraryProvision {
  id: string;
  act_code: string;
  section_num: string;
  title: string;
  source?: string | null;
}

export interface LibraryStore {
  /** Every case whose citation keys include this key (see canonicalKey). More than one means the cite is ambiguous. */
  findCases(key: string): Promise<LibraryCase[]>;
  getCase(id: string): Promise<LibraryCase | null>;
  getParas(caseId: string): Promise<CasePara[]>;
  findProvision(actCode: string, sectionNum: string): Promise<LibraryProvision | null>;
}

export interface CiteVerdict {
  raw: string;
  span: [number, number];
  kind: ParsedCite["kind"];
  status: CiteStatus;
  reason: CiteReason;
  /** Set only when status is "verified": how far the check went. */
  level?: CheckLevel;
  library_id?: string;
  /** The citation as the library prints it. */
  library_citation?: string;
  library_title?: string;
  para?: string;
  quote?: string;
  source_url?: string | null;
  warning?: string;
}

export interface VerifyResult {
  verdicts: CiteVerdict[];
  counts: Record<CiteStatus, number>;
}
