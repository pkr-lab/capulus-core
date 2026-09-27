#!/usr/bin/env python3
"""Prueft ops/token-register.yaml: Pflichtfelder, Datumsformat, Vollstaendigkeit gegen die
SealedSecrets im Repo. Exit-Code 1 bei jedem Fehler. Beschreibung: docs/f-cicd-automatisierung/f0070-ci-lint.md
"""
import re
import subprocess
import sys

import yaml

REGISTER = "ops/token-register.yaml"
DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
KINDS = {"api-token", "auth-key", "password", "encryption-key", "ssh-key", "tunnel-credential", "certificate"}
MODES = {"auto", "scripted", "manual"}
LIVE_CHECKS = {"tailscale-device", "github-pat"}


def check_date(value, field, id_, problems):
    if value is None:
        return
    if not isinstance(value, str) or not DATE.match(value):
        problems.append(f"{id_}: {field} ist kein Datum (YYYY-MM-DD): {value!r}")


def check_entry(e, problems):
    id_ = e.get("id") or "<ohne id>"
    for field in ("id", "service", "kind", "stored_in", "rotation", "owner", "blast_radius"):
        if not e.get(field):
            problems.append(f"{id_}: Pflichtfeld fehlt: {field}")

    kind = e.get("kind")
    if kind is not None and kind not in KINDS:
        problems.append(f"{id_}: unbekannter kind: {kind!r} (erlaubt: {', '.join(sorted(KINDS))})")

    stored_in = e.get("stored_in")
    if stored_in is not None and not isinstance(stored_in, list):
        problems.append(f"{id_}: stored_in muss eine Liste sein")

    rotation = e.get("rotation") or {}
    if rotation.get("mode") not in MODES:
        problems.append(f"{id_}: rotation.mode fehlt oder unbekannt: {rotation.get('mode')!r} (erlaubt: {', '.join(sorted(MODES))})")
    if not rotation.get("runbook"):
        problems.append(f"{id_}: rotation.runbook fehlt")

    for field in ("issued", "expires"):
        check_date(e.get(field), field, id_, problems)

    max_age = e.get("max_age_days")
    if max_age is not None and (not isinstance(max_age, int) or isinstance(max_age, bool) or max_age <= 0):
        problems.append(f"{id_}: max_age_days muss eine positive Zahl sein: {max_age!r}")

    live_check = e.get("live_check")
    if live_check is not None and live_check not in LIVE_CHECKS:
        problems.append(f"{id_}: unbekannter live_check: {live_check!r} (erlaubt: {', '.join(sorted(LIVE_CHECKS))})")
    if live_check == "github-pat" and not e.get("live_check_env"):
        problems.append(f"{id_}: live_check github-pat verlangt live_check_env")
    if live_check == "tailscale-device" and not e.get("live_check_ref"):
        problems.append(f"{id_}: live_check tailscale-device verlangt live_check_ref")


def sealed_secret_files():
    out = subprocess.check_output(["git", "ls-files", "*.yaml", "*.yml"], text=True).split()
    files = []
    for f in out:
        if "/bootstrap" in f:
            continue
        with open(f, encoding="utf-8") as fh:
            if re.search(r"^kind:\s*SealedSecret\s*$", fh.read(), re.MULTILINE):
                files.append(f)
    return sorted(files)


def main() -> int:
    with open(REGISTER, encoding="utf-8") as fh:
        entries = yaml.safe_load(fh) or []

    problems = []
    seen_ids = set()
    referenced = set()
    for e in entries:
        check_entry(e, problems)
        id_ = e.get("id")
        if id_ in seen_ids:
            problems.append(f"{id_}: id mehrfach vergeben")
        seen_ids.add(id_)
        referenced.update(e.get("stored_in") or [])

    for f in sealed_secret_files():
        if f not in referenced:
            problems.append(f"SealedSecret ohne Register-Eintrag: {f}")

    for p in problems:
        print(p)
    print(f"{len(entries)} Eintraege, {len(sealed_secret_files())} SealedSecrets im Repo, {len(problems)} Probleme", file=sys.stderr)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
