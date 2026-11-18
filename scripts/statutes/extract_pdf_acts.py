"""
Turns the text of two official PDFs into one record per section/article, for Acts that India Code's new site no longer serves:

  CRPC  The Code of Criminal Procedure, 1973 (Act 2 of 1974). Source PDF: the copy of the India Code text held by WIPO Lex,
        https://www.wipo.int/wipolex/en/legislation/details/8578  (last modified there March 2011: later amendments may be missing).
  COI   The Constitution of India, English-Kannada edition "as on 11th November, 2025", Legislative Department,
        https://www.legislative.gov.in/static/uploads/2025/07/359f70a69695affb9d72f8393102bd2e.pdf

The PDFs are turned into text first with:  pdftotext -layout <file>.pdf <file>.txt

Each record carries its source, the PDF's own date note, and the fetch date. Every number from 1 to the Act's highest that
has no record is reported, so a gap shows up instead of silently verifying nothing.

Usage:  python extract_pdf_acts.py <crpc.txt> <coi.txt> <ipc.txt> <iea.txt> <out_dir>
"""
import hashlib
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

FETCHED = datetime.now(timezone.utc).strftime("%Y-%m-%d")
DATASET_CRPC = "WIPO Lex copy of the India Code PDF of the Code of Criminal Procedure, 1973 (as last modified March 2011)"
DATASET_COI = "Legislative Department PDF: Constitution of India, English-Kannada edition as on 11 Nov 2025"
LICENCE = "Government of India publication (reuse confirmed by the product owner 2026-11-18)"
FOOTNOTE = re.compile(r"^\s*\d{1,3}\.\s+(Subs\.|Ins\.|Omitted|The words|Added|Rep\.|Clause|Sub-section|Proviso|Section|Explanation|Re-numbered|Renumbered|See )")


def record(code, act_id, act_title, year, status, num, title, text, dataset, url):
    return {
        "act_code": code, "act_id": act_id, "act_title": act_title, "year": year, "act_status": status, "in_force": status == "in_force",
        "section_num": num, "title": title, "chapter": "", "text": text, "text_sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
        "source_url": url, "source_publisher": "Government of India", "dataset": dataset, "licence": LICENCE, "fetched": FETCHED,
    }


def alnum(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", s.lower())


ALLOWED_NON_ASCII = {0x2013, 0x2014, 0x2018, 0x2019, 0x201C, 0x201D, 0x2026, 0xA7, 0xB0, 0xBD}

class _Other:
    """Counts characters from outside English text (the garbled second language of the diglot edition)."""

    def findall(self, s):
        return [c for c in s if ord(c) > 127 and ord(c) not in ALLOWED_NON_ASCII]

    def search(self, s):
        return bool(self.findall(s))


OTHER_SCRIPT = _Other()


def english_only(lines):
    """The Constitution PDF is a two-language edition; its second language comes out as garbled characters. Keep the English lines."""
    return [l for l in lines if len(OTHER_SCRIPT.findall(l)) <= 2]


def clean_body(lines):
    out = [l.rstrip() for l in lines if not FOOTNOTE.match(l)]
    t = "\n".join(out)
    t = re.sub(r"\n\s*(CHAPTER|CHAP)\s+[IVXLC]+[A-Z]?\s*(\n[^\n]*)?\s*$", "", t)  # a chapter heading belongs to the next section
    return re.sub(r"\n{3,}", "\n\n", re.sub(r"[ \t]+", " ", t)).strip()


def crpc(txt: str):
    lines = txt.split("\n")
    markers = []  # (marker line, number, title, first body line)
    for i, l in enumerate(lines):
        m = re.fullmatch(r"\s*(\d{1,3}[A-Z]{0,2})\.?\s*", l)
        if not m:
            continue
        num = m.group(1)
        j = i + 1
        while j < len(lines) and not lines[j].strip():
            j += 1
        title_lines = []
        while j < len(lines) and lines[j].strip() and not re.match(rf"^\s*{num}\.\s*\S", lines[j]):
            title_lines.append(lines[j].strip())
            j += 1
            if len(title_lines) > 4:
                break
        while j < len(lines) and not lines[j].strip():
            j += 1
        title = re.sub(r"\s+", " ", " ".join(title_lines)).rstrip(". ").strip()
        # The body must open with the same number AND repeat the margin title: two checks that agree.
        if j < len(lines) and title_lines and re.match(rf"^\s*{num}\.\s*", lines[j]) and alnum(title)[:12] in alnum(re.sub(rf"^\s*{num}\.", "", lines[j]))[:90]:
            markers.append((i, num, title, j))
    found: dict[int, int] = {}
    for m in markers:  # the FIRST place a number is announced: later repeats are schedules and amendment notes
        if m[1].isdigit():
            found.setdefault(int(m[1]), m[0])
    for n in range(1, 485):
        if n in found:
            continue
        # Search between the nearest numbered neighbours (by number, not by position, so a stray later repeat cannot widen it wrongly).
        lo = found[max((k for k in found if k < n), default=0)] if any(k < n for k in found) else 0
        hi = found[min((k for k in found if k > n), default=0)] if any(k > n for k in found) else len(lines)
        for j in range(lo + 1, hi):
            m = re.match(rf"^\s{{4,14}}{n}\.\s*([A-Z].{{3,150}})$", lines[j])
            if not m:
                continue
            joined = re.sub(r"\s+", " ", f"{m.group(1)} {lines[j + 1].strip()}")
            t = re.match(r"^(?:\(\d+\))?\s*(.{4,160}?)\.\s*(?:\(|\d|[A-Z]|-|\*|$)", joined)
            if t:
                markers.append((j, str(n), t.group(1).strip(" .-"), j))
                found[n] = j
                break
    markers.sort(key=lambda m: m[0])
    recs, seen = [], set()
    for k, (i, num, title, j) in enumerate(markers):
        if num in seen:
            continue  # a later amendment note or schedule repeating the number
        seen.add(num)
        end = markers[k + 1][0] if k + 1 < len(markers) else len(lines)
        body = lines[j:end]
        body[0] = re.sub(rf"^\s*{num}\.\s*", "", body[0])
        first_title = title.lower()[:30]
        if body[0].lower().startswith(first_title):
            body[0] = body[0][len(title):].lstrip(". -—–")
        text = clean_body(body)
        if len(text) < 25:
            continue
        recs.append(record("CRPC", "AC_CEN_2_1974", "The Code of Criminal Procedure, 1973", 1974, "repealed", num, title, text, DATASET_CRPC, "https://www.wipo.int/wipolex/en/legislation/details/8578"))
    return recs, 484


def inline_headings(txt: str, meta: dict):
    lines = txt.split("\n")
    opener = "A-Z“\"‘"  # a title may open with a quote mark, as in "10. “Man”. “Woman”.--"
    start = re.compile(rf"^\s*[*\s]*(?:[\d*]{{0,4}}\[)*(\d{{1,3}}[A-Z]{{0,2}})\.\s*(?:\d{{0,3}}\[)?[{opener}]")
    head = re.compile(rf"^\s*[*\s]*(?:[\d*]{{0,4}}\[)*(\d{{1,3}}[A-Z]{{0,2}})\.\s*(?:\d{{0,3}}\[)?([{opener}][^\n]{{2,220}}?)\.\s*(?:--|—|–|-{{1,2}})\s*(.*)$", re.S)
    heads = []
    for i, l in enumerate(lines):
        if not start.match(l) or re.search(r"\.{4,}", l):
            continue
        # A heading can wrap over up to three lines before its ".--" ends it.
        joined = " ".join(x.strip() for x in lines[i:i + 3])
        m = head.match(joined)
        if m:
            heads.append((i, m.group(1), re.sub(r"\s+", " ", re.sub(r"\d{0,3}\[|\]", "", m.group(2))).strip(), m.group(3)))
    recs, seen = [], set()
    last = 0
    for k, (i, num, title, rest) in enumerate(heads):
        n = int(re.match(r"\d+", num).group())
        # Articles run in order; a number far out of order is a footnote or a reference, not a heading.
        if n < last - 1 or n > last + 40 or num in seen:
            continue
        last = max(last, n)
        if re.match(r"^\[?(Omitted|Repealed)", title, re.I):
            continue
        seen.add(num)
        end = next((heads[q][0] for q in range(k + 1, len(heads)) if int(re.match(r"\d+", heads[q][1]).group()) in range(n, n + 41) and heads[q][1] != num), len(lines))
        if OTHER_SCRIPT.search(title):
            continue  # a heading of the other language's column
        text = clean_body(english_only([rest] + lines[i + 1:end]))
        text = re.sub(r"^\d*\[", "", text)
        if len(text) < 25:
            continue
        recs.append(record(meta["code"], meta["act_id"], meta["title"], meta["year"], meta["status"], num, title, text, meta["dataset"], meta["url"]))
    return recs, meta["expected"]


COI_META = {"code": "COI", "act_id": "AC_CEN_COI", "title": "The Constitution of India", "year": 1950, "status": "in_force", "dataset": DATASET_COI, "expected": 395,
            "url": "https://www.legislative.gov.in/static/uploads/2025/07/359f70a69695affb9d72f8393102bd2e.pdf"}
IPC_META = {"code": "IPC", "act_id": "AC_CEN_IPC_1860", "title": "The Indian Penal Code, 1860", "year": 1860, "status": "repealed", "expected": 511,
            "dataset": "WIPO Lex copy of the Indian Penal Code, 1860 (WIPO Lex IN057)", "url": "https://www.wipo.int/wipolex/en/legislation/details/7668"}
IEA_META = {"code": "IEA", "act_id": "AC_CEN_IEA_1872", "title": "The Indian Evidence Act, 1872", "year": 1872, "status": "repealed", "expected": 167,
            "dataset": "WIPO Lex copy of the Indian Evidence Act, 1872, amended up to Act 34 of 2019 (WIPO Lex IN162)", "url": "https://www.wipo.int/wipolex/en/legislation/details/22985"}


def main(crpc_txt, coi_txt, ipc_txt, iea_txt, out_dir):
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    report = []
    jobs = (("CRPC", crpc, crpc_txt), ("COI", lambda t: inline_headings(t, COI_META), coi_txt),
            ("IPC", lambda t: inline_headings(t, IPC_META), ipc_txt), ("IEA", lambda t: inline_headings(t, IEA_META), iea_txt))
    for code, fn, src in jobs:
        recs, expected = fn(Path(src).read_text(encoding="utf-8", errors="replace"))
        recs.sort(key=lambda r: (int(re.match(r"\d+", r["section_num"]).group()), r["section_num"]))
        with open(out / f"{code}.jsonl", "w", encoding="utf-8") as f:
            for r in recs:
                f.write(json.dumps(r, ensure_ascii=False) + "\n")
        nums = {int(r["section_num"]) for r in recs if r["section_num"].isdigit()}
        missing = [n for n in range(1, expected + 1) if n not in nums]
        report.append(f"{code:5} {len(recs):4} records; numbers 1..{expected} with no record: {len(missing)}{' -> ' + ','.join(map(str, missing)) if missing else ''}")
        print(report[-1])
    (out / "REPORT.txt").write_text("\n".join(report) + "\n", encoding="utf-8")


if __name__ == "__main__":
    if len(sys.argv) != 6:
        sys.exit(__doc__)
    main(*sys.argv[1:])
