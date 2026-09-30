#!/usr/bin/env python3
"""本地静态页，并把 /api/chat 同源转发到 DeepSeek。"""

import json
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent
UPSTREAM = "https://api.deepseek.com/v1/chat/completions"
HOST = "127.0.0.1"
PORT = 8766


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
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length)
        headers = {"Content-Type": "application/json"}
        auth = self.headers.get("Authorization")
        if auth:
            headers["Authorization"] = auth
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
