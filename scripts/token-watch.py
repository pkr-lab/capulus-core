#!/usr/bin/env python3
"""Prueft Ablaufdaten aus ops/token-register.yaml, live wo eine API es hergibt, sonst aus
dem Register. Legt bei 60/30/14/7/1 Tagen ein Issue mit Label token-expiry an bzw.
kommentiert es bei jeder neu erreichten Schwelle, und schliesst es wieder, sobald ein
Token nicht mehr innerhalb von 60 Tagen faellig ist. Exit-Code 1, sobald ein Token unter
7 Tagen liegt (der Workflow-Lauf wird dadurch rot). Beschreibung:
docs/4-planung/40090-standby-cluster-ha-paar.md#ablaufüberwachung-token-watch
"""
import datetime
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request

import yaml

REGISTER = "ops/token-register.yaml"
THRESHOLDS = (60, 30, 14, 7, 1)
LABEL = "token-expiry"
MARKER = re.compile(r"<!-- token-watch:threshold=(\d+) -->")
TITLE_PREFIX = "Token laeuft ab: "


def gh(*args, check=True):
    r = subprocess.run(["gh", *args], capture_output=True, text=True)
    if check and r.returncode != 0:
        raise RuntimeError(f"gh {' '.join(args[:3])}: {r.stderr.strip()}")
    return r.stdout.strip()


def github_pat_expiry(token: str):
    req = urllib.request.Request("https://api.github.com/user", headers={"Authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            exp = resp.headers.get("github-authentication-token-expiration")
    except (urllib.error.URLError, OSError):
        return None
    if not exp:
        return None
    try:
        return datetime.datetime.strptime(exp.split(" ")[0], "%Y-%m-%d").date()
    except ValueError:
        return None


def tailscale_device_expiry(hostname: str):
    client_id = os.environ.get("TS_OAUTH_CLIENT_ID")
    client_secret = os.environ.get("TS_OAUTH_SECRET")
    if not client_id or not client_secret:
        return None
    try:
        token_req = urllib.request.Request(
            "https://api.tailscale.com/api/v2/oauth/token",
            data=f"client_id={client_id}&client_secret={client_secret}".encode(),
            method="POST",
        )
        with urllib.request.urlopen(token_req, timeout=15) as resp:
            access_token = json.load(resp)["access_token"]
        devices_req = urllib.request.Request(
            "https://api.tailscale.com/api/v2/tailnet/-/devices",
            headers={"Authorization": f"Bearer {access_token}"},
        )
        with urllib.request.urlopen(devices_req, timeout=15) as resp:
            devices = json.load(resp)["devices"]
    except (urllib.error.URLError, OSError, KeyError, ValueError):
        return None
    for d in devices:
        name = d.get("hostname") or d.get("name", "")
        if name == hostname or name.startswith(hostname + "."):
            if d.get("keyExpiryDisabled"):
                return "disabled"
            expires = d.get("expires")
            if expires and not expires.startswith("0001-01-01"):
                return datetime.datetime.strptime(expires[:10], "%Y-%m-%d").date()
            return None
    return None


def resolve_expiry(entry: dict):
    live = entry.get("live_check")
    if live == "github-pat":
        token = os.environ.get(entry.get("live_check_env", ""))
        if token:
            found = github_pat_expiry(token)
            if found:
                return found, "live: GitHub-API"
    elif live == "tailscale-device":
        found = tailscale_device_expiry(entry["live_check_ref"])
        if found == "disabled":
            return None, "live: Tailscale (Expiry deaktiviert)"
        if found:
            return found, "live: Tailscale-API"

    expires = entry.get("expires")
    if expires:
        return datetime.date.fromisoformat(expires), "Register (expires)"
    issued, max_age = entry.get("issued"), entry.get("max_age_days")
    if issued and max_age:
        return datetime.date.fromisoformat(issued) + datetime.timedelta(days=max_age), "Register (issued+max_age_days)"
    return None, None


def crossed_threshold(days_left: int):
    for t in THRESHOLDS:
        if days_left <= t:
            return t
    return None


def find_issue(title: str):
    out = gh("issue", "list", "--search", f'label:"{LABEL}" "{title}" in:title is:open', "--json", "number,body", check=False)
    issues = json.loads(out or "[]")
    return issues[0] if issues else None


def upsert_issue(entry: dict, days_left: int, threshold: int, source: str, expiry: datetime.date):
    title = f"{TITLE_PREFIX}{entry['id']}"
    detail = (
        f"**{days_left} Tage** bis zum Ablauf, faellig am {expiry.isoformat()} ({source}).\n\n"
        f"Runbook: {entry['rotation'].get('runbook', '-')}\n\nBlast Radius: {entry['blast_radius']}"
    )
    marker = f"<!-- token-watch:threshold={threshold} -->"
    existing = find_issue(title)
    if not existing:
        gh("label", "create", LABEL, "--color", "d93f0b", "--description", "Token laeuft bald ab", check=False)
        gh("issue", "create", "--label", LABEL, "--title", title, "--body", f"{detail}\n\n{marker}")
        return
    last = MARKER.search(existing.get("body") or "")
    last_threshold = int(last.group(1)) if last else None
    if last_threshold is None or threshold < last_threshold:
        gh("issue", "comment", str(existing["number"]), "--body", f"Schwelle {threshold} Tage erreicht: {detail}")
    gh("issue", "edit", str(existing["number"]), "--body", f"{detail}\n\n{marker}", check=False)


def close_recovered(due_ids: set):
    out = gh("issue", "list", "--state", "open", "--label", LABEL, "--json", "number,title", check=False)
    for issue in json.loads(out or "[]"):
        if not issue["title"].startswith(TITLE_PREFIX):
            continue
        id_ = issue["title"][len(TITLE_PREFIX):]
        if id_ not in due_ids:
            gh("issue", "close", str(issue["number"]), "--comment", "Nicht mehr innerhalb von 60 Tagen faellig (rotiert oder Ablaufdatum verlaengert).", check=False)


def main() -> int:
    with open(REGISTER, encoding="utf-8") as fh:
        entries = yaml.safe_load(fh) or []

    today = datetime.date.today()
    red = False
    due_ids = set()
    for entry in entries:
        expiry, source = resolve_expiry(entry)
        if expiry is None:
            print(f"{entry['id']}: kein Ablaufdatum bekannt ({source or 'issued/expires fehlen im Register'})")
            continue
        days_left = (expiry - today).days
        print(f"{entry['id']}: {days_left} Tage ({source}, faellig {expiry.isoformat()})")
        threshold = crossed_threshold(days_left)
        if threshold is not None:
            due_ids.add(entry["id"])
            upsert_issue(entry, days_left, threshold, source, expiry)
            if days_left <= 7:
                red = True

    close_recovered(due_ids)
    return 1 if red else 0


if __name__ == "__main__":
    sys.exit(main())
