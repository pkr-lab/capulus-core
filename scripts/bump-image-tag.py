#!/usr/bin/env python3
"""Setzt `image.tag` in einer values.yaml auf einen neuen Wert (Kommentare/Format bleiben).

Aufruf:  scripts/bump-image-tag.py argocd/apps/tech/pacman/values.yaml sha-1a2b3c4

Ausgabe: `<alt> -> <neu>` bzw. `unveraendert`. Exit-Code 0, wenn eine Aenderung geschrieben wurde,
3, wenn der Tag schon stimmt, 1 bei Fehlern (z. B. kein/mehrere `image.tag`).
Genutzt von .github/workflows/build-images.yml (Bump-PR nach dem Image-Build).
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import promotelib  # noqa: E402


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__, file=sys.stderr)
        return 1
    path, new = sys.argv[1], sys.argv[2]
    with open(path, encoding="utf-8") as fh:
        text = fh.read()
    fields = [f for f in promotelib.image_tag_fields(text) if f.key == "image.tag"]
    if len(fields) != 1:
        print(f"{path}: erwartet genau ein `image.tag`, gefunden {len(fields)}", file=sys.stderr)
        return 1
    field = fields[0]
    if field.value == new:
        print("unveraendert")
        return 3
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(promotelib.replace_values(text, fields, {field.key: new}))
    print(f"{field.value} -> {new}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
