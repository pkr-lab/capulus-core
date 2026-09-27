#!/usr/bin/env python3
"""Promotion-Kette ENTW -> TECH -> PROD: Versionen nach bestandenem Gesundheits-Gate als PR uebernehmen.

Beschreibung, Betrieb, Voraussetzungen: docs/f-cicd-automatisierung/f00b0-promotion-chain.md

Stufen (--stage):
  entw  argocd/apps/entw/<app> -> erstes Ziel der App (tech, sonst prod). Gate: >= gates.entw_hours
        gesund auf ENTW (ArgoCD-Instanz auf entw-vm), neue Version dort ausgerollt, Smoke-Checks ok.
        PR wird bei tech optional automatisch gemergt (AUTOMERGE_TECH=true), bei prod nie.
  tech  argocd/apps/tech/<app> -> argocd/apps/prod/<app> (Apps, die in beiden existieren).
        Gate: >= gates.tech_hours gesund auf dem Hub-ArgoCD. PR wird nie automatisch gemergt.

Uebertragen werden nur Versionsfelder (promotelib: `image.tag`, Chart-Abhaengigkeiten), nie Hosts,
Replicas oder Templates. Ein Ziel, das juenger ist als die Quelle, wird nicht ueberschrieben (kein Downgrade).

Eingaben:
  --status entw=datei.json / hub=datei.json   ArgoCD-Anwendungsliste (API-Antwort oder `kubectl get applications -o json`)
  --argocd entw=URL / hub=URL                 stattdessen live abfragen (Token in ARGOCD_ENTW_TOKEN / ARGOCD_HUB_TOKEN)
Umgebung: PROMOTE_NOW (ISO-Zeit, fuer Tests), DRY_RUN=1 (keine `gh`-Aufrufe), AUTOMERGE_TECH,
          SMOKE_IP_ENTW / SMOKE_IP_TECH, GITHUB_STEP_SUMMARY, GITHUB_OUTPUT, GITHUB_REPOSITORY.
"""
import argparse
import json
import os
import shutil
import ssl
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime, timezone

import yaml

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import promotelib  # noqa: E402

ENVS = {
    "entw": {"ref": "origin/entw", "base": "argocd/apps/entw", "status": "entw", "app_name": "{app}"},
    "tech": {"ref": "origin/main", "base": "argocd/apps/tech", "status": "hub", "app_name": "{app}"},
    "prod": {"ref": "origin/main", "base": "argocd/apps/prod", "status": "hub", "app_name": "prod-{app}"},
}
DEFAULT_SMOKE_IP = {"entw": "192.168.178.100", "tech": "192.168.178.94"}
MAIN = "origin/main"


def git(*args, check=True, cwd=None) -> str:
    r = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True)
    if check and r.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)}: {r.stderr.strip()}")
    return r.stdout


def show(ref: str, path: str):
    r = subprocess.run(["git", "show", f"{ref}:{path}"], capture_output=True, text=True)
    return r.stdout if r.returncode == 0 else None


def list_apps(env: str) -> list:
    e = ENVS[env]
    r = subprocess.run(["git", "ls-tree", "-d", "--name-only", f"{e['ref']}:{e['base']}"], capture_output=True, text=True)
    return sorted(r.stdout.split()) if r.returncode == 0 else []


def app_files(env: str, app: str) -> set:
    e = ENVS[env]
    r = subprocess.run(["git", "ls-tree", "--name-only", f"{e['ref']}:{e['base']}/{app}"], capture_output=True, text=True)
    return set(r.stdout.split()) if r.returncode == 0 else set()


def introduced(ref: str, path: str, value: str):
    """(sha, zeitpunkt) des juengsten Commits auf dem ersten Elternpfad, der `value` in `path` hinzugefuegt/entfernt hat."""
    out = git("log", "-1", "--first-parent", "--format=%H %ct", "-S" + value, ref, "--", path, check=False).split()
    if len(out) == 2:
        return out[0], datetime.fromtimestamp(int(out[1]), tz=timezone.utc)
    return None


def is_ancestor(sha: str, rev: str):
    r = subprocess.run(["git", "merge-base", "--is-ancestor", sha, rev], capture_output=True)
    if r.returncode == 0:
        return True
    return False if r.returncode == 1 else None


def collect(env: str, app: str) -> dict:
    e = ENVS[env]
    out = {}
    for fname in promotelib.VERSION_FILES:
        text = show(e["ref"], f"{e['base']}/{app}/{fname}")
        if text is None:
            continue
        for fld in promotelib.version_fields(fname, text):
            out[(fname, fld.key)] = fld
    return out


@dataclass
class Change:
    file: str
    key: str
    old: str
    new: str
    sha: str
    at: datetime


@dataclass
class Item:
    app: str
    src: str
    dst: str
    changes: list = field(default_factory=list)
    skipped: list = field(default_factory=list)
    ok: bool = False
    reasons: list = field(default_factory=list)
    evidence: list = field(default_factory=list)
    result: str = ""


def diff_versions(src: str, dst: str, app: str):
    """Versionsfelder, deren Wert in `src` anders ist als in `dst` und die dort juenger sind."""
    sf, df = collect(src, app), collect(dst, app)
    dst_files = app_files(dst, app)
    vendored = "Chart.lock" in dst_files or "charts" in dst_files
    changes, skipped = [], []
    for key in sorted(set(sf) & set(df)):
        s, d = sf[key], df[key]
        if s.value == d.value:
            continue
        label = f"{key[0]}:{key[1]}"
        if key[0] == "Chart.yaml" and vendored:
            skipped.append(f"`{label}` {d.value} -> {s.value}: Ziel hat Chart.lock/charts (helm dependency update noetig, manuell)")
            continue
        s_at = introduced(ENVS[src]["ref"], f"{ENVS[src]['base']}/{app}/{key[0]}", s.value)
        if s_at is None:
            skipped.append(f"`{label}`: Herkunft der Quell-Version nicht in der Historie gefunden")
            continue
        d_at = introduced(ENVS[dst]["ref"], f"{ENVS[dst]['base']}/{app}/{key[0]}", d.value)
        if d_at is not None and s_at[1] <= d_at[1]:
            skipped.append(f"`{label}`: {dst} ({d.value}) ist neuer als {src} ({s.value}) - kein Downgrade")
            continue
        changes.append(Change(key[0], key[1], d.value, s.value, s_at[0], s_at[1]))
    return changes, skipped


def parse_ts(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def evaluate(item: Item, hours: float, now: datetime, statuses: dict) -> None:
    env = ENVS[item.src]
    status_map = statuses.get(env["status"])
    if status_map is None:
        item.reasons.append(f"ArgoCD `{env['status']}` nicht erreichbar oder kein Status geliefert")
        return
    name = env["app_name"].format(app=item.app)
    app = status_map.get(name)
    if app is None:
        item.reasons.append(f"Application `{name}` nicht in ArgoCD ({env['status']}) gefunden")
        return
    health = (app.get("health") or {}).get("status")
    sync = (app.get("sync") or {}).get("status")
    revision = (app.get("sync") or {}).get("revision")
    since = (app.get("health") or {}).get("lastTransitionTime")
    item.evidence.append(f"`{name}`: {health}/{sync}")
    if health != "Healthy":
        item.reasons.append(f"Health ist {health}, nicht Healthy")
    if sync != "Synced":
        item.reasons.append(f"Sync ist {sync}, nicht Synced")
    if since:
        age = (now - parse_ts(since)).total_seconds() / 3600
        item.evidence.append(f"gesund seit {age:.1f} h")
        if age < hours:
            item.reasons.append(f"erst {age:.1f} h gesund (Gate {hours:g} h)")
    else:
        item.reasons.append("ArgoCD liefert kein health.lastTransitionTime")
    newest = max(item.changes, key=lambda c: c.at)
    c_age = (now - newest.at).total_seconds() / 3600
    item.evidence.append(f"Version seit {c_age:.1f} h in {item.src} ({newest.sha[:7]})")
    if c_age < hours:
        item.reasons.append(f"Version erst seit {c_age:.1f} h in {item.src} (Gate {hours:g} h)")
    if revision:
        for chg in item.changes:
            contains = is_ancestor(chg.sha, revision)
            if contains is None:
                item.reasons.append(f"ausgerollte Revision {revision[:7]} unbekannt (Historie nicht vollstaendig geholt?)")
                break
            if not contains:
                item.reasons.append(f"`{chg.key}` noch nicht ausgerollt (Revision {revision[:7]} enthaelt {chg.sha[:7]} nicht)")
    else:
        item.reasons.append("ArgoCD liefert keine sync.revision")


def run_smoke(env: str, checks: list) -> list:
    """HTTP-Pruefungen via curl; gibt Fehlermeldungen zurueck (leer = alles ok)."""
    failures = []
    ip = os.environ.get(f"SMOKE_IP_{env.upper()}", DEFAULT_SMOKE_IP.get(env, ""))
    for chk in checks:
        url = chk["url"]
        want = int(chk.get("status", 200))
        cmd = ["curl", "-sk", "--max-time", str(chk.get("timeout", 15)), "-o", "-", "-w", "\n%{http_code}"]
        if ip:
            m = url.split("://", 1)
            scheme, rest = (m[0], m[1]) if len(m) == 2 else ("http", m[0])
            host = rest.split("/", 1)[0]
            hostname, _, port = host.partition(":")
            cmd += ["--resolve", f"{hostname}:{port or ('443' if scheme == 'https' else '80')}:{ip}"]
        r = subprocess.run(cmd + [url], capture_output=True, text=True)
        body, _, code = r.stdout.rpartition("\n")
        if r.returncode != 0 or not code.strip().isdigit():
            failures.append(f"Smoke {url}: keine Antwort (curl {r.returncode})")
        elif int(code) != want:
            failures.append(f"Smoke {url}: HTTP {code}, erwartet {want}")
        elif chk.get("contains") and chk["contains"] not in body:
            failures.append(f"Smoke {url}: Antwort enthaelt \"{chk['contains']}\" nicht")
    return failures


def plan(stage: str, cfg: dict, now: datetime, statuses: dict, smoke: bool) -> list:
    exclude = set(cfg.get("exclude") or [])
    gates = cfg.get("gates") or {}
    pairs = []
    if stage in ("entw", "all"):
        for app in list_apps("entw"):
            dst = next((e for e in ("tech", "prod") if app in list_apps(e)), None)
            if dst:
                pairs.append(("entw", dst, app))
    if stage in ("tech", "all"):
        prod = set(list_apps("prod"))
        pairs += [("tech", "prod", app) for app in list_apps("tech") if app in prod]
    items = []
    for src, dst, app in pairs:
        if app in exclude:
            continue
        changes, skipped = diff_versions(src, dst, app)
        if not changes and not skipped:
            continue
        item = Item(app=app, src=src, dst=dst, changes=changes, skipped=skipped)
        if not changes:
            item.reasons.append("nichts uebertragbar (siehe Hinweise)")
        else:
            hours = float(gates.get("entw_hours" if src == "entw" else "tech_hours", 24 if src == "entw" else 2))
            evaluate(item, hours, now, statuses)
            checks = ((cfg.get("smoke") or {}).get(app) or {}).get(src) or []
            if not item.reasons and checks and smoke:
                fails = run_smoke(src, checks)
                item.reasons += fails
                item.evidence.append(f"Smoke {len(checks)} Check(s): {'ok' if not fails else 'FEHLER'}")
            item.ok = not item.reasons
        items.append(item)
    return items


def gh(*args, dry: bool, check=True) -> str:
    if dry:
        print(f"[dry] gh {' '.join(args)[:160]}", file=sys.stderr)
        return ""
    r = subprocess.run(["gh", *args], capture_output=True, text=True)
    if check and r.returncode != 0:
        raise RuntimeError(f"gh {' '.join(args[:3])}: {r.stderr.strip()}")
    return r.stdout.strip()


def pr_body(item: Item) -> str:
    rows = "\n".join(f"| `{c.file}` | `{c.key}` | `{c.old}` | `{c.new}` |" for c in item.changes)
    ev = "\n".join(f"- {e}" for e in item.evidence)
    manual = (
        "**Merge = Rollout auf PROD (echte Nutzer).** Kein Auto-Merge: bitte pruefen und selbst mergen."
        if item.dst == "prod"
        else "TECH: Auto-Merge nach gruener CI ist nur aktiv, wenn `AUTOMERGE_TECH=true` gesetzt ist."
    )
    return (
        f"Automatisch erzeugt von der Promotion-Kette ({item.src} -> {item.dst}), nur Versionsfelder.\n\n"
        f"| Datei | Feld | vorher ({item.dst}) | nachher (aus {item.src}) |\n|---|---|---|---|\n{rows}\n\n"
        f"### Gate ({item.src})\n{ev}\n\n{manual}\n\n"
        "Details: docs/f-cicd-automatisierung/f00b0-promotion-chain.md"
    )


def execute(item: Item, dry: bool) -> None:
    branch = f"promote/{item.dst}-{item.app}"
    title = f"chore({item.app}): Version von {item.src} nach {item.dst} uebernehmen"
    wt = tempfile.mkdtemp(prefix="promote-wt-")
    try:
        git("worktree", "add", "-q", "--detach", wt, MAIN)
        paths = []
        for fname in sorted({c.file for c in item.changes}):
            rel = f"{ENVS[item.dst]['base']}/{item.app}/{fname}"
            full = os.path.join(wt, rel)
            with open(full, encoding="utf-8") as fh:
                text = fh.read()
            fields = promotelib.version_fields(fname, text)
            new = promotelib.replace_values(text, fields, {c.key: c.new for c in item.changes if c.file == fname})
            with open(full, "w", encoding="utf-8") as fh:
                fh.write(new)
            paths.append(rel)
        git("-C", wt, "add", "--", *paths)
        git(
            "-C", wt, "-c", "user.name=github-actions[bot]", "-c", "user.email=41898282+github-actions[bot]@users.noreply.github.com",
            "commit", "-q", "-m", title, "-m", "\n".join(f"{c.file} {c.key}: {c.old} -> {c.new}" for c in item.changes),
        )
        commit = git("-C", wt, "rev-parse", "HEAD").strip()
        tree = git("-C", wt, "rev-parse", "HEAD^{tree}").strip()
    finally:
        git("worktree", "remove", "--force", wt, check=False)
        shutil.rmtree(wt, ignore_errors=True)

    remote_tree = git("rev-parse", f"origin/{branch}^{{tree}}", check=False).strip()
    prs = []
    if not dry:
        out = gh("pr", "list", "--head", branch, "--state", "all", "--json", "number,state,url", dry=False)
        prs = json.loads(out or "[]")
    open_pr = next((p for p in prs if p["state"] == "OPEN"), None)
    closed = [p for p in prs if p["state"] == "CLOSED"]
    if remote_tree == tree and closed and not open_pr:
        item.result = f"abgelehnt ({closed[0]['url']}), gleiche Aenderung wird nicht erneut vorgeschlagen"
        return
    if remote_tree != tree:
        git("push", "--force", "origin", f"{commit}:refs/heads/{branch}")
    if open_pr:
        item.result = f"PR offen: {open_pr['url']}" + (" (aktualisiert)" if remote_tree != tree else "")
        return
    for name, color in (("promotion", "0e8a16"), (f"promote-{item.dst}", "1d76db")):
        gh("label", "create", name, "--color", color, "--description", "Promotion-Kette", dry=dry, check=False)
    url = gh(
        "pr", "create", "--base", "main", "--head", branch, "--title", title, "--body", pr_body(item),
        "--label", f"promotion,promote-{item.dst}", dry=dry,
    )
    item.result = f"PR erstellt: {url}" if url else "PR (Trockenlauf)"
    if item.dst == "tech" and os.environ.get("AUTOMERGE_TECH", "").lower() == "true" and url:
        gh("pr", "merge", url, "--auto", "--squash", dry=dry, check=False)
        item.result += " (Auto-Merge aktiviert)"


def summary(items: list, unreachable: list) -> str:
    lines = ["## Promotion-Kette", ""]
    if unreachable:
        lines += [f"**ArgoCD nicht erreichbar:** {', '.join(unreachable)} - Gates dieser Umgebung sind blockiert.", ""]
    if not items:
        lines.append("Keine Versionsunterschiede zwischen den Umgebungen - nichts zu tun.")
        return "\n".join(lines)
    lines += ["| App | Stufe | Aenderungen | Ergebnis |", "|---|---|---|---|"]
    for it in items:
        chg = "<br>".join(f"`{c.key}` {c.old} -> {c.new}" for c in it.changes) or "-"
        if not it.changes:
            state = "nichts zu uebertragen (siehe Hinweis)"
        else:
            state = (it.result or "bereit") if it.ok else "blockiert: " + "; ".join(it.reasons)
        lines.append(f"| {it.app} | {it.src} -> {it.dst} | {chg} | {state} |")
    for it in items:
        for s in it.skipped:
            lines.append(f"\n> {it.app} ({it.src} -> {it.dst}): {s}")
    return "\n".join(lines)


def load_status(path: str) -> dict:
    with open(path, encoding="utf-8") as fh:
        return index_items(json.load(fh))


def index_items(data: dict) -> dict:
    return {i["metadata"]["name"]: i.get("status", {}) for i in data.get("items", [])}


def fetch_argocd(url: str, token: str):
    req = urllib.request.Request(
        url.rstrip("/") + "/api/v1/applications"
        "?fields=items.metadata.name,items.status.health,items.status.sync.status,items.status.sync.revision",
        headers={"Authorization": f"Bearer {token}"},
    )
    ctx = ssl._create_unverified_context() if url.startswith("https") else None  # noqa: SLF001 - internes Netz
    try:
        with urllib.request.urlopen(req, timeout=20, context=ctx) as resp:
            return index_items(json.load(resp))
    except (urllib.error.URLError, OSError, ValueError) as exc:
        print(f"ArgoCD {url}: {exc}", file=sys.stderr)
        return None


def sticky_issue(unreachable: list, dry: bool) -> None:
    """Ein offenes Issue, solange ein ArgoCD nicht erreichbar ist; schliesst sich beim naechsten Erfolg."""
    title = "Promotion-Kette: ArgoCD nicht erreichbar"
    existing = gh("issue", "list", "--state", "open", "--label", "promotion-gate", "--json", "number", "--jq", ".[0].number", dry=dry, check=False)
    if unreachable and not existing:
        gh("label", "create", "promotion-gate", "--color", "d93f0b", "--description", "Promotion-Kette blockiert", dry=dry, check=False)
        body = (
            f"ArgoCD nicht erreichbar: {', '.join(unreachable)}. Die Gates dieser Umgebung sind blockiert, es wird nichts "
            "promotet. Pruefen: Tailscale-Verbindung/ACL, Token-Secrets, NodePort 30080 "
            "(docs/f-cicd-automatisierung/f00b0-promotion-chain.md#voraussetzungen). Schliesst sich selbst."
        )
        gh("issue", "create", "--label", "promotion-gate", "--title", title, "--body", body, dry=dry)
    elif not unreachable and existing:
        gh("issue", "close", existing, "--comment", "ArgoCD wieder erreichbar.", dry=dry, check=False)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--stage", choices=("entw", "tech", "all"), default="all")
    ap.add_argument("--config", default="argocd/promotion.yaml")
    ap.add_argument("--status", action="append", default=[], metavar="NAME=DATEI")
    ap.add_argument("--argocd", action="append", default=[], metavar="NAME=URL")
    ap.add_argument("--plan-only", action="store_true", help="nur planen: kein Push, keine PRs, keine Issues")
    ap.add_argument("--no-smoke", action="store_true")
    ap.add_argument("--no-fetch", action="store_true")
    args = ap.parse_args()

    now = datetime.fromisoformat(os.environ["PROMOTE_NOW"].replace("Z", "+00:00")) if os.environ.get("PROMOTE_NOW") else datetime.now(timezone.utc)
    dry = bool(os.environ.get("DRY_RUN")) or args.plan_only
    if not args.no_fetch:
        git("fetch", "-q", "origin", "+refs/heads/main:refs/remotes/origin/main", "+refs/heads/entw:refs/remotes/origin/entw", check=False)
        git("fetch", "-q", "origin", "+refs/heads/promote/*:refs/remotes/origin/promote/*", check=False)
    with open(args.config, encoding="utf-8") as fh:
        cfg = yaml.safe_load(fh) or {}

    statuses = {}
    for spec in args.status:
        name, _, path = spec.partition("=")
        statuses[name] = load_status(path)
    for spec in args.argocd:
        name, _, url = spec.partition("=")
        token = os.environ.get(f"ARGOCD_{name.upper()}_TOKEN", "")
        statuses[name] = fetch_argocd(url, token) if token else None
        if not token:
            print(f"ARGOCD_{name.upper()}_TOKEN fehlt", file=sys.stderr)
    wanted = {"entw": {"entw"}, "tech": {"hub"}, "all": {"entw", "hub"}}[args.stage]
    unreachable = sorted(n for n in wanted if n in statuses and statuses[n] is None)

    items = plan(args.stage, cfg, now, statuses, smoke=not args.no_smoke)
    if not args.plan_only:
        for it in items:
            if it.ok:
                try:
                    execute(it, dry)
                except RuntimeError as exc:
                    it.ok, it.reasons = False, [f"Fehler beim Erstellen des PR: {exc}"]
        if args.argocd:
            sticky_issue(unreachable, dry)

    text = summary(items, unreachable)
    print(text)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as fh:
            fh.write(text + "\n")
    if os.environ.get("GITHUB_OUTPUT"):
        with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as fh:
            fh.write(f"unreachable={','.join(unreachable)}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
