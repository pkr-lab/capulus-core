#!/usr/bin/env python3
import hmac
import json
import os
import ssl
import subprocess
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

TOKEN = os.environ["TOKEN"]
PORT = int(os.environ.get("PORT", "9102"))
BIND_ADDRESS = os.environ.get("BIND_ADDRESS", "0.0.0.0")
TLS_CERT = os.environ.get("TLS_CERT", "")
TLS_KEY = os.environ.get("TLS_KEY", "")
MAX_BODY = 4096
REQUEST_TIMEOUT = 10
WOL_SCRIPT = os.environ.get("WOL_SCRIPT", "/usr/local/bin/banana-pi-wol.sh")
ALIASES = {a for a in os.environ.get("ALIASES", "").split(",") if a}


def log(msg):
    print(f"banana-pi-wol-agent: {msg}", file=sys.stderr, flush=True)


class Handler(BaseHTTPRequestHandler):
    server_version = "banana-pi-wol-agent/1.0"
    timeout = REQUEST_TIMEOUT

    def _authorized(self):
        header = self.headers.get("Authorization", "")
        prefix = "Bearer "
        if not header.startswith(prefix):
            return False
        return hmac.compare_digest(header[len(prefix):], TOKEN)

    def _json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json_body(self):
        try:
            length = int(self.headers.get("Content-Length", "0") or "0")
        except ValueError:
            return None
        if length < 0 or length > MAX_BODY:
            return None
        if length == 0:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return None

    def do_POST(self):
        if not self._authorized():
            return self._json(401, {"error": "invalid bearer token"})
        if self.path != "/wol":
            return self._json(404, {"error": "not found"})

        body = self._read_json_body()
        if body is None or "target" not in body:
            return self._json(400, {"error": "target is required"})
        target = body["target"]
        if target not in ALIASES:
            return self._json(400, {"error": f"unknown target {target!r}"})

        log(f"waking {target} -- request via app")
        try:
            subprocess.run([WOL_SCRIPT, target], check=True, timeout=10)
        except subprocess.SubprocessError as exc:
            return self._json(502, {"error": str(exc)})
        return self._json(200, {"status": "ok"})

    def log_message(self, format, *args):
        log(format % args)


class TLSServer(ThreadingHTTPServer):
    tls_context = None

    def get_request(self):
        sock, addr = super().get_request()
        wrapped = self.tls_context.wrap_socket(sock, server_side=True, do_handshake_on_connect=False)
        return wrapped, addr

    def handle_error(self, request, client_address):
        exc = sys.exc_info()[1]
        log(f"connection from {client_address[0]} failed: {type(exc).__name__}: {exc}")


def main():
    if TLS_CERT and TLS_KEY:
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.minimum_version = ssl.TLSVersion.TLSv1_2
        context.load_cert_chain(TLS_CERT, TLS_KEY)
        server = TLSServer((BIND_ADDRESS, PORT), Handler)
        server.tls_context = context
        scheme = "https"
    else:
        server = ThreadingHTTPServer((BIND_ADDRESS, PORT), Handler)
        scheme = "http"
    log(f"listening on {scheme}://{BIND_ADDRESS}:{PORT}, aliases={sorted(ALIASES)}")
    server.serve_forever()


if __name__ == "__main__":
    main()
