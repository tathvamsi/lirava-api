/**
 * Core domain types and interfaces for the legal seed corpus.
 */

export interface ParsedProvision {
  id: string; // e.g. "bnss-2023-sec-482", "cpc-1908-o39-r1"
  act_code: string; // "BNSS", "BNS", "BSA", "CPC", "CRPC", "IPC", "ICA", "NIA"
  act_title: string; // Full title
  year: number; // Enactment year
  section: string; // "Section 482" or "Order XXXIX Rule 1"
  section_num: string; // "482", "O39_R1"
  title: string; // Section title / marginal note
  text: string; // Full statutory text
  ratio?: string; // Summary of principle
  category: string; // "criminal_procedure", "civil_procedure", etc.
  sub_clauses?: Array<{ num: string; text: string }>;
  provisos?: string[];
  explanations?: string[];
  illustrations?: string[];
  replaces?: { act_code: string; section: string };
  replaced_by?: { act_code: string; section: string };
}

export interface ParsedPrecedent {
  id: string; // e.g. "sc-bhajan-lal-1992"
  case_title: string; // "State of Haryana v. Bhajan Lal"
  primary_citation: string; // "1992 Supp (1) SCC 335"
  equivalent_citations: string[]; // ["AIR 1992 SC 604"]
  neutral_citation?: string; // "1992 INSC 285"
  court: string; // "Supreme Court of India"
  year: number;
  bench_description?: string;
  ratio: string;
  principles: string[];
  category: string;
  statutory_citations: Array<{ act_code: string; section: string }>;
}

export interface LegalSeedDefinition {
  id: string;
  act: string;
  section: string;
  title: string;
  category: "criminal_procedure" | "penal_code" | "evidence" | "commercial" | "civil_procedure" | "limitation" | "judicial_precedent";
  court?: string;
  year?: number;
  statutoryText: string;
  ratio?: string;
  source: string;
  // Enhanced metadata fields
  act_code?: string;
  section_num?: string;
  neutral_citation?: string;
  coram?: string;
  principles?: string[];
  statutory_citations?: Array<{ act_code: string; section: string }>;
  replaces?: { act_code: string; section: string };
  replaced_by?: { act_code: string; section: string };
}
