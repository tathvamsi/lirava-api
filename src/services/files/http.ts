/** `Content-Disposition` that is safe for any filename (quotes, newlines, non-ASCII) and cannot inject headers. */
export function contentDisposition(type: "inline" | "attachment", filename: string): string {
  const cleaned = filename.replace(/[\r\n"\\/:*?<>|\x00-\x1f]+/g, "_").trim() || "file";
  const ascii = cleaned.replace(/[^\x20-\x7e]/g, "_");
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(cleaned)}`;
}

/** Types a browser can safely display in place. Everything else (HTML, SVG, scripts) is only ever downloaded. */
const INLINE_SAFE = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "text/plain",
]);

export function isInlineSafe(mime: string): boolean {
  return INLINE_SAFE.has(mime.toLowerCase().split(";")[0].trim());
}

/** Extensions accepted for upload, with the first bytes each must start with (where the format has a signature). */
const ALLOWED: Record<string, { mime: string; magic?: number[] }> = {
  ".pdf": { mime: "application/pdf", magic: [0x25, 0x50, 0x44, 0x46] },
  ".docx": { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", magic: [0x50, 0x4b] },
  ".xlsx": { mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", magic: [0x50, 0x4b] },
  ".png": { mime: "image/png", magic: [0x89, 0x50, 0x4e, 0x47] },
  ".jpg": { mime: "image/jpeg", magic: [0xff, 0xd8, 0xff] },
  ".jpeg": { mime: "image/jpeg", magic: [0xff, 0xd8, 0xff] },
  ".gif": { mime: "image/gif", magic: [0x47, 0x49, 0x46] },
  ".webp": { mime: "image/webp", magic: [0x52, 0x49, 0x46, 0x46] },
  ".txt": { mime: "text/plain" },
  ".md": { mime: "text/markdown" },
  ".csv": { mime: "text/csv" },
  ".rtf": { mime: "application/rtf" },
};

export function checkUpload(name: string, data: Buffer): { ok: true; mime: string } | { ok: false; reason: string } {
  const dotIndex = name.lastIndexOf(".");
  const ext = dotIndex >= 0 ? name.slice(dotIndex).toLowerCase() : "";
  const rule = ALLOWED[ext];
  if (!rule) return { ok: false, reason: `${name}: this file type is not supported. Upload PDF, Word, Excel, text, CSV or image files.` };
  if (data.length === 0) return { ok: false, reason: `${name}: the file is empty.` };
  if (rule.magic && !rule.magic.every((byte, i) => data[i] === byte)) {
    return { ok: false, reason: `${name}: the file's contents do not match its type.` };
  }
  return { ok: true, mime: rule.mime };
}
