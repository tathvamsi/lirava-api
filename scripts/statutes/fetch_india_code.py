"""
Fetches the sections of central Acts from India Code (https://indiacode.gov.in, the Legislative Department's repository)
through its public JSON API, and writes one clean record per section in the shape scripts/ingest-statutes.ts reads.

Why this and not typing: every record carries its India Code URL and the date it was fetched. Nothing is written from memory.

The new India Code stores each section as its own item (collection SECTION) tied to its Act by `act_id`. Not every Act
survived the site's migration: this script reconciles what it got against the Act's own highest section number and
reports every number that has no item, so a gap is visible instead of silently verifying nothing.

Usage:  python fetch_india_code.py <out_dir> [CODE ...]      (no codes = all in ACTS)
Output: <out_dir>/<CODE>.jsonl  and  <out_dir>/REPORT.txt
"""
import hashlib
import html
import json
import re
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

API = "https://indiacode.gov.in/server/api"
PUBLISHER = "Legislative Department, Ministry of Law and Justice (India Code)"
DATASET = "indiacode.gov.in (DSpace API)"
LICENCE = "Government of India, India Code (reuse confirmed by the product owner 2026-11-18)"

# code -> (title as India Code spells it, year, expected highest plain section number, act status)
ACTS = {
    "CPC": ("The Code of Civil Procedure, 1908", 1908, 158, "in_force"),
    "SCST": ("The Scheduled Castes and the Scheduled Tribes (Prevention of Atrocities) Act, 1989", 1989, 23, "in_force"),
    "BNS": ("The Bharatiya Nyaya Sanhita, 2023", 2023, 358, "in_force"),
    "BNSS": ("The Bharatiya Nagarik Suraksha Sanhita, 2023", 2023, 531, "in_force"),
    "BSA": ("The Bharatiya Sakshya Adhiniyam, 2023", 2023, 170, "in_force"),
    "NDPS": ("The Narcotic Drugs and Psychotropic Substances Act, 1985", 1985, 83, "in_force"),
    "PMLA": ("The Prevention of Money-laundering Act, 2002", 2002, 75, "in_force"),
    "ITA": ("The Information Technology Act, 2000", 2000, 90, "in_force"),
    "NIA": ("The Negotiable Instruments Act, 1881", 1881, 148, "in_force"),
    "ICA": ("The Indian Contract Act, 1872", 1872, 238, "in_force"),
    "POCSO": ("The Protection of Children from Sexual Offences Act, 2012", 2012, 46, "in_force"),
    "PCA": ("The Prevention of Corruption Act, 1988", 1988, 31, "in_force"),
    # Repealed on 1 July 2024 but still governing earlier offences. They may not have survived India Code's migration.
    "IPC": ("The Indian Penal Code, 1860", 1860, 511, "repealed"),
    "IEA": ("The Indian Evidence Act, 1872", 1872, 167, "repealed"),
}


def get(url: str):
    last = None
    for attempt in range(4):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0", "Accept": "application/json"})
            return json.load(urllib.request.urlopen(req, timeout=90))
        except Exception as e:  # network hiccup or a 5xx: wait and try again
            last = e
            time.sleep(2 * (attempt + 1))
    raise RuntimeError(f"giving up on {url}: {last}")


def first(md: dict, key: str):
    return (md.get(key) or [{}])[0].get("value")


def search(query: str, size: int = 100):
    page = 0
    q = urllib.parse.quote(query)
    while True:
        d = get(f"{API}/discover/search/objects?query={q}&size={size}&page={page}&dsoType=ITEM")
        sr = d["_embedded"]["searchResult"]
        for o in sr["_embedded"]["objects"]:
            yield o["_embedded"]["indexableObject"]
        page += 1
        if page >= sr["page"]["totalPages"]:
            return


def plain(note: str) -> str:
    t = re.sub(r"<br\s*/?>", "\n", note or "", flags=re.I)
    t = re.sub(r"<hr[^>]*>", "\n", t, flags=re.I)
    t = re.sub(r"<[^>]+>", "", t)
    t = html.unescape(t).replace("\xa0", " ")
    t = re.sub(r"[ \t]+", " ", t)
    return re.sub(r"\n\s*\n+", "\n\n", t).strip()


def central_act_id(title: str) -> str | None:
    """The act_id of the CENTRAL Act item with exactly this title."""
    want = title.strip().lower()
    for it in search(f'dc.title:"{title}"'):
        md = it["metadata"]
        if first(md, "dc.identifier.collection") == "ACT" and first(md, "dc.identifier.state_name") == "CENTRAL" and (it["name"] or "").strip().lower().rstrip(".") == want:
            return first(md, "dc.identifier.act_id")
    return None


def main(out_dir: str, codes: list[str]) -> None:
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    fetched = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    report = []
    for code in codes or list(ACTS):
        title, year, expected_max, status = ACTS[code]
        act_id = central_act_id(title)
        if not act_id:
            report.append(f"{code:5} NOT FOUND: no central Act item titled '{title}' on India Code")
            print(report[-1], flush=True)
            continue
        by_sec: dict[str, dict] = {}
        empty, dup = [], []
        for it in search(f'dc.identifier.act_name:"{title}"'):
            md = it["metadata"]
            if first(md, "dc.identifier.collection") != "SECTION" or first(md, "dc.identifier.act_id") != act_id:
                continue
            num = str(first(md, "dc.identifier.section_number") or "").strip().upper()
            body = plain(first(md, "dc.identifier.section_page_note") or "")
            name = re.sub(r"\s+", " ", (it["name"] or "")).strip(" .")
            if not re.fullmatch(r"\d+[A-Z]{0,2}", num):
                continue  # Orders, Rules and schedule entries are not sections
            if len(body) < 25 or not name:
                empty.append(num)
                continue
            rec = {
                "act_code": code,
                "act_id": act_id,
                "act_title": title,
                "year": year,
                "act_status": status,
                "in_force": status == "in_force",
                "section_num": num,
                "title": name,
                "chapter": "",
                "text": body,
                "text_sha256": hashlib.sha256(body.encode("utf-8")).hexdigest(),
                "source_url": f"https://indiacode.gov.in/handle/{it['handle']}",
                "source_publisher": PUBLISHER,
                "dataset": DATASET,
                "licence": LICENCE,
                "fetched": fetched,
            }
            if num in by_sec:
                dup.append(num)
                if len(body) <= len(by_sec[num]["text"]):
                    continue  # keep the fuller copy
            by_sec[num] = rec
        recs = sorted(by_sec.values(), key=lambda r: (int(re.match(r"\d+", r["section_num"]).group()), r["section_num"]))
        with open(out / f"{code}.jsonl", "w", encoding="utf-8") as f:
            for r in recs:
                f.write(json.dumps(r, ensure_ascii=False) + "\n")
        nums = {int(r["section_num"]) for r in recs if r["section_num"].isdigit()}
        missing = [n for n in range(1, expected_max + 1) if n not in nums]
        report.append(
            f"{code:5} {len(recs):4} sections (act_id {act_id}); duplicates collapsed: {len(set(dup))}; empty/stub skipped: {len(set(empty))}"
            f"{' -> ' + ','.join(sorted(set(empty))) if empty else ''}; numbers 1..{expected_max} with no item: {len(missing)}"
            f"{' -> ' + ','.join(map(str, missing)) if missing else ''}"
        )
        print(report[-1], flush=True)
    (out / "REPORT.txt").write_text("\n".join(report) + "\n", encoding="utf-8")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2:])
