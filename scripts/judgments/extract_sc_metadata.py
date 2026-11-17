"""
Turns the Supreme Court of India judgment metadata (AWS Open Data) into one clean record per judgment, for the Lirava
legal library.

Source:  s3://indian-supreme-court-judgments/metadata/parquet/year=YYYY/metadata.parquet
         https://registry.opendata.aws/indian-supreme-court-judgments/   (public bucket, no sign-in)
Licence: the registry lists CC-BY-4.0 for the compilation; the judgments themselves are the Court's own. Keep the
         `dataset` and `licence` fields on every record. Whether the Court's terms allow storing full text in a
         commercial product is NOT settled: this script only reads metadata (names, dates, citations), not text.

What each record carries: parties, bench, decision date, the neutral citation ("2023 INSC 1043"), the Supreme Court
Reports citation ("[2023] 16 S.C.R. 872"), the CNR, and the file name of the judgment PDF. No SCC or AIR citation is in
this source, so those cannot be verified from it.

`languages` lists the official translations the Court publishes (ENG, HIN, MAR, KAN, TAM, TEL ...), so the library can say
which judgments have one. Translations are for information only; the English text is the authority.

The files repeat some rows exactly (about 5,200 of 43,600). Rows are keyed by the judgment's PDF path and kept once.

Usage:  python extract_sc_metadata.py <dir with the year files, named m<year>.parquet> <out_dir>
Output: <out_dir>/sc.jsonl  and  <out_dir>/REPORT.txt
"""
import glob
import json
import re
import sys
from collections import Counter
from datetime import datetime
from pathlib import Path

import pyarrow.parquet as pq

COLS = ["title", "petitioner", "respondent", "judge", "citation", "case_id", "cnr", "decision_date", "disposal_nature", "path", "year", "court", "available_languages"]
NEUTRAL = re.compile(r"^\d{4} INSC \d{1,5}$")
SCR = re.compile(r"^\[\d{4}\] (?:SUPP\. )?\d{1,3} S\.C\.R\. \d{1,5}$")


def squash(s: str) -> str:
    return re.sub(r"\s+", " ", (s or "").replace("�", " ")).strip()


def iso(d: str) -> str:
    try:
        return datetime.strptime(d.strip(), "%d-%m-%Y").date().isoformat()
    except ValueError:
        return ""


def main(src: str, out_dir: str) -> None:
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    seen: dict[str, dict] = {}
    raw_rows = 0
    repeats = 0
    odd = Counter()
    for f in sorted(glob.glob(str(Path(src) / "m*.parquet"))):
        for r in pq.read_table(f, columns=COLS).to_pylist():
            raw_rows += 1
            path = squash(r["path"])
            if not path:
                odd["no pdf path"] += 1
                continue
            if path in seen:
                repeats += 1
                continue
            title = squash(r["title"])
            title = re.sub(r"\s+versus\s+", " v. ", title, flags=re.I)
            neutral = squash(r["case_id"])
            scr = squash(r["citation"]).upper()
            if neutral and not NEUTRAL.match(neutral):
                odd["unexpected neutral citation"] += 1
                neutral = ""
            if not SCR.match(scr):
                odd["unexpected SCR citation"] += 1
                scr = ""
            if not neutral and not scr:
                odd["no usable citation"] += 1
                continue
            if not title:
                odd["no title"] += 1
                continue
            date = iso(r["decision_date"] or "")
            year = int(date[:4]) if date else (int(r["year"]) if str(r["year"]).isdigit() else None)
            if not year:
                odd["no year"] += 1
                continue
            seen[path] = {
                "id": "scj:" + path,
                "title": title,
                "petitioner": squash(r["petitioner"]),
                "respondent": squash(r["respondent"]),
                "court": "Supreme Court of India",
                "year": year,
                "decision_date": date,
                "bench": squash(r["judge"]),
                "disposal": squash(r["disposal_nature"]),
                "neutral_citation": neutral,
                "scr_citation": scr,
                "languages": [l for l in dict.fromkeys(x.strip().upper() for x in (r["available_languages"] or "").split(",")) if l],
                "cnr": squash(r["cnr"]),
                "pdf_path": path,
                "dataset": "indian-supreme-court-judgments (AWS Open Data, metadata/parquet)",
                "licence": "CC-BY-4.0 (compilation); judgment text not stored",
            }
    recs = sorted(seen.values(), key=lambda r: (r["year"], r["decision_date"], r["id"]))
    with open(out / "sc.jsonl", "w", encoding="utf-8") as fh:
        for rec in recs:
            fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
    no_neutral = sum(1 for r in recs if not r["neutral_citation"])
    per_neutral = Counter(r["neutral_citation"] for r in recs if r["neutral_citation"])
    shared = sum(1 for v in per_neutral.values() if v > 1)
    lines = [
        f"rows read: {raw_rows}",
        f"judgments kept: {len(recs)} (exact repeats dropped: {repeats})",
        f"without a neutral citation: {no_neutral}",
        f"neutral citations shared by more than one judgment: {shared}",
        f"set aside: {dict(odd)}",
        f"years: {recs[0]['year']}..{recs[-1]['year']}",
    ]
    (out / "REPORT.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("\n".join(lines))


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
