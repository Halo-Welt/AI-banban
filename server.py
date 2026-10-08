#!/usr/bin/env python3
"""本地静态页。模型密钥只放在服务端，浏览器只访问 /api/chat。"""

import json
import os
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent
UPSTREAM = "https://api.deepseek.com/v1/chat/completions"
HOST = "127.0.0.1"
PORT = 8766


def load_env_file():
    path = ROOT / ".env"
    if not path.is_file():
        return
    for line in path.read_text().splitlines():
        text = line.strip()
        if not text or text.startswith("#") or "=" not in text:
            continue
        key, value = text.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


load_env_file()
API_KEY = os.environ.get("DEEPSEEK_API_KEY", "")


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def do_POST(self):
        if self.path.split("?", 1)[0] != "/api/chat":
            self.send_error(404)
            return
        if not API_KEY:
            payload = json.dumps({"error": "DEEPSEEK_API_KEY is not set"}).encode()
            self._send(503, payload)
            return
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length)
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {API_KEY}",
        }
        request = Request(UPSTREAM, data=body, headers=headers, method="POST")
        try:
            with urlopen(request, timeout=60) as response:
                self._send(response.status, response.read())
        except HTTPError as error:
            self._send(error.code, error.read())
        except URLError as error:
            payload = json.dumps({"error": str(error.reason)}).encode()
            self._send(502, payload)

    def _send(self, status, data):
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


if __name__ == "__main__":
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
