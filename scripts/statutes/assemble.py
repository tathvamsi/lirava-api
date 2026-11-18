"""
Merges the statute sources into one set for scripts/ingest-statutes.ts, and says exactly what is still missing.

Priority per section, highest first:  India Code (data/statutes-ic)  >  official PDF text (data/statutes-pdf)  >  Open India Law (data/statutes).
A lower source only fills a section the higher ones do not have. Every record keeps its own `dataset` and `source_url`, so what a
verified section was checked against is always visible. Where two sources disagree on a section's title, the higher one wins and
the disagreement is counted in the report.

Usage:  python assemble.py <data_dir>          (reads <data_dir>/statutes-ic, statutes-pdf, statutes; writes <data_dir>/statutes-final)
"""
import json
import re
import sys
from pathlib import Path

# act code -> highest plain section/article number the Act has (omitted numbers inside that range are normal, e.g. repealed sections)
EXPECTED = {"BNS": 358, "BNSS": 531, "BSA": 170, "IPC": 511, "IEA": 167, "NIA": 148, "ICA": 238, "NDPS": 83, "PMLA": 75, "POCSO": 46, "PCA": 31, "ITA": 90, "CPC": 158, "SCST": 23, "CRPC": 484, "COI": 395}
SOURCES = [("India Code", "statutes-ic"), ("official PDF", "statutes-pdf"), ("Open India Law", "statutes")]


def norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", s.lower())


def load(path: Path) -> dict:
    out = {}
    if path.exists():
        for line in path.read_text(encoding="utf-8").splitlines():
            if line.strip():
                r = json.loads(line)
                out[r["section_num"]] = r
    return out


def main(data_dir: str) -> None:
    base = Path(data_dir)
    out = base / "statutes-final"
    out.mkdir(parents=True, exist_ok=True)
    report = []
    for code, expected in EXPECTED.items():
        merged, origin, conflicts = {}, {}, 0
        for label, folder in SOURCES:
            for num, rec in load(base / folder / f"{code}.jsonl").items():
                if num in merged:
                    if norm(merged[num]["title"]) != norm(rec["title"]):
                        conflicts += 1
                    continue
                merged[num] = rec
                origin[num] = label
        recs = sorted(merged.values(), key=lambda r: (int(re.match(r"\d+", r["section_num"]).group()), r["section_num"]))
        with open(out / f"{code}.jsonl", "w", encoding="utf-8") as f:
            for r in recs:
                f.write(json.dumps(r, ensure_ascii=False) + "\n")
        have = {int(n) for n in merged if n.isdigit()}
        missing = [n for n in range(1, expected + 1) if n not in have]
        by_src = {label: sum(1 for o in origin.values() if o == label) for label, _ in SOURCES}
        report.append(
            f"{code:5} {len(recs):4} records  from {', '.join(f'{k} {v}' for k, v in by_src.items() if v)}; title disagreements between sources: {conflicts}; "
            f"numbers 1..{expected} with no record: {len(missing)}{' -> ' + ','.join(map(str, missing)) if missing else ''}"
        )
        print(report[-1])
    (out / "REPORT.txt").write_text("\n".join(report) + "\n", encoding="utf-8")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
