"""Gemeinsame Hilfen fuer die Promotion-Werkzeuge (promote-chain.py, bump-image-tag.py).

Liest die "Versionsfelder" einer App mit exakter Textposition und schreibt sie zurueck,
ohne den Rest der Datei anzufassen (Kommentare, Einrueckung und Anfuehrungszeichen bleiben).

Versionsfelder sind bewusst eng gefasst (docs/f-cicd-automatisierung/f00b0-promotion-chain.md):
  values.yaml  jedes Skalar `tag` unterhalb eines Schluessels `image` (z. B. `image.tag`,
               `sealed-secrets.image.tag`, `server.image.tag`)
  Chart.yaml   `dependencies[*].version`, sofern es eine exakte Version ist (kein `*`, `^`, `~`, `>=`)
Alles andere (Hosts, Replicas, Ressourcen, Templates) wird nie automatisch uebertragen.
"""
import re
from dataclasses import dataclass

import yaml
from yaml.nodes import MappingNode, ScalarNode, SequenceNode

# Exakte Chart-/Image-Version, keine Bereichs-Ausdruecke.
EXACT_CHART_VERSION = re.compile(r"^v?\d+(\.\d+)*([-+][0-9A-Za-z.\-]+)?$")

VERSION_FILES = ("values.yaml", "Chart.yaml")


@dataclass(frozen=True)
class Field:
    file: str  # Dateiname relativ zum App-Ordner, z. B. "values.yaml"
    key: str  # z. B. "sealed-secrets.image.tag" oder "dependencies[sealed-secrets].version"
    value: str  # Textwert ohne Anfuehrungszeichen
    start: int  # Zeichenposition im Dokument (inkl. Anfuehrungszeichen)
    end: int
    quote: str  # '"', "'" oder ""


def _scalar_field(file: str, key: str, node: ScalarNode) -> Field:
    quote = node.style if node.style in ('"', "'") else ""
    return Field(file, key, node.value, node.start_mark.index, node.end_mark.index, quote)


def _walk(node, path):
    if isinstance(node, MappingNode):
        for k, v in node.value:
            if isinstance(k, ScalarNode):
                yield from _walk(v, path + [k.value])
    elif isinstance(node, SequenceNode):
        for i, v in enumerate(node.value):
            yield from _walk(v, path + [f"[{i}]"])
    elif isinstance(node, ScalarNode):
        yield path, node


def image_tag_fields(text: str, file: str = "values.yaml") -> list:
    """Alle `image.tag`-Felder (auch verschachtelt, z. B. `<subchart>.image.tag`)."""
    root = yaml.compose(text)
    if root is None:
        return []
    out = []
    for path, node in _walk(root, []):
        if len(path) >= 2 and path[-1] == "tag" and path[-2] == "image" and node.value not in ("", "null", "~"):
            out.append(_scalar_field(file, ".".join(path), node))
    return out


def chart_dependency_fields(text: str, file: str = "Chart.yaml") -> list:
    """`dependencies[<name>].version` mit exakter Version."""
    root = yaml.compose(text)
    if not isinstance(root, MappingNode):
        return []
    out = []
    for k, v in root.value:
        if not (isinstance(k, ScalarNode) and k.value == "dependencies" and isinstance(v, SequenceNode)):
            continue
        for dep in v.value:
            if not isinstance(dep, MappingNode):
                continue
            fields = {kk.value: vv for kk, vv in dep.value if isinstance(kk, ScalarNode)}
            name, version = fields.get("name"), fields.get("version")
            if isinstance(name, ScalarNode) and isinstance(version, ScalarNode):
                if EXACT_CHART_VERSION.match(version.value):
                    out.append(_scalar_field(file, f"dependencies[{name.value}].version", version))
    return out


def version_fields(file: str, text: str) -> list:
    """Versionsfelder einer Datei; unlesbares YAML liefert keine Felder statt eines Abbruchs."""
    try:
        if file == "values.yaml":
            return image_tag_fields(text, file)
        if file == "Chart.yaml":
            return chart_dependency_fields(text, file)
    except yaml.YAMLError:
        return []
    return []


def replace_values(text: str, fields: list, new_values: dict) -> str:
    """Setzt `new_values` (key -> Wert) an den Positionen der passenden `fields` ein."""
    by_key = {f.key: f for f in fields}
    edits = [(by_key[k], v) for k, v in new_values.items() if k in by_key]
    for f, v in sorted(edits, key=lambda e: e[0].start, reverse=True):
        text = text[: f.start] + f.quote + v + f.quote + text[f.end :]
    return text
