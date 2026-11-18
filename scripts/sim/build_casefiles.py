"""
Builds the hypothetical case files (FIR, statements, evidence, orders...) as real documents you can upload to the platform.

EVERY PERSON, COMPANY AND DOCUMENT IS INVENTED. Real places and real law only. Each page carries a small "hypothetical" footer.

Document kinds:
  pdf   a PDF with a real text layer (what most digital court papers are)
  scan_indic  the same, for Kannada or Hindi pages (uses the Windows Nirmala font)
  scan  an image-only PDF made from the text, slightly rotated and noisy (to test OCR)
  docx  a Word file (used for Kannada and Hindi, whose PDF text layers come out garbled with the fonts available here)

Body markup (plain text): a line starting "# " is a centred title, "## " a heading, a blank line ends a paragraph.

Usage:  python build_casefiles.py <out_dir>
"""
import gc
import html
import io
import random
import sys
import zipfile
from pathlib import Path

import pymupdf as fitz

sys.path.insert(0, str(Path(__file__).parent))
from casefile_data_a import CASES_A  # noqa: E402
from casefile_data_b import CASES_B  # noqa: E402
from casefile_data_c import CASES_C  # noqa: E402

CASES = CASES_A + CASES_B + CASES_C
FOOTER = "HYPOTHETICAL DOCUMENT FOR PLATFORM TESTING. All persons and events are invented."
CSS = """
body { font-family: serif; font-size: 11.5pt; line-height: 1.38; }
h1 { text-align: center; font-size: 14pt; margin: 4pt 0 10pt 0; }
h2 { font-size: 12pt; margin: 10pt 0 3pt 0; }
p { margin: 0 0 7pt 0; text-align: justify; }
"""


def blocks(body: str) -> list[str]:
    """Paragraph blocks, with every heading line ("# " or "## ") on its own, even with no blank line between it and the text."""
    lines: list[str] = []
    for line in body.strip().split("\n"):
        if line.startswith("# ") or line.startswith("## "):
            lines += ["", line, ""]
        else:
            lines.append(line)
    return [b.strip("\n") for b in "\n".join(lines).split("\n\n") if b.strip()]


def to_html(body: str) -> str:
    out = []
    for block in blocks(body):
        if block.startswith("# "):
            out.append(f"<h1>{html.escape(block[2:])}</h1>")
        elif block.startswith("## "):
            out.append(f"<h2>{html.escape(block[3:])}</h2>")
        else:
            out.append("<p>" + "<br/>".join(html.escape(l) for l in block.split("\n")) + "</p>")
    return "\n".join(out)


INDIC_CSS = "@font-face{font-family:nir;src:url(Nirmala.ttc)} body{font-family:nir;font-size:12.5pt}"


def render_pdf(body: str, path: Path, indic: bool = False) -> None:
    story = fitz.Story(html=to_html(body), user_css=CSS + (INDIC_CSS if indic else ""), archive=fitz.Archive("C:/Windows/Fonts") if indic else None)
    base = path.with_name(path.stem + ".base.pdf")
    writer = fitz.DocumentWriter(str(base))
    mediabox = fitz.paper_rect("a4")
    where = mediabox + (56, 56, -56, -64)
    more = 1
    while more:
        dev = writer.begin_page(mediabox)
        more, _ = story.place(where)
        story.draw(dev)
        writer.end_page()
    writer.close()
    del writer, dev, story  # release the file handles (Windows will not delete or reopen a file that is still held)
    gc.collect()
    # footer on every page, added after layout so it never pushes text around; saved as a new file
    doc = fitz.open(str(base))
    for i, page in enumerate(doc):
        page.insert_text((56, page.rect.height - 34), f"{FOOTER}  Page {i + 1} of {len(doc)}", fontsize=7.5, fontname="helv", color=(0.35, 0.35, 0.35))
    doc.save(str(path))
    doc.close()
    base.unlink()


def render_scan(body: str, path: Path, seed: int, indic: bool = False) -> None:
    """An image-only PDF: the pages are pictures, a little crooked and noisy, like a phone or office scan."""
    from PIL import Image, ImageFilter  # noqa: PLC0415

    tmp = path.with_suffix(".src.pdf")
    render_pdf(body, tmp, indic=indic)
    src = fitz.open(str(tmp))
    rnd = random.Random(seed)
    out = fitz.open()
    for page in src:
        pix = page.get_pixmap(dpi=170, colorspace=fitz.csGRAY)
        img = Image.frombytes("L", (pix.width, pix.height), pix.samples)
        img = img.rotate(rnd.uniform(-0.9, 0.9), expand=False, fillcolor=255, resample=Image.BICUBIC)
        px = img.load()
        for _ in range(int(pix.width * pix.height * 0.004)):  # light speckle
            x, y = rnd.randrange(pix.width), rnd.randrange(pix.height)
            px[x, y] = max(0, px[x, y] - rnd.randrange(40, 140))
        img = img.filter(ImageFilter.GaussianBlur(0.6))
        buf = io.BytesIO()
        img.save(buf, "JPEG", quality=72)
        new = out.new_page(width=page.rect.width, height=page.rect.height)
        new.insert_image(new.rect, stream=buf.getvalue())
    out.save(str(path))
    out.close()
    src.close()
    tmp.unlink()


def render_docx(body: str, path: Path) -> None:
    """A minimal, valid Word file: one paragraph per block, headings in bold."""

    def para(text: str, bold: bool = False, center: bool = False) -> str:
        lines = text.split("\n")
        rpr = "<w:rPr><w:b/></w:rPr>" if bold else ""
        runs = "".join(f'<w:r>{rpr}<w:t xml:space="preserve">{html.escape(l)}</w:t>{"<w:br/>" if i < len(lines) - 1 else ""}</w:r>' for i, l in enumerate(lines))
        jc = '<w:jc w:val="center"/>' if center else ""
        return f"<w:p><w:pPr>{jc}</w:pPr>{runs}</w:p>"

    paras = []
    for block in blocks(body):
        if block.startswith("# "):
            paras.append(para(block[2:], bold=True, center=True))
        elif block.startswith("## "):
            paras.append(para(block[3:], bold=True))
        else:
            paras.append(para(block))
    paras.append(para(FOOTER))
    document = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
        + "".join(paras)
        + '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr></w:body></w:document>'
    )
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
        z.writestr("_rels/.rels", '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
        z.writestr("word/document.xml", document)


README = """# Hypothetical case files for testing Lirava

Five invented cases. Every person, company, order and event is made up; only the courts, police stations and the law are real.

For each case, open its folder, **upload the numbered documents** (not TESTER-GUIDE.md) to a new case in the platform, and then ask
questions. TESTER-GUIDE.md in each folder lists questions to try, the right answers (taken from the text of the Acts loaded in the
library), the traps built into the case, and the past Supreme Court cases that are good authorities. Keep the guide to yourself while
you test, so you judge the platform's answers first.

| Folder | Case | Main issues |
|---|---|---|
| S1 | Murder: regular bail after 14 months | BNS 103; bail; BNSS 479 does not apply; hostile witness; delay |
| S2 | Cheating and forgery over a plot | BNS 318, 336, 340; anticipatory bail; BNSS 35 notice; Kannada draft |
| S3 | Cheque dishonour | NI Act 138-142; limitation by dates; jurisdiction; presumption; defence of defective goods |
| S4 | Caste abuse at a panchayat meeting | SC/ST Act 3(1)(r)(s); sections 18 and 18A; video evidence and BSA 63 |
| S5 | Three days' police detention | Habeas corpus; Articles 21 and 22; a back-dated FIR; Hindi explanation for the family |

Some documents are image-only scans, to test OCR. The Kannada and Hindi statements are Word files with a scanned copy.
"""


def main(out_dir: str) -> None:
    root = Path(out_dir)
    root.mkdir(parents=True, exist_ok=True)
    for case in CASES:
        folder = root / case["folder"]
        folder.mkdir(parents=True, exist_ok=True)
        for n, d in enumerate(case["docs"], 1):
            path = folder / d["file"]
            if d["kind"] == "pdf":
                render_pdf(d["body"], path)
            elif d["kind"] == "scan":
                render_scan(d["body"], path, seed=n * 7 + len(d["file"]))
            elif d["kind"] == "scan_indic":
                render_scan(d["body"], path, seed=n * 7 + len(d["file"]), indic=True)
            elif d["kind"] == "docx":
                render_docx(d["body"], path)
            else:
                raise SystemExit(f"unknown kind {d['kind']} for {d['file']}")
        (folder / "TESTER-GUIDE.md").write_text(case["guide"], encoding="utf-8")
        print(f"{case['folder']}: {len(case['docs'])} documents + TESTER-GUIDE.md")
    (root / "README.md").write_text(README, encoding="utf-8")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
