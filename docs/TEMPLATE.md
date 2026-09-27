# Doc-Template — wie ein neues Dokument aufgebaut wird

Diese Seite ist selbst kein Doc, sondern die Vorlage für neue Dateien unter
`docs/`. Sie beschreibt das Namensschema, die Ordnerstruktur und drei
Doc-Typen, die sich im bestehenden Bestand als sinnvoll erwiesen haben — je
nachdem, was das neue Doc eigentlich ist, kopiert man das passende Skelett
weiter unten.

---

## 1. Namensschema

Jede Datei heißt `<id>-<slug>.md`, wobei `<id>` eine 5-stellige
Hex-Kennung ist: **das erste Zeichen kodiert die Kategorie** (= den
Unterordner, in dem die Datei liegt), die restlichen vier Hex-Ziffern sind
eine Sequenznummer **innerhalb** der Kategorie.

```
a0000-ubuntu-server-install.md
│└──┴─ Sequenznummer (Hex, 4-stellig)
└────── Kategorie-Zeichen ("a" = Betriebssystem & Grundlagen)
```

Neue Docs bekommen die nächste freie Sequenznummer **in Schritten von
`0x0010`** (nicht `+1`) — das lässt Lücken für spätere Einfügungen zwischen
zwei bestehenden Docs, ohne alle nachfolgenden umbenennen zu müssen. Beispiel:
liegen `c0000` und `c0010` schon, und das neue Doc gehört inhaltlich
dazwischen, bekommt es `c0008` (oder jede freie Zahl zwischen den beiden) statt
ans Ende der Kategorie angehängt zu werden.

### Kategorien

| Zeichen | Kategorie | Ordner |
|---|---|---|
| `a` | Betriebssystem & Grundlagen | `a-betriebssystem/` |
| `b` | Kubernetes & GitOps | `b-kubernetes-gitops/` |
| `c` | Netzwerk & DNS | `c-netzwerk-dns/` |
| `d` | Sicherheit | `d-sicherheit/` |
| `e` | Externe Erreichbarkeit | `e-externe-erreichbarkeit/` |
| `f` | CI/CD & Automatisierung | `f-cicd-automatisierung/` |
| `1` | Benachrichtigungen | `1-benachrichtigungen/` |
| `2` | Betrieb & Hardware | `2-betrieb-hardware/` |
| `3` | Apps & Workloads | `3-apps-workloads/` |
| `4` | Planung | `4-planung/` |
| `5` | Incidents | `5-incidents/` |
| `6` | Hintergründe | `6-hintergruende/` |

`4-planung/` ist die einzige Kategorie, die nicht den aktuellen Ist-Zustand
beschreibt: sie hält ausgiebig recherchierte, aber noch nicht (vollständig)
umgesetzte Architektur-/Rollout-Pläne, bis sie entweder umgesetzt sind (dann
wandert das Ergebnis als eigenes Doc in die fachlich passende Kategorie,
z. B. `d-sicherheit/`) oder verworfen werden.

`5-incidents/` nimmt Vorfallsberichte auf, die keinem Fachthema zugeordnet
werden sollen (Typ C). Ein Vorfall, dessen Lehren direkt eine
Sicherheitsmaßnahme betreffen, kann stattdessen in `d-sicherheit/` liegen
(Beispiel: `d0000-incident-2026-08-12.md`).

`6-hintergruende/` hält die Begründungen zum Code: warum etwas so gebaut ist, welche
Fallstricke und Vorfälle dahinterstehen. Der Code selbst bleibt kommentarfrei, solche
Begründungen stehen nicht als Kommentar daneben. Einstieg und Zuordnung von Dateien
zu Docs: [60000](6-hintergruende/60000-uebersicht.md).

Passt ein neues Thema in keine bestehende Kategorie, ist das ein Signal, kurz
zu prüfen, ob eine dreizehnte Kategorie wirklich nötig ist, statt es einer
unpassenden zuzuordnen — Hex hat mit `0` und `7`–`9` noch Reserve.

Ausnahme vom Namensschema: `superpowers/plans/` und `superpowers/specs/`
enthalten datierte Plan- und Spec-Dokumente (`YYYY-MM-DD-<thema>.md`) mit
eigenem Schema. Sie zählen nicht zu den Kategorien oben.

### Cross-Referenzen

Innerhalb von `docs/` immer **relativ** verlinken, nicht mit `docs/`-Präfix:

- Gleiche Kategorie: `[Text](b0010-argocd.md)`
- Andere Kategorie: `[Text](../c-netzwerk-dns/c0000-dns-architecture.md)`

Außerhalb von `docs/` (README, Skripte, ArgoCD-`values.yaml`, …)
immer den vollen, repo-root-relativen Pfad inkl. Kategorie-Ordner:
`docs/c-netzwerk-dns/c0000-dns-architecture.md`.

---

## 2. Doc-Typen

Der bestehende Bestand fällt in drei wiederkehrende Formen. Kein Doc muss
alle Abschnitte eines Typs haben — das Skelett ist ein Ausgangspunkt, kein
Zwang.

### Typ A — Setup/Runbook

Für App- und Komponenten-Dokus mit einem konkreten Einrichtungsablauf
(Beispiele: `300a0-vaultwarden.md`, `30060-mealie.md`, `300b0-nextcloud.md`).

```markdown
# <Titel> — <Kurzbeschreibung>

<1–3 Sätze: was es ist, warum es im Stack steckt.>

> **Cluster:** <TECH | PROD | ENTW> · Ordner `argocd/apps/<cluster>/<app>/` · URL `https://<app>.<tier>.homeserver`
> `kubectl`-Befehle in diesem Doc gelten für diesen Cluster
> (Zugriff je Cluster: [a0010](../a-betriebssystem/a0010-overview.md#kubectl-zugriff-je-cluster)).

---

## Architektur

<Diagramm/Text: wie die Komponente mit dem Rest verdrahtet ist.>

---

## 1. <Erster Schritt>

<Anleitung, Befehle, Screenshots-Beschreibung.>

## 2. <Zweiter Schritt>

...

---

## Konfiguration

| Key | Bedeutung | Default |
|---|---|---|
| `values.yaml`-Pfad | ... | ... |

---

## Troubleshooting

| Symptom | Hinweis |
|---|---|
| ... | ... |
```

### Typ B — Konzept/Referenz

Für Docs, die eine Konvention oder Architekturentscheidung erklären, ohne ein
lineares Runbook zu sein (Beispiele: `c0040-domain-tiers.md`,
`c0000-dns-architecture.md`).

```markdown
# <Titel>

<Intro: welches Problem/welche Konvention dieses Doc beschreibt.>

---

## <Thematischer Abschnitt 1>

<Erklärung, Tabellen, Diagramme nach Bedarf.>

## <Thematischer Abschnitt 2>

...

---

## <Faustregel/Zusammenfassung, falls sinnvoll>
```

### Typ C — Incident/Log

Für punktuelle Vorfallsberichte, datiert im Dateinamen mitgeführt (Beispiel:
`d0000-incident-2026-08-12.md`).

```markdown
# Incident-Report — <Datum>: <Kurzbeschreibung>

| Zeit | Ereignis |
|---|---|
| ... | ... |

---

## Ursache

...

## Behebung

...

## Lessons Learned

...
```

---

## 3. Konventionen (typübergreifend)

- `---` als Trenner zwischen größeren Abschnitten, keine tieferen
  Heading-Ebenen als `##`/`###`.
- Tabellen für Konfigurationswerte und Troubleshooting-Einträge (Spalte 1 =
  Symptom/Key, Spalte 2 = Erklärung/Wert) statt Fließtext-Aufzählungen.
- Cross-Referenzen direkt im Fließtext an der Stelle, wo sie relevant sind
  (siehe [Abschnitt 1](#cross-referenzen)) — keine gesammelte Link-Fußzeile.
- Deutsch als Sprache, konsistent mit dem restlichen Bestand.
- **Ist-Zustand vs. Plan:** Docs außerhalb von `4-planung/` beschreiben, was heute läuft. Ändert sich der
  Zustand (App zieht in einen anderen Cluster, Host wird umbenannt, Komponente wird ersetzt), das Doc
  im **selben** PR mitziehen. Planungs-Docs tragen oben eine Statuszeile (geplant / teilweise umgesetzt /
  umgesetzt und wohin der Ist-Zustand gewandert ist).
- **Hostnamen** immer im Tier-Schema (`<app>.tech.homeserver`, `<app>.prod.homeserver`), nie flach
  (`<app>.homeserver`), siehe [c0040](c-netzwerk-dns/c0040-domain-tiers.md).
- **Repo-Pfade** mit Cluster-Ordner (`argocd/apps/tech/…`, `argocd/apps/prod/…`, `argocd/apps/entw/…`).
- **Keine Kommentare im Code:** Wer eine Begründung, einen Fallstrick oder eine Vorfall-Regel festhalten will, trägt sie im selben PR in das passende Doc unter
  [6-hintergruende/](6-hintergruende/60000-uebersicht.md) ein, nicht als Kommentar neben den Code.
- **Verlinkung prüfen:** `python3 scripts/check-doc-links.py` findet kaputte relative Links und Anker
  (läuft auch in der CI, siehe [f0070](f-cicd-automatisierung/f0070-ci-lint.md)).
