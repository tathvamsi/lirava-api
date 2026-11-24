# Lirava document conversion service (MarkItDown)

Turns Word, PowerPoint, Excel, HTML, EPUB, CSV, JSON and XML files into Markdown (headings, lists and tables kept) so the
platform reads them faithfully and cheaply. PDFs are not converted here (they are read page by page so citations keep their
page numbers) and images go to the OCR service.

Safety: every file is converted in its own short-lived process with memory (2 GB), CPU (100 s) and time (110 s) limits; Office
and EPUB files that expand like a zip bomb are refused; plugins are off; nothing is stored. It listens on 127.0.0.1 only; the
Cloudflare tunnel is what reaches it.

## Install on the server (as the normal user, not root)

```bash
mkdir -p ~/markitdown-service && cd ~/markitdown-service
# copy app.py, worker.py, requirements.txt and markitdown-svc.service here, then:
python3 --version                          # needs Python 3.10 or newer
# Installed into a private folder: no venv package, no sudo, nothing system-wide is touched.
python3 -m pip install --target lib -r requirements.txt
printf 'MARKITDOWN_KEY=%s\n' "$(python3 -c 'import secrets;print(secrets.token_urlsafe(32))')" > ~/.markitdown.env
chmod 600 ~/.markitdown.env
mkdir -p ~/.config/systemd/user && cp markitdown-svc.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now markitdown-svc
curl -s localhost:8085/health              # {"ok": true}
```

## Reach it through the tunnel

Add an ingress rule to `~/.cloudflared/config.yml` above the catch-all, route the name, and restart the tunnel:

```yaml
  - hostname: md.edvols.in
    service: http://localhost:8085
```
```bash
cloudflared tunnel route dns lirava md.edvols.in
systemctl --user restart cloudflared-tunnel
```

## Turn it on in the API

Set in the API's environment (Vercel project `lirava-api`, and `.env` for local work). The key is the one in `~/.markitdown.env`.

```
MARKITDOWN_BASE_URL=https://md.edvols.in
MARKITDOWN_API_KEY=<the same key>
```

Leave `MARKITDOWN_BASE_URL` empty to switch it off: Word files are then read by the built-in reader and the other formats are
reported as unsupported, as before. If the service is down, uploads still work the same way.

## Try it

```bash
curl -s -X POST localhost:8085/convert -H "Authorization: Bearer $(cut -d= -f2 ~/.markitdown.env)" \
  -H "X-Filename: notice.docx" --data-binary @notice.docx
```
