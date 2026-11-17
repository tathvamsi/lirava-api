"""
Turns the Open India Law central-legislation file into one clean record per section, for the Lirava legal library.

Source:  https://huggingface.co/datasets/vaquill/open-india-law  (in_central_legislation.parquet)
Licence: CC BY 4.0 (Vaquill). The text itself is India Code (Legislative Department, Ministry of Law and Justice).
         Keep the attribution: every record carries `dataset`, `licence`, `source_url` and `source_publisher`.

The file stores long sections as several chunks (`..._s318_p0`, `_p1`, ...), each repeating a header, plus duplicate
variants (`_dN`) and sub-section copies (`..._s324_5`). This script keeps only the base chunks, puts the pieces of a
section back together in order, and takes the section title from the header.

Usage:  python extract_open_india_law.py <in_central_legislation.parquet> <out_dir>
Output: <out_dir>/<ACT>.jsonl  and  <out_dir>/REPORT.txt  (counts, and section numbers that are missing from the file)
"""
import hashlib
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

import pyarrow.parquet as pq

# dataset act_id -> (Lirava act code, expected highest plain section number or None)
ACTS = {
    "IND_central_20062": ("BNS", 358),
    "IND_central_20099": ("BNSS", 531),
    "IND_central_20063": ("BSA", 170),
    "IND_REP_659_1860": ("IPC", 511),
    "IND_REP_971_1872": ("IEA", 167),
    # Not loaded on purpose, checked against the file on 2026-11-17:
    #   CPC (IND_central_2191)  rows hold the 1908 Statement of Objects notes under the section numbers, not the sections.
    #   SC/ST Act (IND_central_1920)  17 of its 18 rows are 2-character stubs.
    # Both need another source before they can back a "verified" citation.
    "IND_central_2189": ("NIA", 148),
    "IND_central_2187": ("ICA", 238),
    "IND_central_1791": ("NDPS", 83),
    "IND_central_2036": ("PMLA", 75),
    "IND_central_2079": ("POCSO", 46),
    "IND_central_1558": ("PCA", 31),
    "IND_central_1999": ("ITA", 90),
}

CHUNK = re.compile(r"^(?P<act>.+?)_s(?P<sec>\d+[A-Za-z]*)(?:_p(?P<part>\d+))?$")
MIN_BODY_CHARS = 25
MAX_TITLE_CHARS = 160  # a longer "title" is body text that landed in the header
HEADER_TITLE = re.compile(r"\|\s*Section\s+(?P<num>[^:]+):\s*(?P<title>[^\n]*)")


def clean_title(raw: str) -> str:
    title = raw.split("**")[0]
    title = title.replace("�", " ").strip(" .—-")
    return re.sub(r"\s+", " ", title).strip()


FIRST_MARKER = re.compile(r"(?:^|\n|\*\*|_)[ \t]*(\d+[A-Za-z]{0,2})[ \t]*\.")


def starts_with_own_number(body: str, sec: str) -> bool:
    """
    A real section opens with its own number, e.g. '**103. Punishment for murder' or '65B. Admissibility', possibly
    after a chapter heading. When the first number the text announces is a different one (for example the text of 169
    stored under 170), the row is mis-mapped.
    """
    head = body[:500]
    m = FIRST_MARKER.search(head)
    if m:
        return m.group(1).upper() == sec.upper()
    return re.search(r"(?:^|[\s*_(\[])" + re.escape(sec) + r"\s*[.)—-]", body[:90], re.I) is not None


def title_from_body(body: str, sec: str) -> str:
    m = re.search(r"\*\*\s*" + re.escape(sec) + r"\s*\.\s*(.+?)(?:\*\*|\n)", body[:400], re.I)
    return clean_title(m.group(1)) if m else ""


def split_header(text: str):
    """The header is everything up to the first blank line; the body is the section text."""
    head, sep, body = text.partition("\n\n")
    return (head, body) if sep else ("", text)


def main(src: str, out_dir: str) -> None:
    rows = pq.read_table(src).to_pylist()
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)

    groups = defaultdict(list)  # (act_id, section_number) -> [(part, row)]
    for r in rows:
        if r["act_id"] not in ACTS:
            continue
        m = CHUNK.match(r["chunk_id"])
        if not m or m.group("act") != r["act_id"]:
            continue  # duplicate (_dN), sub-section copy (_sN_K) or schedule block (_bN)
        groups[(r["act_id"], r["section_number"].strip().upper())].append((int(m.group("part") or 0), r))

    report = []
    dropped_short = defaultdict(int)
    rejects = defaultdict(list)
    by_act = defaultdict(list)
    for (act_id, sec), parts in groups.items():
        parts.sort(key=lambda p: p[0])
        first = parts[0][1]
        head, _ = split_header(first["text"])
        t = HEADER_TITLE.search(head)
        title = clean_title(t.group("title")) if t else ""
        chapter = ""
        mc = re.search(r"^Chapter\s+[^:]+:\s*(.*?)\s*\|", head, re.M)
        if mc:
            chapter = re.sub(r"^#+\s*", "", mc.group(1)).strip()
        body = "\n\n".join(split_header(r["text"])[1].strip() for _, r in parts).strip()
        code = ACTS[act_id][0]
        if len(body) < MIN_BODY_CHARS:
            dropped_short[code] += 1  # a stub, not a section: never let it back a "verified" citation
            continue
        if len(title) > MAX_TITLE_CHARS or not title:
            title = title_from_body(body, sec) or title[:MAX_TITLE_CHARS].rstrip()
        if not title:
            rejects[code].append({"section_num": sec, "title": "", "text_start": body[:120]})
            continue
        if not starts_with_own_number(body, sec):
            # The text under this number does not open with that number (for example it is the Statement of Objects),
            # so the row is mis-mapped. Keep it aside for review; it is never loaded into the library.
            rejects[code].append({"section_num": sec, "title": title[:100], "text_start": body[:120]})
            continue
        by_act[code].append(
            {
                "act_code": code,
                "act_id": act_id,
                "act_title": first["title"],
                "year": int(first["year"]) if first["year"] else None,
                "act_status": first["act_status"],
                "in_force": bool(first["in_force"]),
                "section_num": sec,
                "title": title,
                "chapter": chapter,
                "text": body,
                "text_sha256": hashlib.sha256(body.encode("utf-8")).hexdigest(),
                "chunks": len(parts),
                "source_url": first["source_url"],
                "mirror_url": first["mirror_url"],
                "source_publisher": first["source_publisher"],
                "dataset": "vaquill/open-india-law (in_central_legislation.parquet)",
                "licence": "CC-BY-4.0",
            }
        )

    for act_id, (code, expected_max) in ACTS.items():
        recs = sorted(by_act.get(code, []), key=lambda r: (int(re.match(r"\d+", r["section_num"]).group()), r["section_num"]))
        with open(out / f"{code}.jsonl", "w", encoding="utf-8") as f:
            for rec in recs:
                f.write(json.dumps(rec, ensure_ascii=False) + "\n")
        nums = {int(r["section_num"]) for r in recs if r["section_num"].isdigit()}  # plain numbers only: 66B does not stand in for 66
        missing = [n for n in range(1, expected_max + 1) if n not in nums] if expected_max else []
        with open(out / f"{code}.rejects.jsonl", "w", encoding="utf-8") as f:
            for rec in rejects[code]:
                f.write(json.dumps(rec, ensure_ascii=False) + "\n")
        no_title = sum(1 for r in recs if not r["title"])
        long_title = sum(1 for r in recs if len(r["title"]) > MAX_TITLE_CHARS)
        report.append(
            f"{code:6} {len(recs):5} sections  (status: {recs[0]['act_status'] if recs else '-'}; no title: {no_title}; "
            f"rejected as mis-mapped: {len(rejects[code])}; stubs dropped: {dropped_short[code]}; "
            f"numbers 1..{expected_max} with no row: {len(missing)}{' -> ' + ','.join(map(str, missing)) if missing else ''})"
        )

    text = "\n".join(report) + "\n"
    (out / "REPORT.txt").write_text(text, encoding="utf-8")
    print(text)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
