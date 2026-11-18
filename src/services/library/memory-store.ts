import { keysFromCitationString } from "./cite-parse.js";
import type { CasePara, LibraryCase, LibraryProvision, LibraryStore } from "./types.js";

/** A library held in memory. Used by the tests, and handy for trying the verifier without a database. */
export class MemoryLibraryStore implements LibraryStore {
  private cases = new Map<string, LibraryCase>();
  private keys = new Map<string, Set<string>>();
  private paras = new Map<string, CasePara[]>();
  private provisions = new Map<string, LibraryProvision>();

  addCase(record: Omit<LibraryCase, "para_count">, citations: string[], paras: Array<{ para_no: string; text: string }> = []): this {
    this.cases.set(record.id, { ...record, para_count: paras.length });
    this.paras.set(record.id, paras.map((p) => ({ case_id: record.id, ...p })));
    for (const text of citations) {
      for (const key of keysFromCitationString(text)) {
        if (!this.keys.has(key)) this.keys.set(key, new Set());
        this.keys.get(key)!.add(record.id);
      }
    }
    return this;
  }

  addProvision(p: LibraryProvision): this {
    this.provisions.set(`${p.act_code.toUpperCase()}:${p.section_num.toUpperCase()}`, p);
    return this;
  }

  async findCases(key: string) {
    return [...(this.keys.get(key) ?? [])].map((id) => this.cases.get(id)!).filter(Boolean);
  }
  async getCase(id: string) {
    return this.cases.get(id) ?? null;
  }
  async getParas(caseId: string) {
    return this.paras.get(caseId) ?? [];
  }
  async holdsAct(actCode: string) {
    const code = actCode.toUpperCase();
    return [...this.provisions.values()].some((p) => p.act_code.toUpperCase() === code);
  }
  async findProvision(actCode: string, sectionNum: string) {
    return this.provisions.get(`${actCode.toUpperCase()}:${sectionNum.toUpperCase()}`) ?? null;
  }
}
