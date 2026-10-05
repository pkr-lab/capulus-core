#!/usr/bin/env python3
import json
import os
import re
import subprocess
import sys

LABEL = "security"
LABEL_COLOR = "b60205"
LABEL_DESCRIPTION = "Sicherheitsbefund (CodeQL, Dependabot)"
SEVERITIES = ("low", "medium", "high", "critical")
LEVEL_TO_SEVERITY = {"error": "high", "warning": "medium", "note": "low"}
KEY_MARKER = re.compile(r"<!-- security-issues:key=(\S+) -->")
ALERTS_MARKER = re.compile(r"<!-- security-issues:alerts=([0-9,]*) -->")
TITLE_PREFIX = "Security: "
DOC = "docs/d-sicherheit/d0080-codeql-dependabot.md"
MAX_ROWS = 50
SOURCE_CODE_SCANNING = "code-scanning"
SOURCE_DEPENDABOT = "dependabot"


class SourceError(Exception):
    pass


def dry_run():
    return os.environ.get("DRY_RUN") == "1"


def gh(*args, stdin=None, check=True):
    r = subprocess.run(["gh", *args], input=stdin, capture_output=True, text=True)
    if check and r.returncode != 0:
        raise RuntimeError(f"gh {' '.join(args[:3])}: {r.stderr.strip()}")
    return r


def gh_write(*args, stdin=None):
    if dry_run():
        print(f"  DRY_RUN: gh {' '.join(args)}")
        if stdin:
            print("    " + stdin.replace("\n", "\n    "))
        return
    gh(*args, stdin=stdin)


def gh_api_pages(path):
    r = gh("api", "--paginate", "--slurp", path, check=False)
    if r.returncode != 0:
        raise SourceError(r.stderr.strip() or f"gh api {path} fehlgeschlagen")
    return [item for page in json.loads(r.stdout or "[]") for item in page]


def severity_rank(severity):
    return SEVERITIES.index(severity) if severity in SEVERITIES else 0


def normalize_severity(value):
    value = (value or "").lower()
    if value == "moderate":
        return "medium"
    return value if value in SEVERITIES else "low"


def key_part(value):
    return re.sub(r"\s+", "-", str(value).strip()) or "unbekannt"


def cell(value):
    return str(value).replace("|", "\\|").replace("\r", " ").replace("\n", " ").strip()


def code_scanning_severity(alert):
    rule = alert.get("rule") or {}
    level = rule.get("security_severity_level")
    if level:
        return normalize_severity(level)
    return LEVEL_TO_SEVERITY.get(rule.get("severity"), "low")


def dependabot_severity(alert):
    advisory = alert.get("security_advisory") or {}
    vulnerability = alert.get("security_vulnerability") or {}
    return normalize_severity(advisory.get("severity") or vulnerability.get("severity"))


def fetch_code_scanning(repo):
    try:
        return gh_api_pages(f"repos/{repo}/code-scanning/alerts?state=open&per_page=100")
    except SourceError as e:
        if "no analysis found" in str(e).lower():
            print("code-scanning: noch keine Analyse hochgeladen, keine Alerts.")
            return []
        raise


def fetch_dependabot(repo):
    try:
        return gh_api_pages(f"repos/{repo}/dependabot/alerts?state=open&per_page=100")
    except SourceError as e:
        if "disabled" in str(e).lower():
            raise SourceError(
                f"{e} -- Dependabot alerts im Repo aktivieren: Settings -> Advanced Security -> Dependabot alerts ({DOC})"
            ) from e
        raise


def group_code_scanning(alerts):
    groups = {}
    for alert in alerts:
        rule = alert.get("rule") or {}
        tool = (alert.get("tool") or {}).get("name") or "code-scanning"
        rule_id = rule.get("id") or "unbekannt"
        key = f"{SOURCE_CODE_SCANNING}/{key_part(tool)}/{key_part(rule_id)}"
        group = groups.setdefault(key, {"key": key, "source": SOURCE_CODE_SCANNING, "tool": tool, "rule": rule, "alerts": []})
        group["alerts"].append(alert)
    for group in groups.values():
        group["alerts"].sort(key=lambda a: (-severity_rank(code_scanning_severity(a)), a.get("number", 0)))
        group["severity"] = max((code_scanning_severity(a) for a in group["alerts"]), key=severity_rank)
    return groups


def group_dependabot(alerts):
    groups = {}
    for alert in alerts:
        dependency = alert.get("dependency") or {}
        manifest = dependency.get("manifest_path") or "unbekannt"
        key = f"{SOURCE_DEPENDABOT}/{key_part(manifest)}"
        group = groups.setdefault(key, {"key": key, "source": SOURCE_DEPENDABOT, "manifest": manifest, "alerts": []})
        group["alerts"].append(alert)
    for group in groups.values():
        group["alerts"].sort(key=lambda a: (-severity_rank(dependabot_severity(a)), a.get("number", 0)))
        group["severity"] = max((dependabot_severity(a) for a in group["alerts"]), key=severity_rank)
    return groups


def package_name(alert):
    return ((alert.get("dependency") or {}).get("package") or {}).get("name") or "unbekannt"


def package_ecosystem(alert):
    return ((alert.get("dependency") or {}).get("package") or {}).get("ecosystem") or ""


def dependabot_prs(group, pull_requests):
    manifest_dir = os.path.dirname(group["manifest"])
    packages = {package_name(a) for a in group["alerts"]}
    actions_only = all(package_ecosystem(a) == "actions" for a in group["alerts"])
    found = []
    for pr in pull_requests:
        if not (pr.get("headRefName") or "").startswith("dependabot/"):
            continue
        text = f"{pr.get('title') or ''}\n{pr.get('body') or ''}"
        if not any(p in text for p in packages):
            continue
        if not actions_only and manifest_dir and manifest_dir not in f"{text}\n{pr.get('headRefName')}":
            continue
        found.append(pr["number"])
    return sorted(found)


def alert_numbers(group):
    return sorted(a["number"] for a in group["alerts"] if isinstance(a.get("number"), int))


def footer(group, min_severity):
    numbers = ",".join(str(n) for n in alert_numbers(group))
    return (
        f"Dieses Issue wird taeglich von `.github/workflows/security-issues.yml` mit den Alerts abgeglichen: Tabelle und Text "
        f"werden ueberschrieben (Notizen bitte als Kommentar). Es schliesst sich von selbst, sobald keine Alerts ab Schweregrad "
        f"`{min_severity}` mehr offen sind. Einen Alert, der bewusst nicht behoben wird, im Security-Tab mit Begruendung "
        f"verwerfen (\"Dismiss alert\"), nicht nur dieses Issue schliessen. Beschreibung: `{DOC}`\n\n"
        f"<!-- security-issues:key={group['key']} -->\n<!-- security-issues:alerts={numbers} -->"
    )


def rule_headline(rule):
    rule_id = rule.get("id") or "unbekannt"
    for candidate in (rule.get("description"), rule.get("name")):
        if candidate and candidate != rule_id:
            return cell(candidate)
    return ""


def render_code_scanning(group, repo, min_severity):
    rule = group["rule"]
    rule_id = rule.get("id") or "unbekannt"
    headline = rule_headline(rule)
    title = f"{TITLE_PREFIX}{group['tool']} {rule_id}" + (f": {headline}" if headline else "")
    lines = [
        f"**{group['tool']}** meldet **{len(group['alerts'])}** offene(n) Alert(s) der Regel `{rule_id}` auf `main`"
        + (f": {headline}." if headline else "."),
        "",
        f"Hoechster Schweregrad: **{group['severity']}**",
        "",
        "| Alert | Schweregrad | Fundstelle |",
        "|---|---|---|",
    ]
    for alert in group["alerts"][:MAX_ROWS]:
        instance = alert.get("most_recent_instance") or {}
        location = instance.get("location") or {}
        path = location.get("path") or "?"
        line = location.get("start_line")
        where = f"`{cell(path)}{f':{line}' if line else ''}`"
        commit = instance.get("commit_sha")
        if commit and path != "?":
            where = f"[{where}](https://github.com/{repo}/blob/{commit}/{path}{f'#L{line}' if line else ''})"
        lines.append(f"| [#{alert.get('number')}]({alert.get('html_url')}) | {code_scanning_severity(alert)} | {where} |")
    if len(group["alerts"]) > MAX_ROWS:
        lines.append(f"\n... und {len(group['alerts']) - MAX_ROWS} weitere, siehe Security-Tab.")
    lines += [
        "",
        "Beheben: im Alert einen Fix-Vorschlag erzeugen lassen (Copilot Autofix, \"Generate fix\") oder selbst korrigieren; "
        "der naechste CodeQL-Lauf auf `main` schliesst den Alert.",
        "",
        footer(group, min_severity),
    ]
    return title[:250], "\n".join(lines)


def render_dependabot(group, pull_requests, min_severity):
    title = f"{TITLE_PREFIX}verwundbare Abhaengigkeiten in {group['manifest']}"
    lines = [
        f"**Dependabot** meldet **{len(group['alerts'])}** offene Sicherheitsluecke(n) in Abhaengigkeiten aus `{cell(group['manifest'])}`.",
        "",
        f"Hoechster Schweregrad: **{group['severity']}**",
        "",
        "| Alert | Paket | Schweregrad | Advisory | betroffen | behoben in |",
        "|---|---|---|---|---|---|",
    ]
    for alert in group["alerts"][:MAX_ROWS]:
        advisory = alert.get("security_advisory") or {}
        vulnerability = alert.get("security_vulnerability") or {}
        ghsa = advisory.get("ghsa_id") or ""
        summary = cell(advisory.get("summary") or "")
        advisory_cell = f"[{ghsa}](https://github.com/advisories/{ghsa}) {summary}" if ghsa else summary
        patched = (vulnerability.get("first_patched_version") or {}).get("identifier")
        lines.append(
            f"| [#{alert.get('number')}]({alert.get('html_url')}) | `{cell(package_name(alert))}` | {dependabot_severity(alert)} "
            f"| {advisory_cell} | `{cell(vulnerability.get('vulnerable_version_range') or '?')}` "
            f"| {f'`{cell(patched)}`' if patched else 'noch keine'} |"
        )
    if len(group["alerts"]) > MAX_ROWS:
        lines.append(f"\n... und {len(group['alerts']) - MAX_ROWS} weitere, siehe Security-Tab.")
    prs = dependabot_prs(group, pull_requests)
    lines.append("")
    if prs:
        lines.append("Fix-PR von Dependabot: " + ", ".join(f"#{n}" for n in prs) + " (pruefen und mergen).")
    else:
        lines.append(
            "Noch kein offener Fix-PR von Dependabot. Gibt es eine gepatchte Version, oeffnet Dependabot ihn selbst "
            "(Dependabot security updates muessen aktiv sein); ohne gepatchte Version bleibt nur Ersetzen oder bewusstes Verwerfen."
        )
    lines += ["", footer(group, min_severity)]
    return title[:250], "\n".join(lines)


def existing_issues():
    r = gh("issue", "list", "--label", LABEL, "--state", "all", "--limit", "1000", "--json", "number,state,title,body")
    issues = {}
    for issue in json.loads(r.stdout or "[]"):
        match = KEY_MARKER.search(issue.get("body") or "")
        if not match:
            continue
        key = match.group(1)
        if key not in issues or (issues[key]["state"] != "OPEN" and issue["state"] == "OPEN"):
            issues[key] = issue
    return issues


def known_numbers(body):
    match = ALERTS_MARKER.search(body or "")
    if not match or not match.group(1):
        return set()
    return {int(n) for n in match.group(1).split(",") if n}


def ensure_label():
    if not dry_run():
        gh("label", "create", LABEL, "--color", LABEL_COLOR, "--description", LABEL_DESCRIPTION, check=False)


def same_text(a, b):
    return (a or "").replace("\r\n", "\n").strip() == (b or "").replace("\r\n", "\n").strip()


def upsert(group, title, body, issue):
    numbers = set(alert_numbers(group))
    if issue is None:
        print(f"{group['key']}: {len(numbers)} Alert(s), {group['severity']} -> neues Issue")
        gh_write("issue", "create", "--label", LABEL, "--title", title, "--body-file", "-", stdin=body)
        return
    number = str(issue["number"])
    if issue["state"] != "OPEN":
        print(f"{group['key']}: {len(numbers)} Alert(s), {group['severity']} -> Issue #{number} wieder geoeffnet")
        gh_write(
            "issue", "reopen", number, "--comment",
            "Wieder offen: Zu diesem Issue sind (erneut) Alerts offen. Solange ein Alert offen ist, oeffnet der naechste "
            "Abgleich das Issue wieder; Alerts, die bewusst nicht behoben werden, im Security-Tab verwerfen (\"Dismiss alert\").",
        )
    new = sorted(numbers - known_numbers(issue.get("body")))
    if not same_text(issue.get("body"), body) or issue.get("title") != title:
        print(f"{group['key']}: Issue #{number} aktualisiert")
        gh_write("issue", "edit", number, "--title", title, "--body-file", "-", stdin=body)
    if new and issue["state"] == "OPEN":
        alerts = {a["number"]: a for a in group["alerts"] if isinstance(a.get("number"), int)}
        listed = ", ".join(f"[#{n}]({alerts[n].get('html_url')})" for n in new)
        print(f"{group['key']}: neue Alerts {new} in Issue #{number} gemeldet")
        gh_write("issue", "comment", number, "--body-file", "-", stdin=f"Neue Alerts: {listed}")


def close_resolved(issues, needed_keys, fetched_sources, min_severity):
    for key, issue in sorted(issues.items()):
        if issue["state"] != "OPEN" or key in needed_keys:
            continue
        if key.split("/", 1)[0] not in fetched_sources:
            continue
        print(f"{key}: keine offenen Alerts ab {min_severity} mehr -> Issue #{issue['number']} geschlossen")
        gh_write(
            "issue", "close", str(issue["number"]), "--reason", "completed", "--comment",
            f"Keine offenen Alerts ab Schweregrad `{min_severity}` mehr (behoben oder im Security-Tab verworfen). "
            "Automatisch geschlossen von `security-issues.yml`.",
        )


def main():
    repo = os.environ.get("GITHUB_REPOSITORY") or gh("repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner").stdout.strip()
    min_severity = (os.environ.get("MIN_SEVERITY") or "medium").lower()
    if min_severity not in SEVERITIES:
        print(f"::error::MIN_SEVERITY={min_severity!r} ungueltig, erlaubt: {', '.join(SEVERITIES)}")
        return 2

    groups = {}
    fetched_sources = set()
    failures = []
    for source, fetch, group_alerts in (
        (SOURCE_CODE_SCANNING, fetch_code_scanning, group_code_scanning),
        (SOURCE_DEPENDABOT, fetch_dependabot, group_dependabot),
    ):
        try:
            alerts = fetch(repo)
        except SourceError as e:
            failures.append(f"{source}: {e}")
            continue
        fetched_sources.add(source)
        print(f"{source}: {len(alerts)} offene Alert(s)")
        groups.update(group_alerts(alerts))

    needed = {k: g for k, g in groups.items() if severity_rank(g["severity"]) >= severity_rank(min_severity)}
    for key in sorted(set(groups) - set(needed)):
        print(f"{key}: nur Alerts unter {min_severity}, kein Issue")

    pull_requests = []
    if any(g["source"] == SOURCE_DEPENDABOT for g in needed.values()):
        r = gh("pr", "list", "--state", "open", "--limit", "200", "--json", "number,title,body,headRefName", check=False)
        pull_requests = json.loads(r.stdout or "[]") if r.returncode == 0 else []

    issues = existing_issues()
    if needed:
        ensure_label()
    for key, group in sorted(needed.items()):
        if group["source"] == SOURCE_CODE_SCANNING:
            title, body = render_code_scanning(group, repo, min_severity)
        else:
            title, body = render_dependabot(group, pull_requests, min_severity)
        upsert(group, title, body, issues.get(key))
    close_resolved(issues, set(needed), fetched_sources, min_severity)

    for failure in failures:
        print(f"::error title=Security-Alerts nicht abrufbar::{failure}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
