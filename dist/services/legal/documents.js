/**
 * Renders a saved document (Markdown-style text from the assistant) to PDF or Word,
 * in full. Nothing is invented: no court, parties or prayers are added, and the text
 * is not truncated.
 */
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { AlignmentType, Document, Footer, HeadingLevel, Packer, PageNumber, Paragraph, Table, TableCell, TableRow, TextRun, WidthType, } from "docx";
export class UnsupportedTextError extends Error {
    characters;
    constructor(characters) {
        super(`This document contains characters the PDF format here cannot render (${characters.slice(0, 6).join(" ")}). Download the Word (.docx) version instead.`);
        this.characters = characters;
    }
}
// Typographic characters that have a faithful plain equivalent in the PDF's Latin font.
const LATIN_EQUIVALENTS = {
    "‘": "'", "’": "'", "‚": "'", "“": '"', "”": '"', "„": '"',
    "–": "-", "—": "-", "−": "-", "…": "...", " ": " ", " ": " ", "​": "",
    "•": "-", "●": "-", "→": "->", "₹": "Rs.", "✓": "v", "\t": "    ",
};
/** Strips Markdown syntax down to the plain text a court paper would carry. */
function plainInline(text) {
    return text
        .replace(/\*\*(.+?)\*\*/g, "$1")
        .replace(/__(.+?)__/g, "$1")
        .replace(/(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?![\w*])/g, "$1")
        .replace(/`([^`]+)`/g, "$1")
        .replace(/\[([^\]]+)\]\((?:[^)]+)\)/g, "$1");
}
const TABLE_LINE = /^\s*\|.*\|\s*$/;
const TABLE_RULE_CELL = /^:?-{2,}:?$/;
function parseTable(lines) {
    const rows = lines.map((line) => line
        .trim()
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split("|")
        .map((cell) => plainInline(cell.trim())));
    // Drop the "| --- | --- |" separator row.
    return rows.filter((row) => !row.every((cell) => TABLE_RULE_CELL.test(cell)));
}
export function parseBlocks(content) {
    const blocks = [];
    const lines = content.replace(/\r\n?/g, "\n").split("\n");
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].replace(/\s+$/, "");
        if (!line.trim()) {
            if (blocks.length && blocks[blocks.length - 1].type !== "gap")
                blocks.push({ type: "gap" });
            continue;
        }
        if (TABLE_LINE.test(line)) {
            const run = [line];
            while (i + 1 < lines.length && TABLE_LINE.test(lines[i + 1]))
                run.push(lines[++i].replace(/\s+$/, ""));
            const rows = parseTable(run);
            if (rows.length) {
                blocks.push({ type: "table", rows });
                continue;
            }
        }
        const heading = /^(#{1,6})\s+(.*)$/.exec(line);
        if (heading) {
            blocks.push({ type: "heading", level: Math.min(heading[1].length, 3), text: plainInline(heading[2]) });
            continue;
        }
        if (/^\s*([-*_]){3,}\s*$/.test(line)) {
            blocks.push({ type: "rule" });
            continue;
        }
        const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
        if (bullet) {
            blocks.push({ type: "item", marker: "-", text: plainInline(bullet[2]) });
            continue;
        }
        const numbered = /^(\s*)(\d+[.)]|\([a-zA-Z0-9]+\))\s+(.*)$/.exec(line);
        if (numbered) {
            blocks.push({ type: "item", marker: numbered[2], text: plainInline(numbered[3]) });
            continue;
        }
        blocks.push({ type: "para", text: plainInline(line.trim()) });
    }
    return blocks;
}
/** Single-line text the font can draw: whitespace collapsed, typographic marks mapped, anything else rejected. */
export function drawableLine(font, text) {
    const bad = new Set();
    const out = toDrawable(font, text.replace(/\s+/g, " "), bad);
    if (bad.size)
        throw new UnsupportedTextError([...bad]);
    return out;
}
/** Maps text onto what the PDF font can draw. Throws (rather than silently corrupting a legal document) if it cannot. */
function toDrawable(font, text, unsupported) {
    const supported = new Set(font.getCharacterSet());
    let out = "";
    for (const ch of text) {
        const mapped = LATIN_EQUIVALENTS[ch] ?? ch;
        for (const m of mapped) {
            if (m === "\n" || supported.has(m.codePointAt(0)))
                out += m;
            else
                unsupported.add(m);
        }
    }
    return out;
}
function wrap(font, text, size, maxWidth) {
    const lines = [];
    let line = "";
    const push = () => {
        lines.push(line);
        line = "";
    };
    for (const word of text.split(/\s+/).filter(Boolean)) {
        // Break a single word that is wider than the line (long URLs, reference numbers).
        let rest = word;
        while (font.widthOfTextAtSize(rest, size) > maxWidth) {
            let cut = rest.length - 1;
            while (cut > 1 && font.widthOfTextAtSize(rest.slice(0, cut), size) > maxWidth)
                cut--;
            if (line)
                push();
            lines.push(rest.slice(0, cut));
            rest = rest.slice(cut);
        }
        const candidate = line ? `${line} ${rest}` : rest;
        if (font.widthOfTextAtSize(candidate, size) <= maxWidth)
            line = candidate;
        else {
            push();
            line = rest;
        }
    }
    if (line)
        push();
    return lines;
}
export async function generateDocumentPdf(input) {
    const pdf = await PDFDocument.create();
    const regular = await pdf.embedFont(StandardFonts.TimesRoman);
    const bold = await pdf.embedFont(StandardFonts.TimesRomanBold);
    const unsupported = new Set();
    const PAGE = [595.28, 841.89]; // A4
    const left = 108; // 1.5 inch court margin
    const right = 72;
    const top = 72;
    const bottom = 80;
    const width = PAGE[0] - left - right;
    let page = pdf.addPage(PAGE);
    let y = PAGE[1] - top;
    const newPage = () => {
        page = pdf.addPage(PAGE);
        y = PAGE[1] - top;
    };
    const ensure = (needed) => {
        if (y - needed < bottom)
            newPage();
    };
    const title = toDrawable(bold, input.title.trim() || "Document", unsupported);
    for (const line of wrap(bold, title.toUpperCase(), 13, width)) {
        ensure(20);
        const w = bold.widthOfTextAtSize(line, 13);
        page.drawText(line, { x: left + (width - w) / 2, y, size: 13, font: bold, color: rgb(0, 0, 0) });
        y -= 19;
    }
    y -= 10;
    for (const block of parseBlocks(input.content)) {
        if (block.type === "gap") {
            y -= 6;
            continue;
        }
        if (block.type === "rule") {
            ensure(14);
            page.drawLine({ start: { x: left, y: y - 3 }, end: { x: left + width, y: y - 3 }, thickness: 0.5, color: rgb(0.4, 0.4, 0.4) });
            y -= 14;
            continue;
        }
        if (block.type === "table") {
            const cols = Math.max(...block.rows.map((row) => row.length));
            const colWidth = width / cols;
            const size = 9.5;
            const pad = 4;
            const lineHeight = 12.5;
            y -= 4;
            block.rows.forEach((row, rowIndex) => {
                const font = rowIndex === 0 ? bold : regular;
                const cells = Array.from({ length: cols }, (_, c) => wrap(font, toDrawable(font, row[c] ?? "", unsupported), size, colWidth - pad * 2));
                const rowHeight = Math.max(...cells.map((lines) => Math.max(lines.length, 1))) * lineHeight + pad * 2;
                ensure(rowHeight);
                cells.forEach((lines, c) => {
                    const x = left + c * colWidth;
                    page.drawRectangle({ x, y: y - rowHeight, width: colWidth, height: rowHeight, borderColor: rgb(0.45, 0.45, 0.45), borderWidth: 0.5 });
                    lines.forEach((line, l) => page.drawText(line, { x: x + pad, y: y - pad - size - l * lineHeight + 2, size, font, color: rgb(0, 0, 0) }));
                });
                y -= rowHeight;
            });
            y -= 10;
            continue;
        }
        if (block.type === "heading") {
            const size = block.level === 1 ? 13 : 12;
            const text = toDrawable(bold, block.level === 1 ? block.text.toUpperCase() : block.text, unsupported);
            y -= block.level === 1 ? 8 : 4;
            for (const line of wrap(bold, text, size, width)) {
                ensure(size + 8);
                const w = bold.widthOfTextAtSize(line, size);
                const x = block.level === 1 ? left + (width - w) / 2 : left;
                page.drawText(line, { x, y, size, font: bold, color: rgb(0, 0, 0) });
                y -= size + 5;
            }
            y -= 2;
            continue;
        }
        const size = 11;
        const leading = 16;
        const indent = block.type === "item" ? 22 : 0;
        const text = toDrawable(regular, block.text, unsupported);
        const marker = block.type === "item" ? toDrawable(regular, block.marker, unsupported) : "";
        const lines = wrap(regular, text, size, width - indent);
        lines.forEach((line, index) => {
            ensure(leading);
            if (index === 0 && marker)
                page.drawText(marker, { x: left, y, size, font: regular, color: rgb(0, 0, 0) });
            page.drawText(line, { x: left + indent, y, size, font: regular, color: rgb(0, 0, 0) });
            y -= leading;
        });
        y -= 4;
    }
    if (unsupported.size)
        throw new UnsupportedTextError([...unsupported]);
    const pages = pdf.getPages();
    const note = "Draft prepared with Lirava. Review before filing.";
    pages.forEach((p, index) => {
        const label = `Page ${index + 1} of ${pages.length}`;
        p.drawText(label, { x: left + (width - regular.widthOfTextAtSize(label, 9)) / 2, y: 40, size: 9, font: regular, color: rgb(0.35, 0.35, 0.35) });
        p.drawText(note, { x: left + (width - regular.widthOfTextAtSize(note, 8)) / 2, y: 28, size: 8, font: regular, color: rgb(0.5, 0.5, 0.5) });
    });
    return pdf.save();
}
/** Splits `**bold**` segments into runs, keeping every other character as written (Word handles full Unicode). */
function runs(text) {
    const out = [];
    const clean = text.replace(/__(.+?)__/g, "**$1**").replace(/`([^`]+)`/g, "$1").replace(/\[([^\]]+)\]\((?:[^)]+)\)/g, "$1");
    clean.split(/(\*\*.+?\*\*)/g).forEach((part) => {
        if (!part)
            return;
        if (part.startsWith("**") && part.endsWith("**") && part.length > 4)
            out.push(new TextRun({ text: part.slice(2, -2), bold: true }));
        else
            out.push(new TextRun({ text: part.replace(/\*\*/g, "") }));
    });
    return out;
}
export async function generateDocumentDocx(input) {
    const children = [
        new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { after: 240 },
            children: [new TextRun({ text: (input.title.trim() || "Document").toUpperCase(), bold: true, size: 26 })],
        }),
    ];
    for (const block of parseBlocks(input.content)) {
        if (block.type === "gap")
            continue;
        if (block.type === "table") {
            const cols = Math.max(...block.rows.map((row) => row.length));
            children.push(new Table({
                width: { size: 100, type: WidthType.PERCENTAGE },
                rows: block.rows.map((row, rowIndex) => new TableRow({
                    tableHeader: rowIndex === 0,
                    children: Array.from({ length: cols }, (_, c) => new TableCell({
                        width: { size: 100 / cols, type: WidthType.PERCENTAGE },
                        children: [new Paragraph({ children: [new TextRun({ text: row[c] ?? "", bold: rowIndex === 0, size: 20 })] })],
                    })),
                })),
            }), new Paragraph({ spacing: { after: 120 } }));
            continue;
        }
        if (block.type === "rule") {
            children.push(new Paragraph({ border: { bottom: { style: "single", size: 6, color: "999999", space: 1 } }, spacing: { after: 120 } }));
        }
        else if (block.type === "heading") {
            children.push(new Paragraph({
                heading: block.level === 1 ? HeadingLevel.HEADING_1 : block.level === 2 ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_3,
                alignment: block.level === 1 ? AlignmentType.CENTER : AlignmentType.LEFT,
                spacing: { before: 200, after: 120 },
                children: [new TextRun({ text: block.text, bold: true })],
            }));
        }
        else if (block.type === "item") {
            children.push(new Paragraph({
                indent: { left: 440, hanging: 440 },
                spacing: { after: 100 },
                children: [new TextRun({ text: `${block.marker}\t` }), ...runs(block.text)],
                tabStops: [{ type: "left", position: 440 }],
            }));
        }
        else {
            children.push(new Paragraph({ spacing: { after: 140 }, alignment: AlignmentType.JUSTIFIED, children: runs(block.text) }));
        }
    }
    const doc = new Document({
        styles: { default: { document: { run: { font: "Times New Roman", size: 24 } } } },
        sections: [
            {
                properties: { page: { margin: { top: 1440, bottom: 1440, left: 2160, right: 1440 } } },
                footers: {
                    default: new Footer({
                        children: [
                            new Paragraph({
                                alignment: AlignmentType.CENTER,
                                children: [
                                    new TextRun({ children: ["Page ", PageNumber.CURRENT, " of ", PageNumber.TOTAL_PAGES], size: 18 }),
                                ],
                            }),
                            new Paragraph({
                                alignment: AlignmentType.CENTER,
                                children: [new TextRun({ text: "Draft prepared with Lirava. Review before filing.", size: 16, color: "777777" })],
                            }),
                        ],
                    }),
                },
                children,
            },
        ],
    });
    return Packer.toBuffer(doc);
}
