"""
Downloads the Supreme Court's English judgment archives, one year at a time, and turns each PDF into a text file.

Source: the public bucket indian-supreme-court-judgments (AWS Open Data), data/tar/year=YYYY/english/english.tar.
The PDFs already carry a text layer (checked on 40 of the 782 from 2024: all had it), so no OCR is needed: pdftotext is enough.

One year at a time, so the disk never holds more than one archive (at most about 1.1 GB) plus its text. The tar and the PDFs are
deleted once the text is written. A year that is already done (its .done marker exists) is skipped, so the script can be stopped and
started again.

Usage:  python extract_text.py <out_dir> <first_year> <last_year>      (runs newest year first)
Output: <out_dir>/<year>/<pdf_path>.txt   with <pdf_path> as in the library's judgment ids (scj:<pdf_path>)
Needs:  pdftotext (poppler) on the PATH.
"""
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

BASE = "https://indian-supreme-court-judgments.s3.amazonaws.com/data/tar"


def download(url: str, dest: Path) -> int:
    last = None
    # A short network outage (name lookups failing, a dropped connection) should cost minutes, not a year of judgments:
    # wait longer after each failure, up to about ten minutes in all.
    for attempt in range(8):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"}), timeout=120) as r, open(dest, "wb") as f:
                shutil.copyfileobj(r, f, 1 << 20)
            return dest.stat().st_size
        except Exception as e:
            last = e
            time.sleep(min(15 * (attempt + 1), 120))
    raise RuntimeError(f"giving up on {url}: {last}")


def to_text(pdf: Path, out: Path) -> bool:
    r = subprocess.run(["pdftotext", "-layout", str(pdf), str(out)], capture_output=True, timeout=300)
    return r.returncode == 0 and out.exists() and out.stat().st_size > 0


def do_year(year: int, out_root: Path) -> str:
    out = out_root / str(year)
    marker = out / ".done"
    if marker.exists():
        return f"{year}: already done"
    out.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=f"sc{year}_") as tmp:
        tmp = Path(tmp)
        tar = tmp / "english.tar"
        size = download(f"{BASE}/year={year}/english/english.tar", tar)
        pdfs = tmp / "pdf"
        pdfs.mkdir()
        with tarfile.open(tar) as t:
            for m in t.getmembers():
                if m.isfile() and m.name.lower().endswith(".pdf") and "/" not in m.name.strip("/"):
                    m.name = Path(m.name).name  # never trust a path inside an archive
                    t.extract(m, pdfs)
        tar.unlink()
        files = sorted(pdfs.glob("*.pdf"))
        with ThreadPoolExecutor(max_workers=4) as pool:
            ok = list(pool.map(lambda p: to_text(p, out / (p.stem.removesuffix("_EN") + ".txt")), files))
    marker.write_text(f"{len(files)} pdfs, {sum(ok)} texts\n")
    return f"{year}: {sum(ok)}/{len(files)} texts from a {size / 1e6:.0f} MB archive"


def main(out_dir: str, first: int, last: int) -> None:
    root = Path(out_dir)
    for year in range(last, first - 1, -1):
        try:
            print(do_year(year, root), flush=True)
        except Exception as e:  # one bad year must not stop the rest; it is retried on the next run
            print(f"{year}: FAILED {e}", flush=True)


if __name__ == "__main__":
    if len(sys.argv) != 4:
        sys.exit(__doc__)
    main(sys.argv[1], int(sys.argv[2]), int(sys.argv[3]))
