#!/usr/bin/env python3
import array
import calendar
import json
import math
import os
import re
import select
import shutil
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("PORT", "9310"))
CALL_TARGETS = [t.strip() for t in os.environ.get("CALL_TARGETS", "").split(",") if t.strip()]
WATCHDOG_TIMEOUT = int(os.environ.get("WATCHDOG_TIMEOUT", "600"))
CALL_COOLDOWN = int(os.environ.get("CALL_COOLDOWN", "900"))
CALL_RING_TIMEOUT = int(os.environ.get("CALL_RING_TIMEOUT", "45"))
REGISTER_TIMEOUT = int(os.environ.get("REGISTER_TIMEOUT", "15"))
ICE_TIMEOUT = int(os.environ.get("ICE_TIMEOUT", "40"))
HC_PING_URL = os.environ.get("HC_PING_URL", "")
VM_URL = os.environ.get("VM_URL", "").rstrip("/")
PIPER_PYTHON = os.environ.get("PIPER_PYTHON", "/opt/piper/venv/bin/python")
PIPER_VOICE = os.environ.get("PIPER_VOICE", "de_DE-thorsten-high")
PIPER_DIR = os.environ.get("PIPER_DIR", "/opt/piper")
BARESIP_BIN = os.environ.get("BARESIP_BIN", "baresip")
BARESIP_SOURCE_DIR = os.environ.get("BARESIP_CONFIG", "/etc/alert-caller/baresip")
STATE_DIR = os.environ.get("STATE_DIRECTORY", "/var/lib/alert-caller")
RUNTIME_DIR = os.environ.get("RUNTIME_DIRECTORY", "/run/alert-caller")
SIP_USER = os.environ.get("SIP_USER", "")
SIP_DOMAIN = os.environ.get("SIP_DOMAIN", "sip.linphone.org")
SIP_PASSWORD = os.environ.get("SIP_PASSWORD", "")
SIP_STUN_SERVER = os.environ.get("SIP_STUN_SERVER", "stun.cloudflare.com:3478")
SIP_MEDIA_ENCRYPTION = os.environ.get("SIP_MEDIA_ENCRYPTION", "")

MAX_SPOKEN_ALERTS = 3
WAV_HEADER_BYTES = 44
HANGUP_GRACE = 3
COOLDOWN_SLACK = 30
MAX_BODY = 1024 * 1024
CONTEXT_TIMEOUT = 3

SPOKEN_NAMES = {
    "vereinsheim-alarmmonitor": "Alarmmonitor im Vereinsheim",
    "100.123.214.4": "Alarmmonitor im Vereinsheim",
    "homeserver": "Homeserver",
    "192.168.178.94": "Homeserver",
    "worker-0": "Worker null",
    "192.168.178.95": "Worker null",
    "worker-1": "Worker eins",
    "192.168.178.96": "Worker eins",
    "ugreen-nas": "NAS",
    "192.168.178.97": "NAS",
    "infotafel": "Infotafel",
    "192.168.178.98": "Infotafel",
    "prod-vm": "Produktiv V M",
    "192.168.178.99": "Produktiv V M",
    "entw-vm": "Entwicklungs V M",
    "192.168.178.100": "Entwicklungs V M",
}

SPOKEN_REASONS = {
    "OOMKilled": "Arbeitsspeicher voll",
    "Error": "Programmfehler",
    "ContainerCannotRun": "Container startet nicht",
    "CrashLoopBackOff": "dauernde Neustarts",
    "DeadlineExceeded": "Zeitlimit überschritten",
    "Evicted": "vom Knoten verdrängt",
    "Completed": "regulär beendet",
    "Unknown": "unbekannt",
}

HOST_PORT = re.compile(r"\b([A-Za-z][A-Za-z0-9._-]*|\d{1,3}(?:\.\d{1,3}){3}):\d{2,5}\b")
SEPARATOR = re.compile(r"(?<=[A-Za-z0-9])[-_](?=[A-Za-z0-9])")
TIMESTAMP = re.compile(r"(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(\.\d+)?(Z|[+-]\d\d:\d\d)")
REGISTERED = re.compile(r"\{\d+/\w+/\w*[46]\} 2\d\d ")
REGISTER_FAILED = re.compile(r"reg: \S+ \(prio \d+\): (?:[3-5]\d\d |Register:)")
CALL_ESTABLISHED = re.compile(r"Call established")
MEDIA_READY = re.compile(r"connectivity check is complete")
CALL_TERMINATED = re.compile(r"Call with \S+ terminated")
CALL_FAILED = re.compile(r"ua_connect failed")

CALL_LOCK = threading.Lock()
STATE_LOCK = threading.Lock()
STATE = {"last_watchdog": time.time(), "watchdog_alerted": False, "groups": {}}
BARESIP_DIR = os.path.join(RUNTIME_DIR, "baresip")


def log(msg):
    print(f"alert-caller: {msg}", file=sys.stderr, flush=True)


def render_account():
    line = f"<sip:{SIP_USER}@{SIP_DOMAIN};transport=tls>;auth_pass={SIP_PASSWORD};medianat=ice;stunserver=stun:{SIP_STUN_SERVER}"
    if SIP_MEDIA_ENCRYPTION:
        line += f";mediaenc={SIP_MEDIA_ENCRYPTION}"
    return f"{line};regint=600\n"


def prepare_baresip_dir():
    os.makedirs(BARESIP_DIR, exist_ok=True)
    shutil.copyfile(os.path.join(BARESIP_SOURCE_DIR, "config"), os.path.join(BARESIP_DIR, "config"))
    accounts = os.path.join(BARESIP_DIR, "accounts")
    if SIP_PASSWORD:
        with open(accounts, "w", encoding="utf-8") as handle:
            handle.write(render_account())
    else:
        shutil.copyfile(os.path.join(BARESIP_SOURCE_DIR, "accounts"), accounts)
    os.chmod(accounts, 0o600)


def pronounce(text):
    text = HOST_PORT.sub(r"\1", text)
    for key in sorted(SPOKEN_NAMES, key=len, reverse=True):
        text = re.sub(rf"(?<![\w.-]){re.escape(key)}(?![\w-])", SPOKEN_NAMES[key], text, flags=re.IGNORECASE)
    for key, spoken in SPOKEN_REASONS.items():
        text = re.sub(rf"\b{key}\b", spoken, text)
    text = SEPARATOR.sub(" ", text)
    return re.sub(r"\s+", " ", text).strip()


def parse_time(value):
    match = TIMESTAMP.fullmatch(value or "")
    if not match:
        return None
    year, month, day, hour, minute, second = (int(match.group(i)) for i in range(1, 7))
    stamp = calendar.timegm((year, month, day, hour, minute, second))
    zone = match.group(8)
    if zone != "Z":
        sign = 1 if zone[0] == "+" else -1
        stamp -= sign * (int(zone[1:3]) * 3600 + int(zone[4:6]) * 60)
    return stamp


def since_text(starts_at):
    stamp = parse_time(starts_at)
    if stamp is None:
        return ""
    minutes = max(0, int((time.time() - stamp) // 60))
    if minutes < 1:
        return "seit weniger als einer Minute"
    if minutes == 1:
        return "seit einer Minute"
    if minutes < 60:
        return f"seit {minutes} Minuten"
    hours = minutes // 60
    if hours == 1:
        return "seit einer Stunde"
    if hours < 48:
        return f"seit {hours} Stunden"
    return f"seit {hours // 24} Tagen"


def spoken_number(value):
    if abs(value) >= 10:
        return str(int(round(value)))
    rounded = round(value, 1)
    if rounded == int(rounded):
        return str(int(rounded))
    return str(rounded).replace(".", ",")


def lookup(alert, name):
    return alert.get("annotations", {}).get(name) or alert.get("labels", {}).get(name) or ""


def query_context(alert):
    query = lookup(alert, "kontext")
    template = lookup(alert, "kontext_text")
    if not VM_URL or not query or not template or "{}" not in template:
        return ""
    try:
        url = f"{VM_URL}/api/v1/query?{urllib.parse.urlencode({'query': query})}"
        with urllib.request.urlopen(url, timeout=CONTEXT_TIMEOUT) as response:
            value = float(json.load(response)["data"]["result"][0]["value"][1])
        if not math.isfinite(value):
            return ""
        return template.replace("{}", spoken_number(value))
    except Exception as exc:
        log(f"context query skipped: {exc}")
        return ""


def describe(alert):
    headline = lookup(alert, "ansage") or lookup(alert, "summary") or lookup(alert, "alertname") or "Unbekannter Alarm"
    since = since_text(alert.get("startsAt"))
    sentence = pronounce(headline).rstrip(".")
    if since:
        sentence = f"{sentence}, {since}"
    parts = [f"{sentence}."]
    reason = lookup(alert, "grund")
    if reason:
        parts.append(f"Grund: {pronounce(reason).rstrip('.')}.")
    context = query_context(alert)
    if context:
        parts.append(pronounce(context))
    return " ".join(parts)


def build_announcement(alerts):
    ordered = sorted(alerts, key=lambda alert: alert.get("startsAt", ""))
    parts = ["Achtung, Cluster Alarm."]
    if len(ordered) > 1:
        parts.append(f"{len(ordered)} Probleme.")
    for alert in ordered[:MAX_SPOKEN_ALERTS]:
        parts.append(describe(alert))
    if len(ordered) > MAX_SPOKEN_ALERTS:
        parts.append(f"Und {len(ordered) - MAX_SPOKEN_ALERTS} weitere, Details in der Push Nachricht.")
    return " ".join(parts)


def wav_seconds(path):
    with wave.open(path) as handle:
        return handle.getnframes() / handle.getframerate()


def synthesize(text):
    raw = os.path.join(STATE_DIR, "raw.wav")
    pending = os.path.join(STATE_DIR, "msg.tmp.wav")
    message = os.path.join(STATE_DIR, "msg.wav")
    try:
        subprocess.run(
            [PIPER_PYTHON, "-m", "piper", "-m", PIPER_VOICE, "--data-dir", PIPER_DIR, "-f", raw, "--", text],
            check=True,
            timeout=120,
        )
        subprocess.run(
            ["sox", raw, "-r", "16000", "-c", "1", pending, "pad", "1.5", "1", "repeat", "2"],
            check=True,
            timeout=60,
        )
    except (subprocess.SubprocessError, OSError) as exc:
        log(f"speech synthesis failed, falling back to warning tone: {exc}")
        subprocess.run(
            ["sox", "-n", "-r", "16000", "-c", "1", pending, "synth", "0.5", "sine", "880", "pad", "1.5", "0.5", "repeat", "5"],
            check=True,
            timeout=60,
        )
    os.replace(pending, message)
    return wav_seconds(message)


def rx_peak(path):
    try:
        with open(path, "rb") as handle:
            data = handle.read()[WAV_HEADER_BYTES:]
        samples = array.array("h", data[: len(data) // 2 * 2])
        return max(map(abs, samples)) if samples else 0
    except OSError:
        return None


def send_dial(proc, uri):
    proc.stdin.write(f"/dial {uri}\n".encode())
    proc.stdin.flush()
    return time.monotonic()


def stop_process(proc):
    if proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()
    for stream in (proc.stdin, proc.stdout):
        try:
            stream.close()
        except OSError:
            pass


def dial(uri, seconds):
    limit = REGISTER_TIMEOUT + CALL_RING_TIMEOUT + ICE_TIMEOUT + int(seconds) + 5
    rx_path = os.path.join(STATE_DIR, "rx.wav")
    if os.path.exists(rx_path):
        os.remove(rx_path)
    log(f"calling {uri}")
    proc = subprocess.Popen(
        [BARESIP_BIN, "-f", BARESIP_DIR, "-t", str(limit)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    started = time.monotonic()
    dialed_at = None
    answered = False
    media_ready = False
    hangup_at = None
    output = ""
    deadline = started + limit + 15
    try:
        while time.monotonic() < deadline:
            now = time.monotonic()
            if hangup_at is not None and now >= hangup_at:
                break
            if dialed_at is None and now - started >= REGISTER_TIMEOUT:
                log("registration not confirmed in time, dialing anyway")
                dialed_at = send_dial(proc, uri)
            if dialed_at is not None and not answered and now - dialed_at >= CALL_RING_TIMEOUT:
                break
            ready, _, _ = select.select([proc.stdout], [], [], 1.0)
            if not ready:
                if proc.poll() is not None:
                    break
                continue
            chunk = os.read(proc.stdout.fileno(), 4096)
            if not chunk:
                break
            output = (output + chunk.decode("utf-8", "replace"))[-4000:]
            if dialed_at is None:
                if REGISTERED.search(output):
                    dialed_at = send_dial(proc, uri)
                elif REGISTER_FAILED.search(output):
                    break
                continue
            if not answered and CALL_ESTABLISHED.search(output):
                answered = True
                hangup_at = time.monotonic() + ICE_TIMEOUT + seconds + HANGUP_GRACE
                log(f"{uri} answered")
            if answered and not media_ready and MEDIA_READY.search(output):
                media_ready = True
                hangup_at = time.monotonic() + seconds + HANGUP_GRACE
                log(f"{uri} media ready, playing announcement")
            if CALL_TERMINATED.search(output) or CALL_FAILED.search(output):
                break
    finally:
        stop_process(proc)
    if answered:
        log(f"call to {uri} finished, rx.wav peak: {rx_peak(rx_path)}")
    else:
        tail = re.sub(r"\x1b\[[0-9;]*m", "", output).strip().splitlines()[-5:]
        log(f"{uri} not answered: {' | '.join(tail)}")
    return answered


def place_call(text_factory):
    with CALL_LOCK:
        try:
            text = text_factory()
            log(f"announcement: {text}")
            seconds = synthesize(text)
        except Exception as exc:
            log(f"could not prepare announcement: {exc}")
            return
        for uri in CALL_TARGETS:
            try:
                if dial(uri, seconds):
                    return
            except Exception as exc:
                log(f"call to {uri} failed: {exc}")
        log("no target answered")


def start_call(text_factory):
    threading.Thread(target=place_call, args=(text_factory,), daemon=True).start()


def handle_alert(payload):
    group_key = payload.get("groupKey", "")
    alerts = [a for a in payload.get("alerts", []) if a.get("status", "firing") == "firing"]
    if not alerts:
        return
    fingerprints = {a.get("fingerprint") or json.dumps(a.get("labels", {}), sort_keys=True) for a in alerts}
    now = time.time()
    with STATE_LOCK:
        for key in [k for k, v in STATE["groups"].items() if now - v["time"] > 86400]:
            del STATE["groups"][key]
        previous = STATE["groups"].get(group_key)
        if previous and now - previous["time"] < CALL_COOLDOWN - COOLDOWN_SLACK and fingerprints <= previous["fingerprints"]:
            log(f"group {group_key} in cooldown, no call")
            return
        STATE["groups"][group_key] = {"time": now, "fingerprints": fingerprints}
    log(f"group {group_key}: {len(alerts)} firing alert(s)")
    start_call(lambda: build_announcement(alerts))


def ping_healthcheck():
    if not HC_PING_URL:
        return
    try:
        urllib.request.urlopen(HC_PING_URL, timeout=10).close()
    except Exception as exc:
        log(f"healthcheck ping failed: {exc}")


def handle_watchdog():
    with STATE_LOCK:
        STATE["last_watchdog"] = time.time()
        recovered = STATE["watchdog_alerted"]
        STATE["watchdog_alerted"] = False
    if recovered:
        log("watchdog received again")
    threading.Thread(target=ping_healthcheck, daemon=True).start()


def watchdog_loop():
    minutes = WATCHDOG_TIMEOUT // 60
    while True:
        time.sleep(60)
        with STATE_LOCK:
            silent = time.time() - STATE["last_watchdog"]
            due = silent > WATCHDOG_TIMEOUT and not STATE["watchdog_alerted"]
            if due:
                STATE["watchdog_alerted"] = True
        if due:
            log(f"no watchdog for {int(silent)}s, calling")
            start_call(lambda: f"Achtung, Cluster Alarm. Der Cluster meldet sich seit über {minutes} Minuten nicht mehr.")


class Handler(BaseHTTPRequestHandler):
    server_version = "alert-caller/1.0"

    def _reply(self, status, body):
        data = body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0") or "0")
        if length > MAX_BODY:
            return self._reply(413, "body too large")
        raw = self.rfile.read(length) if length else b""
        if self.path == "/watchdog":
            handle_watchdog()
            return self._reply(200, "ok")
        if self.path == "/alert":
            try:
                payload = json.loads(raw or b"{}")
            except json.JSONDecodeError:
                return self._reply(400, "invalid json")
            handle_alert(payload)
            return self._reply(200, "ok")
        self._reply(404, "not found")

    def log_message(self, format, *args):
        pass


def main():
    if not CALL_TARGETS:
        log("CALL_TARGETS is empty")
        sys.exit(1)
    if SIP_PASSWORD and (not SIP_USER or re.search(r'[;"\s]', SIP_PASSWORD)):
        log("SIP_USER is empty or SIP_PASSWORD contains ; \" or whitespace")
        sys.exit(1)
    os.makedirs(STATE_DIR, exist_ok=True)
    prepare_baresip_dir()
    threading.Thread(target=watchdog_loop, daemon=True).start()
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    log(f"listening on :{PORT}, targets={CALL_TARGETS}, watchdog timeout {WATCHDOG_TIMEOUT}s")
    server.serve_forever()


if __name__ == "__main__":
    main()
