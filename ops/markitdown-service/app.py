#!/usr/bin/env python3
"""Lirava document conversion service: turns a Word, PowerPoint, Excel, HTML, EPUB, CSV, JSON or XML file into Markdown
with Microsoft MarkItDown, keeping headings, lists and tables.

    POST /convert      (Authorization: Bearer <MARKITDOWN_KEY>, X-Filename: <url-encoded name>, body = the file's bytes)
    -> { "markdown": "...", "warnings": [] }
    GET  /health       -> { "ok": true }

Each file is converted in its own short-lived process with memory and CPU limits and a hard time limit, so a broken or
hostile file can be killed without taking the service down. Nothing is stored: the temporary file is deleted at once.
Images and audio are refused (scans go to the OCR service). PDFs are refused too: they are read page by page elsewhere so
citations keep their page numbers.
"""
import hmac
import json
import os
import subprocess
import sys
import tempfile
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

KEY = os.environ.get("MARKITDOWN_KEY", "")
HOST = os.environ.get("MARKITDOWN_HOST", "127.0.0.1")
PORT = int(os.environ.get("MARKITDOWN_PORT", "8085"))
MAX_BYTES = 25 * 1024 * 1024
MAX_OUTPUT_CHARS = 3_000_000
JOB_TIMEOUT_S = int(os.environ.get("MARKITDOWN_TIMEOUT", "110"))
PARALLEL = int(os.environ.get("MARKITDOWN_PARALLEL", "2"))
ALLOWED = {".docx", ".pptx", ".xlsx", ".xls", ".csv", ".html", ".htm", ".epub", ".json", ".xml"}
WORKER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "worker.py")

if len(KEY) < 24:
    sys.exit("MARKITDOWN_KEY must be set (at least 24 characters).")

slots = threading.BoundedSemaphore(PARALLEL)


def limits():
    """Applied in the child process before it starts: 2 GB of memory, 100 s of CPU, no big files written."""
    import resource

    resource.setrlimit(resource.RLIMIT_AS, (2 * 1024**3, 2 * 1024**3))
    resource.setrlimit(resource.RLIMIT_CPU, (100, 100))
    resource.setrlimit(resource.RLIMIT_FSIZE, (200 * 1024**2, 200 * 1024**2))


def convert(path: str) -> dict:
    kwargs = {"preexec_fn": limits} if os.name == "posix" else {}
    proc = subprocess.run(
        [sys.executable, WORKER, path],
        capture_output=True,
        timeout=JOB_TIMEOUT_S,
        env={"PATH": os.environ.get("PATH", ""), "HOME": tempfile.gettempdir(), "PYTHONIOENCODING": "utf-8", "PYTHONPATH": os.environ.get("PYTHONPATH", "")},
        **kwargs,
    )
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.decode("utf-8", "replace").strip()[-300:] or f"converter exited {proc.returncode}")
    return json.loads(proc.stdout.decode("utf-8"))


class Handler(BaseHTTPRequestHandler):
    server_version = "lirava-markitdown"

    def log_message(self, fmt, *args):  # one line per request, never the file name or its content
        sys.stderr.write("%s %s\n" % (self.command, fmt % args if args else ""))

    def reply(self, status: int, body: dict):
        data = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def authorised(self) -> bool:
        header = self.headers.get("Authorization", "")
        token = header[7:] if header.startswith("Bearer ") else ""
        return hmac.compare_digest(token.encode(), KEY.encode())

    def do_GET(self):
        if self.path == "/health":
            return self.reply(200, {"ok": True})
        self.reply(404, {"error": "Not found"})

    def do_POST(self):
        if self.path != "/convert":
            return self.reply(404, {"error": "Not found"})
        if not self.authorised():
            return self.reply(401, {"error": "Unauthorised"})
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            return self.reply(400, {"error": "Bad Content-Length"})
        if length <= 0:
            return self.reply(400, {"error": "Send the file's bytes as the body."})
        if length > MAX_BYTES:
            return self.reply(413, {"error": "The file is larger than 25 MB."})
        name = urllib.parse.unquote(self.headers.get("X-Filename", ""))
        ext = os.path.splitext(name)[1].lower()
        if ext not in ALLOWED:
            return self.reply(415, {"error": "This file type is not converted here."})
        data = self.rfile.read(length)
        if not slots.acquire(blocking=False):
            return self.reply(503, {"error": "Busy. Try again shortly."})
        path = None
        try:
            fd, path = tempfile.mkstemp(suffix=ext, prefix="md-")
            with os.fdopen(fd, "wb") as f:
                f.write(data)
            result = convert(path)
            markdown = str(result.get("markdown", ""))[:MAX_OUTPUT_CHARS]
            self.reply(200, {"markdown": markdown, "warnings": result.get("warnings", [])[:10]})
        except subprocess.TimeoutExpired:
            self.reply(504, {"error": "The file took too long to convert."})
        except Exception as err:  # a file that cannot be converted is the caller's to handle, not a crash
            self.reply(422, {"error": f"Could not convert this file: {str(err)[:200]}"})
        finally:
            slots.release()
            if path and os.path.exists(path):
                os.remove(path)


if __name__ == "__main__":
    print(f"markitdown service on {HOST}:{PORT}", flush=True)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
