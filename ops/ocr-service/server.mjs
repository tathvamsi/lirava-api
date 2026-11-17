// Lirava OCR service: turns a scanned PDF or a photo into text, page by page, with Tesseract.
// POST /ocr?lang=eng+hin&maxPages=40   (Authorization: Bearer <OCR_KEY>, body = the file's bytes)
// -> { pages: [{ page, text, confidence }], truncated }
// It only reports what is printed on the page. It never guesses or "fixes" words.
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { timingSafeEqual } from "node:crypto";

const KEY = process.env.OCR_KEY || "";
const PORT = Number(process.env.OCR_PORT || 8084);
const MAX_BYTES = 25 * 1024 * 1024;
const MAX_PAGES_LIMIT = 60;
const PAGE_PARALLEL = Number(process.env.OCR_PAGE_PARALLEL || 4);
const JOB_TIMEOUT_MS = 6 * 60 * 1000;
const MAX_QUEUE = 4;
const LANGS = new Set(["eng", "hin", "tam", "tel", "kan", "mal", "mar", "guj", "ben"]);
const AUTO_CANDIDATES = ["eng+hin+mar", "eng+tam", "eng+tel", "eng+kan", "eng+mal", "eng+guj", "eng+ben"];

if (KEY.length < 24) {
  console.error("OCR_KEY must be set (at least 24 characters).");
  process.exit(1);
}

function run(cmd, args, { timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env: { ...process.env, OMP_THREAD_LIMIT: "1" } });
    const out = [];
    let err = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (d) => out.push(d));
    child.stderr.on("data", (d) => (err += d.toString().slice(0, 2000)));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(out).toString("utf8"));
      else reject(new Error(`${cmd} exited ${code}: ${err.trim().slice(0, 300)}`));
    });
  });
}

/** Tesseract TSV -> readable text (lines kept, paragraphs separated by a blank line) and mean word confidence. */
function fromTsv(tsv) {
  const rows = tsv.split("\n").slice(1);
  const lines = [];
  let current = null;
  let key = "";
  let confSum = 0;
  let confN = 0;
  for (const row of rows) {
    const c = row.split("\t");
    if (c.length < 12 || c[0] !== "5") continue; // level 5 = a word
    const word = c.slice(11).join("\t").trim();
    if (!word) continue;
    const conf = Number(c[10]);
    if (conf >= 0) {
      confSum += conf;
      confN++;
    }
    const lineKey = `${c[2]}-${c[3]}-${c[4]}`;
    if (lineKey !== key) {
      current = { par: `${c[2]}-${c[3]}`, words: [] };
      lines.push(current);
      key = lineKey;
    }
    current.words.push(word);
  }
  let text = "";
  let lastPar = "";
  for (const line of lines) {
    if (text) text += line.par !== lastPar ? "\n\n" : "\n";
    text += line.words.join(" ");
    lastPar = line.par;
  }
  return { text, confidence: confN ? Math.round(confSum / confN) : 0 };
}

async function ocrImage(path, lang) {
  const tsv = await run("tesseract", [path, "stdout", "-l", lang, "--psm", "3", "tsv"], { timeoutMs: 120000 });
  return fromTsv(tsv);
}

async function ocrFile(buffer, lang, maxPages) {
  const dir = await mkdtemp(join(tmpdir(), "lirava-ocr-"));
  try {
    const isPdf = buffer.subarray(0, 5).toString("latin1") === "%PDF-";
    let images;
    let truncated = false;
    if (isPdf) {
      await writeFile(join(dir, "in.pdf"), buffer);
      await run("pdftoppm", ["-r", "200", "-gray", "-png", "-l", String(maxPages + 1), join(dir, "in.pdf"), join(dir, "p")], { timeoutMs: 180000 });
      images = (await readdir(dir)).filter((f) => /^p-\d+\.png$/.test(f)).sort();
      if (images.length > maxPages) {
        truncated = true;
        images = images.slice(0, maxPages);
      }
    } else {
      await writeFile(join(dir, "in.img"), buffer);
      images = ["in.img"];
    }
    if (lang === "auto") {
      // Try each language set on the first page and keep the one Tesseract is most sure about.
      const scores = await Promise.all(AUTO_CANDIDATES.map(async (candidate) => ({ candidate, ...(await ocrImage(join(dir, images[0]), candidate)) })));
      let best = scores[0];
      for (const s of scores) if (s.confidence > best.confidence + 2) best = s; // earlier candidates win near-ties
      lang = best.candidate;
    }
    const pages = new Array(images.length);
    let next = 0;
    const worker = async () => {
      while (next < images.length) {
        const i = next++;
        const { text, confidence } = await ocrImage(join(dir, images[i]), lang);
        pages[i] = { page: i + 1, text, confidence };
      }
    };
    await Promise.all(Array.from({ length: Math.min(PAGE_PARALLEL, images.length) }, worker));
    return { pages, truncated, lang };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

let active = 0;
const waiting = [];
async function slot() {
  if (active === 0) {
    active = 1;
    return;
  }
  if (waiting.length >= MAX_QUEUE) throw Object.assign(new Error("busy"), { status: 503 });
  await new Promise((r) => waiting.push(r));
}
function release() {
  const next = waiting.shift();
  if (next) next();
  else active = 0;
}

function authorised(header) {
  const given = Buffer.from((header || "").replace(/^Bearer\s+/i, ""));
  const real = Buffer.from(KEY);
  return given.length === real.length && timingSafeEqual(given, real);
}

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (req.method === "GET" && url.pathname === "/health") return send(res, 200, { ok: true });
  if (req.method !== "POST" || url.pathname !== "/ocr") return send(res, 404, { error: "Not found" });
  if (!authorised(req.headers.authorization)) return send(res, 401, { error: "Unauthorised" });

  const langs = (url.searchParams.get("lang") || "eng+hin").split(/[+ ,]/).filter(Boolean);
  const auto = langs.length === 1 && langs[0] === "auto";
  if (!auto && (!langs.length || langs.length > 3 || !langs.every((l) => LANGS.has(l)))) return send(res, 400, { error: "Unsupported language" });
  const maxPages = Math.min(Math.max(Number(url.searchParams.get("maxPages")) || 40, 1), MAX_PAGES_LIMIT);

  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BYTES) return send(res, 413, { error: "File too large" });
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks);
  if (!body.length) return send(res, 400, { error: "Empty file" });

  try {
    await slot();
  } catch (e) {
    return send(res, e.status || 500, { error: "OCR is busy, try again shortly" });
  }
  try {
    const started = Date.now();
    const result = await Promise.race([
      ocrFile(body, langs.join("+"), maxPages),
      new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error("timeout"), { status: 504 })), JOB_TIMEOUT_MS)),
    ]);
    console.log(`ocr ${result.pages.length} page(s) ${langs.join("+")} in ${Date.now() - started}ms`);
    send(res, 200, result);
  } catch (e) {
    console.error("ocr failed:", e.message);
    send(res, e.status || 500, { error: "The file could not be read" });
  } finally {
    release();
  }
}).listen(PORT, "127.0.0.1", () => console.log(`ocr service on 127.0.0.1:${PORT}`));
