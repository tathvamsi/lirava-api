/**
 * Client for the document conversion service (Microsoft MarkItDown, on our own server). It turns a Word, PowerPoint,
 * Excel, HTML, EPUB, JSON or XML file into Markdown, keeping headings, lists and tables, so the text is faithful to the
 * file and cheap to read. Images and audio are not sent here (scans go to OCR). It is a twin of ocr.ts: a key-protected
 * sidecar that may be down, in which case the caller falls back to the built-in readers.
 */
import { config } from "../../config.js";

/** Files this service converts. PDFs are left to the page-by-page reader so citations keep their page numbers. */
export const MARKITDOWN_EXT = /\.(docx|pptx|xlsx|xls|csv|html?|epub|json|xml)$/i;

const REQUEST_TIMEOUT_MS = 120_000;

export function markitdownEnabled(): boolean {
  return Boolean(config.markitdownBaseUrl && config.markitdownApiKey);
}

export function wantsMarkitdown(name: string): boolean {
  return markitdownEnabled() && MARKITDOWN_EXT.test(name);
}

export interface Converted {
  markdown: string;
  warnings: string[];
}

/** Sends the file to the service. Throws if the service is down, busy or refuses the file. */
export async function markitdownConvert(name: string, buffer: Buffer): Promise<Converted> {
  if (!markitdownEnabled()) throw new Error("The conversion service is not configured.");
  const res = await fetch(`${config.markitdownBaseUrl}/convert`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.markitdownApiKey}`,
      "Content-Type": "application/octet-stream",
      "X-Filename": encodeURIComponent(name),
    },
    body: new Uint8Array(buffer),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Conversion service answered ${res.status}`);
  const body = (await res.json()) as Partial<Converted>;
  if (typeof body.markdown !== "string") throw new Error("Conversion service sent an unexpected reply.");
  return { markdown: body.markdown, warnings: Array.isArray(body.warnings) ? body.warnings.filter((w): w is string => typeof w === "string").slice(0, 10) : [] };
}

// ---------------- Splitting Markdown into readable sections ----------------

const isHeading = (line: string) => /^#{1,6}\s+\S/.test(line);
const isTableRow = (line: string) => /^\s*\|/.test(line);

/** A table too long for one section is cut by rows, each piece starting with the header and its rule so it still reads as a table. */
function splitTable(lines: string[], max: number): string[] {
  const header = lines.slice(0, 2);
  const rows = lines.slice(2);
  const pieces: string[] = [];
  let current = [...header];
  let size = current.join("\n").length;
  for (const row of rows) {
    if (size + row.length + 1 > max && current.length > header.length) {
      pieces.push(current.join("\n"));
      current = [...header];
      size = current.join("\n").length;
    }
    current.push(row);
    size += row.length + 1;
  }
  if (current.length > header.length) pieces.push(current.join("\n"));
  return pieces.length ? pieces : [lines.join("\n")];
}

/** Cuts one block that is longer than `max` at blank lines, keeping each table whole where it fits. */
function splitBlock(block: string, max: number): string[] {
  if (block.length <= max) return [block];
  const paragraphs = block.split(/\n{2,}/);
  const out: string[] = [];
  let current = "";
  const flush = () => {
    if (current.trim()) out.push(current.trim());
    current = "";
  };
  for (const para of paragraphs) {
    const lines = para.split("\n");
    const pieces =
      lines.length >= 3 && lines.every(isTableRow) && para.length > max
        ? splitTable(lines, max)
        : para.length > max
          ? para.match(new RegExp(`[\\s\\S]{1,${max}}(?:\\s|$)`, "g")) ?? [para]
          : [para];
    for (const piece of pieces) {
      if (current && current.length + piece.length + 2 > max) flush();
      current += (current ? "\n\n" : "") + piece;
    }
  }
  flush();
  return out;
}

/**
 * Splits Markdown into sections of about `target` to `max` characters for indexing. A heading starts a new block and stays
 * with the text under it; small neighbouring blocks are joined so a short slide or paragraph is not a section of its own;
 * a table is never cut in the middle of a row.
 */
export function markdownSections(markdown: string, max = 3000, target = 900): string[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const blocks: string[] = [];
  let current: string[] = [];
  const close = () => {
    const text = current.join("\n").trim();
    if (text) blocks.push(text);
    current = [];
  };
  for (const line of lines) {
    if (isHeading(line) && current.some((l) => l.trim() && !isHeading(l))) close();
    current.push(line);
  }
  close();

  const sections: string[] = [];
  let pending = "";
  for (const block of blocks.flatMap((b) => splitBlock(b, max))) {
    if (pending && pending.length >= target) {
      sections.push(pending);
      pending = "";
    }
    if (pending && pending.length + block.length + 2 > max) {
      sections.push(pending);
      pending = "";
    }
    pending += (pending ? "\n\n" : "") + block;
  }
  if (pending) sections.push(pending);
  return sections;
}
