#!/usr/bin/env python3
# Managed by Ansible (power_agent role) — do not edit manually.
#
# Small privileged HTTP daemon that runs directly on the homeserver host
# (NOT inside the k8s cluster) and does the handful of things carplay-api's
# pod deliberately can't do for itself, because that pod runs unprivileged
# (see argocd/apps/workloads/carplay-api/values.yaml podSecurityContext): read/write
# the laptop's screen backlight over sysfs, send Wake-on-LAN magic packets,
# and SSH-poweroff worker-0/worker-1 using the same forced-command key
# cluster_power_manager already generates and worker-0/worker-1 already
# authorize for "sudo poweroff" — see docs/37-cluster-power-manager.md.
#
# Manual wake/poweroff here stamp/clear the same STATE_DIR/<name>.woke_at
# files cluster-power-manager.service reads for its own MIN_UPTIME_SECONDS
# gate, so a button tap in the app and the automatic load-based watchdog
# never fight each other (e.g. immediately shutting a worker back down
# right after the app woke it).
import hmac
import json
import os
import subprocess
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

TOKEN = os.environ["TOKEN"]
PORT = int(os.environ.get("PORT", "9101"))
BACKLIGHT_PATH = os.environ["BACKLIGHT_PATH"]
BACKLIGHT_MAX_PATH = os.environ["BACKLIGHT_MAX_PATH"]
BL_POWER_PATH = os.environ["BL_POWER_PATH"]
SSH_USER = os.environ["SSH_USER"]
SSH_KEY = os.environ["SSH_KEY"]
KUBECONFIG_PATH = os.environ["KUBECONFIG_PATH"]
STATE_DIR = os.environ["STATE_DIR"]
POWEROFF_BIN = os.environ.get("POWEROFF_BIN", "/usr/sbin/poweroff")

# TARGETS format: "name:ip:mac name:ip:mac ..." — same layout as
# cluster_power_manager's WORKERS env var (config.env.j2), so both configs
# can be eyeballed side by side.
TARGETS = {}
for entry in os.environ.get("TARGETS", "").split():
    name, ip, mac = entry.split(":", 2)
    TARGETS[name] = {"ip": ip, "mac": mac}

os.environ["KUBECONFIG"] = KUBECONFIG_PATH


def log(msg):
    print(f"power-agent: {msg}", file=sys.stderr, flush=True)


def read_brightness_percent():
    # bl_power is the backlight rail's own on/off switch, separate from the
    # brightness level — on this panel, a raw brightness of 0/1 out of
    # max_brightness is still clearly visible, so a blanked screen only
    # shows up here, not in the brightness ratio below.
    with open(BL_POWER_PATH) as f:
        if int(f.read().strip()) != 0:
            return 0
    with open(BACKLIGHT_PATH) as f:
        current = int(f.read().strip())
    with open(BACKLIGHT_MAX_PATH) as f:
        maximum = int(f.read().strip())
    if maximum <= 0:
        return 0
    return round(100 * current / maximum)


def write_brightness_percent(percent):
    with open(BACKLIGHT_MAX_PATH) as f:
        maximum = int(f.read().strip())
    raw = round(maximum * percent / 100)
    with open(BACKLIGHT_PATH, "w") as f:
        f.write(str(raw))
    # 0% needs bl_power=4 (FB_BLANK_POWERDOWN) to actually blank the panel —
    # brightness alone bottoms out well above black on this hardware. Any
    # other value re-enables the rail (bl_power=0) in case it was left off.
    with open(BL_POWER_PATH, "w") as f:
        f.write("4" if percent == 0 else "0")
    return round(100 * raw / maximum) if maximum > 0 else 0


def woke_at_path(name):
    return os.path.join(STATE_DIR, f"{name}.woke_at")


def wake_target(name):
    target = TARGETS[name]
    log(f"waking {name} ({target['mac']}) -- manual request via app")
    subprocess.run(["wakeonlan", target["mac"]], check=False, timeout=10)
    with open(woke_at_path(name), "w") as f:
        f.write(str(int(time.time())))


def poweroff_target(name):
    target = TARGETS[name]
    log(f"shutting down {name} -- manual request via app")
    subprocess.run(["kubectl", "cordon", name], check=False, timeout=30)
    subprocess.run(
        ["kubectl", "drain", name, "--ignore-daemonsets", "--delete-emptydir-data", "--timeout=120s"],
        check=False,
        timeout=140,
    )
    # Forced command on the target authorizes only "sudo poweroff" — the
    # actual argument passed over ssh is irrelevant, see
    # cluster_power_manager_target role.
    subprocess.run(
        [
            "ssh", "-i", SSH_KEY,
            "-o", "StrictHostKeyChecking=accept-new",
            "-o", "BatchMode=yes",
            "-o", "ConnectTimeout=5",
            f"{SSH_USER}@{target['ip']}", "true",
        ],
        check=False,
        timeout=15,
    )
    try:
        os.remove(woke_at_path(name))
    except FileNotFoundError:
        pass


def poweroff_self():
    # The confirmation-code check already happened in carplay-api before
    # this endpoint was ever called (see internal/handlers/power.go) — this
    # agent trusts its own bearer token as sufficient authorization at this
    # point. Popen (not run) so the HTTP response can still be written
    # before the machine actually goes down.
    log("shutting down homeserver itself -- confirmed request via app")
    subprocess.Popen([POWEROFF_BIN])


class Handler(BaseHTTPRequestHandler):
    server_version = "power-agent/1.0"

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

    def do_GET(self):
        if not self._authorized():
            return self._json(401, {"error": "invalid bearer token"})
        if self.path == "/brightness":
            try:
                return self._json(200, {"percent": read_brightness_percent()})
            except OSError as exc:
                return self._json(500, {"error": f"reading brightness: {exc}"})
        self._json(404, {"error": "not found"})

    def do_PUT(self):
        if not self._authorized():
            return self._json(401, {"error": "invalid bearer token"})
        if self.path == "/brightness":
            body = self._read_json_body()
            if body is None or "percent" not in body:
                return self._json(400, {"error": "percent is required"})
            percent = body["percent"]
            if not isinstance(percent, int) or isinstance(percent, bool) or not (0 <= percent <= 100):
                return self._json(400, {"error": "percent must be an integer 0-100"})
            try:
                return self._json(200, {"percent": write_brightness_percent(percent)})
            except OSError as exc:
                return self._json(500, {"error": f"writing brightness: {exc}"})
        self._json(404, {"error": "not found"})

    def do_POST(self):
        if not self._authorized():
            return self._json(401, {"error": "invalid bearer token"})

        if self.path == "/poweroff-self":
            poweroff_self()
            return self._json(200, {"status": "ok"})

        if self.path in ("/wake", "/poweroff"):
            body = self._read_json_body()
            if body is None or "target" not in body:
                return self._json(400, {"error": "target is required"})
            target = body["target"]
            if target not in TARGETS:
                return self._json(400, {"error": f"unknown target {target!r}"})
            try:
                (wake_target if self.path == "/wake" else poweroff_target)(target)
            except subprocess.SubprocessError as exc:
                return self._json(502, {"error": str(exc)})
            return self._json(200, {"status": "ok"})

        self._json(404, {"error": "not found"})

    def log_message(self, format, *args):
        log(format % args)


def main():
    os.makedirs(STATE_DIR, exist_ok=True)
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    log(f"listening on :{PORT}, targets={list(TARGETS)}")
    server.serve_forever()


if __name__ == "__main__":
    main()
