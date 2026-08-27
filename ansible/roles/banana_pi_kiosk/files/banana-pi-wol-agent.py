#!/usr/bin/env python3
# Managed by Ansible (banana_pi_kiosk role) — do not edit manually.
#
# Thin HTTP wrapper around banana-pi-wol.sh so the iOS app (or anything
# else on the tailnet) can trigger a Wake-on-LAN broadcast into this
# Pi's local Standort-LAN without an SSH session. Structurally mirrors
# power-agent.py (ansible/roles/power_agent/files/power-agent.py) but is
# otherwise unrelated: that one runs on the homeserver's LAN and is
# called by carplay-api's pod; this one runs on the Pi's Tailscale-only
# network and is called DIRECTLY by the iOS app, because carplay-api's
# pod has no route to Tailscale peers — see
# docs/4-planung/40020-vereinsheim-wol-router-vpn.md. No MAC knowledge of
# its own — target validity and MAC lookup both stay in banana-pi-wol.sh
# / banana_pi_kiosk_wol_devices, this only forwards the alias.
import hmac
import json
import os
import subprocess
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

TOKEN = os.environ["TOKEN"]
PORT = int(os.environ.get("PORT", "9102"))
WOL_SCRIPT = os.environ.get("WOL_SCRIPT", "/usr/local/bin/banana-pi-wol.sh")
ALIASES = {a for a in os.environ.get("ALIASES", "").split(",") if a}


def log(msg):
    print(f"banana-pi-wol-agent: {msg}", file=sys.stderr, flush=True)


class Handler(BaseHTTPRequestHandler):
    server_version = "banana-pi-wol-agent/1.0"

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
        length = int(self.headers.get("Content-Length", "0") or "0")
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


def main():
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    log(f"listening on :{PORT}, aliases={sorted(ALIASES)}")
    server.serve_forever()


if __name__ == "__main__":
    main()
