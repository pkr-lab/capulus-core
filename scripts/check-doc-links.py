#!/usr/bin/env python3
"""Prueft relative Links und Anker in allen Markdown-Dateien des Repos.

Aufruf:  scripts/check-doc-links.py            (alle git-getrackten *.md)
         scripts/check-doc-links.py datei.md   (nur diese Dateien)

Geprueft wird nur, was lokal aufloesbar ist: Dateien/Ordner und Ueberschriften-Anker
(Slug-Regeln wie auf GitHub). Externe URLs (http, https, mailto) werden nicht abgerufen.
Exit-Code 1, wenn ein Link ins Leere zeigt. Beschreibung: docs/f-cicd-automatisierung/f0070-ci-lint.md
"""
import os
import re
import subprocess
import sys
from urllib.parse import unquote

FENCE = re.compile(r"^\s*(```|~~~)")
HEADING = re.compile(r"^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$")
LINK = re.compile(r"(?<!\!)\[(?:[^\]\[]|\[[^\]]*\])*\]\(\s*<?([^)\s>]+)>?(?:\s+\"[^\"]*\")?\s*\)")
IMAGE = re.compile(r"\!\[(?:[^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+\"[^\"]*\")?\s*\)")
HTML_ID = re.compile(r"""<a\s+[^>]*(?:id|name)=["']([^"']+)["']""", re.I)


def slug(heading: str) -> str:
    """GitHub-Slug: Formatierung entfernen, klein, nur Wort-/Leerzeichen/Bindestrich, Leerzeichen -> '-'."""
    h = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", heading)  # [text](url) -> text
    h = re.sub(r"<[^>]+>", "", h)  # HTML-Tags
    h = re.sub(r"[`*~]", "", h)  # Code/Betonung
    h = h.strip().lower()
    h = re.sub(r"[^\w\- ]", "", h, flags=re.UNICODE)
    return h.replace(" ", "-")


_anchor_cache: dict = {}


def anchors(path: str) -> set:
    if path in _anchor_cache:
        return _anchor_cache[path]
    seen: dict = {}
    result = set()
    in_fence = False
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            if FENCE.match(line):
                in_fence = not in_fence
                continue
            if in_fence:
                continue
            for m in HTML_ID.finditer(line):
                result.add(m.group(1))
            m = HEADING.match(line)
            if m:
                base = slug(m.group(1))
                n = seen.get(base, 0)
                seen[base] = n + 1
                result.add(base if n == 0 else f"{base}-{n}")
    _anchor_cache[path] = result
    return result


def iter_links(path: str):
    in_fence = False
    with open(path, encoding="utf-8") as fh:
        for lineno, line in enumerate(fh, 1):
            if FENCE.match(line):
                in_fence = not in_fence
                continue
            if in_fence:
                continue
            stripped = re.sub(r"``.+?``|`[^`]*`", lambda m: " " * len(m.group(0)), line)
            for rx in (LINK, IMAGE):
                for m in rx.finditer(stripped):
                    yield lineno, m.group(1)


def check(path: str) -> list:
    problems = []
    for lineno, target in iter_links(path):
        if re.match(r"^[a-zA-Z][a-zA-Z0-9+.\-]*:", target):  # http:, https:, mailto:, ...
            continue
        file_part, _, anchor = target.partition("#")
        file_part = unquote(file_part)
        dest = os.path.normpath(os.path.join(os.path.dirname(path), file_part)) if file_part else path
        if not os.path.exists(dest):
            problems.append(f"{path}:{lineno}: Ziel fehlt: {target}")
            continue
        if anchor and os.path.isfile(dest) and dest.endswith(".md"):
            if unquote(anchor).lower() not in {a.lower() for a in anchors(dest)}:
                problems.append(f"{path}:{lineno}: Anker fehlt: {target}")
    return problems


def main() -> int:
    files = sys.argv[1:] or subprocess.check_output(["git", "ls-files", "*.md"], text=True).split()
    problems = []
    for f in files:
        problems += check(f)
    for p in problems:
        print(p)
    print(f"{len(files)} Dateien geprueft, {len(problems)} kaputte Links", file=sys.stderr)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
