# 021 Alle 35 Einträge im Token-Register ohne Ablaufdatum, 31 davon mit manueller Rotation

- Severity: Low
- Bereich: Repo
- Betroffen: `ops/token-register.yaml`, `scripts/check-token-register.py`, `scripts/token-watch.py`
- Status: Teilweise behoben am 2026-10-18 (Prüfregeln und Fristen im Code, gestaged; Anlegedaten und Rotation der Altbestände offen)

## Beschreibung

Das Register führt 35 Tokens, Passwörter und Schlüssel (15 Passwörter, 16 API-Tokens, 2 Tunnel-Credentials, 1 Auth-Key, 1 Verschlüsselungsschlüssel). Bei allen 35 steht `expires: null`, bei den meisten auch `issued: null` und `max_age_days: null`. 31 haben `rotation.mode: manual`. Das Register erfüllt damit die Inventarfunktion, aber keine Ablauf- und Altersüberwachung. `token-watch.py` prüft nur GitHub-PATs und Tailscale-Geräteschlüssel; die jährliche n8n-Erinnerung deckt den Rest nur grob ab.

## Nachweis

```
$ python3 - <<'EOF'
import re
t=open("ops/token-register.yaml").read()
print(len(re.findall(r"^- id:",t,re.M)), sum(1 for e in re.findall(r"^  expires: (.*)$",t,re.M) if e.strip()=="null"))
EOF
35 35
$ grep -c 'mode: manual' ops/token-register.yaml
31
```

## Risiko / Angriffsszenario

Langlebige Zugangsdaten (Registry-Push, GitHub-PATs, Cloudflare-Tunnel, Tailscale-OAuth) bleiben nach einem unbemerkten Abfluss beliebig lange gültig. Im Fall von Incident 001 (Schlüssel in Git-Historie) fehlt die Rotationsroutine.

## Empfohlene Behebung

1. `issued` und `expires` bzw. `max_age_days` für jeden Eintrag pflegen (GitHub-PATs: maximal 1 Jahr, fein granular).
2. `check-token-register.py` so erweitern, dass Einträge ohne `max_age_days` oder mit überschrittener Frist die CI scheitern lassen.
3. Rotation für `api-token` und `password` jährlich oder halbjährlich terminieren (n8n-Erinnerung enthält die Liste).

## Rollback

Prüfregel im Skript entfernen.

## Verifikation

```
python3 scripts/check-token-register.py
```
Das Skript meldet fehlende Ablaufdaten und beendet mit Exit-Code `1`, solange sie fehlen.

## Behebung (2026-10-18)

**Fix.**

- `max_age_days` ist jetzt für jeden der 44 Register-Einträge gesetzt (26 ergänzt): API-Tokens, Passwörter, Zertifikate und Tunnel-Credentials 365 Tage, Auth-Keys 90, Verschlüsselungsschlüssel 30. Die Werte folgen dem Turnus aus `docs/d-sicherheit/d0060-secrets-rotation.md`.
- `scripts/check-token-register.py` lässt die CI jetzt scheitern, wenn `max_age_days` fehlt, wenn `issued` plus `max_age_days` in der Vergangenheit liegt (Rotation überfällig) oder wenn `expires` verstrichen ist. Ist `issued` unbekannt, meldet das Skript die Zahl als Hinweis, scheitert aber nicht.
- Nicht erfunden: Die Anlegedaten fehlen weiter bei 34 von 44 Einträgen. Ein geratenes Datum würde die Prüfung vortäuschen.

**Nachweis.**

| Test | Ergebnis |
|---|---|
| `python3 scripts/check-token-register.py` | `44 Eintraege, 29 SealedSecrets im Repo, 0 Probleme`, Hinweis „issued unbekannt“ bei 34 Einträgen |
| Negativtest (Register-Kopie mit einem Eintrag ohne `max_age_days` und einem mit `issued: 2020-01-01`) | zwei Meldungen: `max_age_days fehlt` und `Rotation ueberfaellig`, Exit-Code 1 |
| Doc-Link-Check | 0 kaputte Links |

**Geänderte Dateien.**

- `ops/token-register.yaml`, `scripts/check-token-register.py`
- Doku: `docs/d-sicherheit/d0060-secrets-rotation.md`, `docs/f-cicd-automatisierung/f0070-ci-lint.md`, `docs/6-hintergruende/600a0-ci-workflows-und-skripte.md`

**Rollback.** `git revert`; die Prüfregeln entfallen, die Fristen bleiben als Felder.

**Offen (braucht dich).**

- `issued` für die 34 Einträge nachtragen, sobald das Datum bekannt ist (zum Beispiel aus dem Alter der SealedSecret-Datei im Git-Verlauf oder bei der nächsten Rotation). Erst dann greift die Fristprüfung.
- Die Rotation selbst (Empfehlung Punkt 3) und die n8n-Erinnerung sind nicht angefasst; Rotationen sind Entscheidungen von dir.
