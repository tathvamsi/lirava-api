/**
 * Client for the OCR service (Tesseract on our own server). It reads a scanned PDF or a photo and returns the
 * printed text page by page with a confidence score. It never guesses: a page it cannot read comes back thin or
 * with a low score, and the caller decides what to do with it.
 */
import { config } from "../../config.js";
const REQUEST_TIMEOUT_MS = 90_000;
/** Pages the service reads in one request. */
export const OCR_MAX_PAGES = 40;
export function ocrEnabled() {
    return Boolean(config.ocrBaseUrl && config.ocrApiKey);
}
/** Sends the file to the OCR service. Throws if the service is down, busy or refuses the file. */
export async function ocrFile(buffer) {
    if (!ocrEnabled())
        throw new Error("OCR is not configured.");
    const url = `${config.ocrBaseUrl}/ocr?lang=${encodeURIComponent(config.ocrLang)}&maxPages=${OCR_MAX_PAGES}`;
    const res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${config.ocrApiKey}`, "Content-Type": "application/octet-stream" },
        body: new Uint8Array(buffer),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok)
        throw new Error(`OCR service answered ${res.status}`);
    const body = (await res.json());
    if (!Array.isArray(body.pages))
        throw new Error("OCR service sent an unexpected reply.");
    const pages = body.pages
        .filter((p) => Boolean(p) && typeof p.page === "number" && typeof p.text === "string")
        .map((p) => ({ page: p.page, text: p.text, confidence: Number.isFinite(p.confidence) ? p.confidence : 0 }));
    return { pages, truncated: body.truncated === true, lang: typeof body.lang === "string" ? body.lang : config.ocrLang };
}
