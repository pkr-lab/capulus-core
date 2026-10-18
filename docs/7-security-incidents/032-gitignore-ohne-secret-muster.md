# 032 `.gitignore` ohne Muster für Schlüssel, `.env`, Kubeconfigs und Vault-Passwörter

- Severity: Low
- Bereich: Repo
- Betroffen: `.gitignore`
- Status: Behoben am 2026-10-18 (im Code, gestaged)

## Beschreibung

Die Datei enthält vier Zeilen (`AGENTS.md`, `.claude`, `__pycache__/`, `.idea/`). Keine Regel schützt vor versehentlichem Einchecken von privaten Schlüsseln, `.env`-Dateien, Kubeconfigs, Zertifikats-Schlüsseln oder Ansible-Vault-Passwortdateien. Der Schlüssel aus Incident 001 hätte so nicht abgefangen werden können.

## Nachweis

```
$ wc -l .gitignore && cat .gitignore
4 .gitignore
AGENTS.md
.claude
# Python-Bytecode ...
__pycache__/
.idea/
```

## Risiko / Angriffsszenario

Ein versehentliches `git add .` im Arbeitsverzeichnis mit lokalen Schlüsseln oder Token-Dateien führt direkt in ein öffentliches Repo.

## Empfohlene Behebung

```
*.pem
*.key
*.p12
*.pfx
id_rsa*
id_ed25519*
*.kdbx
.env
.env.*
kubeconfig*
*.kubeconfig
.vault_pass*
vault-password*
*.sqlite
```
Die vorhandenen, bewusst eingecheckten CA-Zertifikate (`homeserver-root-ca.pem`) per `!`-Ausnahme erlauben.

## Rollback

Zeilen entfernen.

## Verifikation

```
git check-ignore -v test.key id_ed25519 .env
git ls-files | grep -E '\.(key|pfx|p12)$|^\.env'
```
Die Dateien werden ignoriert, das zweite Kommando liefert nichts.

## Behebung (2026-10-18)

**Fix.** `.gitignore` enthält die empfohlenen Muster: `*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_rsa*`, `id_ed25519*`, `*.kdbx`, `.env`, `.env.*`, `kubeconfig*`, `*.kubeconfig`, `.vault_pass*`, `vault-password*`, `*.sqlite`. Die Ausnahme ist `!homeserver-root-ca.pem` (Dateiname statt Pfad, weil die öffentliche Root-CA an drei Stellen liegt: `docs/assets/` und zwei Charts unter `files/`).

**Nachweis.**

| Test | Ergebnis |
|---|---|
| `git ls-files -ci --exclude-standard` (getrackte Dateien, die unter ein Muster fallen) | leer |
| `git check-ignore` für `x.key`, `id_ed25519`, `.env.local`, `kubeconfig-prod`, `.vault_pass`, `app.sqlite`, `docs/assets/neu.pem` | alle ignoriert |
| `git check-ignore -v pki/homeserver-root-ca.pem` | nicht ignoriert |

**Geänderte Dateien.**

- `.gitignore`
- Doku: `docs/6-hintergruende/600a0-ci-workflows-und-skripte.md`

**Rollback.** Die Zeilen aus `.gitignore` entfernen.

**Offen.** Das Muster ist nur ein Netz: `git add -f` umgeht es, der eigentliche Schutz bleibt gitleaks in der CI und `push protection` (Incident 014). Der Schlüssel aus Incident 001 liegt weiter in der Historie.
