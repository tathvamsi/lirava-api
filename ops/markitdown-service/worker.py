#!/usr/bin/env python3
"""Converts one file to Markdown with MarkItDown and prints {"markdown": ..., "warnings": [...]} as JSON.
Run by app.py in its own process with memory, CPU and time limits. Plugins are off."""
import json
import os
import sys
import zipfile

ZIP_BASED = {".docx", ".pptx", ".xlsx", ".epub"}
MAX_UNZIPPED = 300 * 1024 * 1024
MAX_RATIO = 200


def refuse_zip_bomb(path: str) -> None:
    """Word, PowerPoint, Excel and EPUB files are zip archives. One that expands to hundreds of megabytes is not a document."""
    with zipfile.ZipFile(path) as z:
        total = sum(info.file_size for info in z.infolist())
    packed = max(os.path.getsize(path), 1)
    if total > MAX_UNZIPPED or (total > 20 * 1024 * 1024 and total / packed > MAX_RATIO):
        raise ValueError("The file expands far more than a normal document does.")


def main() -> None:
    path = sys.argv[1]
    if os.path.splitext(path)[1].lower() in ZIP_BASED:
        refuse_zip_bomb(path)
    from markitdown import MarkItDown

    result = MarkItDown(enable_plugins=False).convert(path)
    text = getattr(result, "markdown", None) or getattr(result, "text_content", "") or ""
    sys.stdout.write(json.dumps({"markdown": text, "warnings": []}))


if __name__ == "__main__":
    try:
        main()
    except Exception as err:  # reported to app.py through stderr and the exit code
        sys.stderr.write(f"{type(err).__name__}: {err}")
        sys.exit(1)
