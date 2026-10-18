# 015 CI/CD: Third-Party-Actions mit Secrets nur per Tag referenziert, Tailscale-Client `latest`, PoC-Workflow bleibt aktiv

- Severity: Medium
- Bereich: Repo
- Betroffen: `.github/workflows/*.yml` (alle `uses:`), `promote-chain.yml:69-74`, `renovate.yml:23`, `tailscale-poc.yml`
- Status: Teilweise behoben am 2026-10-17 (Punkte 1, 2 und 4 abgeschlossen bzw. entschieden, Punkt 3 ist ein Handgriff im Tailscale-Admin-Panel)

## Beschreibung

Alle Actions sind über veränderliche Tags eingebunden (`@v7`, `@v4`, `@v46.3.8`), keine auf eine Commit-SHA fixiert. Besonders heikel sind die mit Secrets:

- `tailscale/github-action@v4` erhält `TS_OAUTH_CLIENT_ID`/`TS_OAUTH_SECRET` (Scope `auth_keys:write`) und bringt den Runner in das Tailnet; `version: latest` zieht dabei zusätzlich den jeweils neuesten Tailscale-Client.
- `renovatebot/github-action` erhält `RENOVATE_TOKEN` (PAT mit Schreibrechten auf das Repo).
- `docker/login-action`, `docker/build-push-action` arbeiten mit `GITHUB_TOKEN` (Registry-Push).
- `gitleaks/gitleaks-action@v3` läuft mit `GITHUB_TOKEN`.

`tailscale-poc.yml` ist ein manuell startbarer Proof-of-Concept, der dieselben OAuth-Secrets nutzt und interne IPs (192.168.178.94/.100) fest einträgt. Die Workflows sind sonst solide: kein `pull_request_target`, minimale `permissions`, keine Expression-Injection in `run:`-Blöcken (nur `matrix.*`, `github.sha`).

## Nachweis

```
$ grep -h 'uses:' .github/workflows/*.yml | sed 's/^ *- *//' | sort | uniq -c | sort -rn
 18 uses: actions/checkout@v7
  3 uses: actions/setup-python@v7
  2 uses: tailscale/github-action@v4
  2 uses: azure/setup-helm@v5
  1 uses: renovatebot/github-action@v46.3.8
  1 uses: gitleaks/gitleaks-action@v3
  1 uses: docker/login-action@v4
  1 uses: docker/build-push-action@v7
  ...
$ sed -n 74p .github/workflows/promote-chain.yml
          version: latest
```
semgrep: `github-actions-mutable-action-tag` ×34, checkov `CKV_GHA_7` (build-images `workflow_dispatch`-Eingabe).

## Risiko / Angriffsszenario

Wird eine dieser Actions im Tag-Repository kompromittiert (Tag-Umbiegen wie bei `tj-actions/changed-files`, 2025), bekommt der Angreifer Tailnet-Zugang mit dem OAuth-Client, einen Repo-PAT oder Registry-Schreibrechte. Über den Tailnet-Zugang erreicht der Runner den ArgoCD-API-Port (Incident 013).

## Empfohlene Behebung

1. Renovate-Preset ergänzen, das alle Actions auf Digests pinnt:
   ```diff
    "extends": [
      "config:recommended",
   +  "helpers:pinGitHubActionDigests",
      ":dependencyDashboard"
    ]
   ```
2. `version: latest` in beiden Tailscale-Schritten durch eine feste Version ersetzen.
3. Tailscale-OAuth-Client auf das Minimum (nur `tag:ci`, nur `auth_keys`) beschränken und im Admin-Panel regelmäßig prüfen.
4. `tailscale-poc.yml` löschen, wenn der PoC abgeschlossen ist (die Kette selbst läuft in `promote-chain.yml`).

## Rollback

Pinning-PR schließen bzw. revertieren; `version: latest` zurücksetzen.

## Verifikation

```
grep -hE 'uses:' .github/workflows/*.yml | grep -vE '@[0-9a-f]{40}'
grep -n 'version: latest' .github/workflows/*.yml
```
Beide Ausgaben leer (außer lokalen Referenzen `./.github/…`).

## Risiko der Behebung

Niedrig: Die Pinning-PRs kommen über Renovate und laufen durch die CI.

## Behebung (2026-10-17)

**Fix.**

- **Punkt 1:** Alle 35 `uses:`-Stellen in 11 Workflows zeigen auf die Commit-SHA des bisherigen Tags, mit Versions-Kommentar (`# v7.0.1`) als einziger Kommentar-Ausnahme (in `CLAUDE.md` festgehalten). Jede SHA wurde per `gh api` gegen den semantischen Tag geprüft: `actions/checkout` v7.0.1, `actions/setup-python` v7.0.0, `actions/setup-node` v7.1.0, `actions/setup-go` v7.0.0, `tailscale/github-action` v4.2.0, `azure/setup-helm` v5.0.1, `renovatebot/github-action` v46.3.8, `gitleaks/gitleaks-action` v3.0.0, `github/codeql-action` (init und analyze) v4.39.0, `docker/login-action` v4.6.0, `docker/build-push-action` v7.4.0. `renovate.json` bekommt das Preset `helpers:pinGitHubActionDigests`, damit Renovate Pins und Kommentare gemeinsam aktuell hält.
- **Punkt 2:** `version: latest` ist in `promote-chain.yml` und `tailscale-poc.yml` durch `version: 1.104.1` ersetzt (aktuelle Stable-Version). Ein Regex-Manager in `renovate.json` (`customManagers`) schlägt neue Versionen vor, die Regel `allowedVersions` lässt nur Stable-Releases (gerade Minor-Nummer) zu.
- **Punkt 4 entschieden:** `tailscale-poc.yml` bleibt vorerst, weil er die einzige Diagnose für den Runner-Weg per HTTPS (Incident 013) ist. Löschen, sobald die Promotion-Kette wieder läuft.
- **Punkt 3 (Umbau auf Federated Identity):** Statt eines OAuth-Clients mit dauerhaftem Secret nutzen `promote-chain.yml` und `tailscale-poc.yml` jetzt **Workload Identity Federation** (`audience: ${{ secrets.TS_AUDIENCE }}`, `id-token: write` im Job). In GitHub liegen nur Client ID und Audience, kein Secret. Die Credential im Tailscale-Admin-Panel (*Settings → Trust credentials*, Issuer GitHub) gilt nur für `repo:pkr-lab/capulus-core:ref:refs/heads/main`, mit Scope `auth_keys` (Write) und Tag `tag:ci`. Das Anlegen ist ein Handgriff im Admin-Panel (siehe „Offen“).

**Nachweis** (lokal, vor dem Merge):

| Test | Ergebnis |
|---|---|
| `grep -hE 'uses:' .github/workflows/*.yml \| grep -vE '@[0-9a-f]{40}'` | nur die lokale Referenz `./.github/workflows/ci.yml` |
| `grep -n 'version: latest' .github/workflows/*.yml` | leer |
| Pin-Prüfung aller SHAs gegen `gh api repos/<repo>/commits/<tag>` | 12 von 12 Actions stimmen |
| YAML-Parse aller Workflows | ok |
| `renovate-config-validator` auf `renovate.json` | `Config validated successfully` |
| Regex des Tailscale-Managers gegen die Workflows | trifft `promote-chain.yml` und `tailscale-poc.yml` (`1.104.1`), `allowedVersions` lässt `1.104.x` und `1.106.x` zu, `1.105.x` nicht |

Der Lauf der CI im PR ist der eigentliche Funktionstest der Pins. Nicht im PR laufende Workflows (`release.yml`, `renovate.yml`, `build-images.yml`, `promote-chain.yml`) sind nur per YAML-Parse und SHA-Prüfung abgesichert.

**Geänderte Dateien.**

- `.github/workflows/` (`build-images.yml`, `ci.yml`, `codeql.yml`, `promote-chain.yml`, `promote-entw.yml`, `release.yml`, `renovate.yml`, `security-issues.yml`, `sync-entw.yml`, `tailscale-poc.yml`, `token-watch.yml`), `ops/token-register.yaml` (Eintrag `tailscale-ci-federated-identity`)
- `renovate.json`, `CLAUDE.md`
- Doku: `docs/6-hintergruende/600a0-ci-workflows-und-skripte.md`, `docs/f-cicd-automatisierung/f0020-renovate.md`, `f00b0-promotion-chain.md`, `docs/d-sicherheit/d0080-codeql-dependabot.md`

**Rollback.** PR revertieren. Danach stehen wieder die Tags und `version: latest` im Workflow. Einzelne Pins lassen sich auch ohne Revert auf einen älteren Tag zurücksetzen (SHA durch `vX` ersetzen).

**Offen.**

- **Federated Identity anlegen (Punkt 3):** Tailscale-Admin-Panel → *Settings → Trust credentials → Credential → OpenID Connect*, Issuer GitHub, Subject `repo:pkr-lab/capulus-core:ref:refs/heads/main`, nur Scope `auth_keys` (Write), nur Tag `tag:ci`. Client ID und Audience danach mit `gh secret set TS_OAUTH_CLIENT_ID` und `gh secret set TS_AUDIENCE` ablegen, dann *Tailscale Runner PoC* ausführen. Vorhandene alte OAuth-Clients unter *Trust credentials* prüfen und widerrufen. Die Secrets existieren derzeit nicht (Incident 013), die Kette ist deaktiviert.
- **`token-watch.yml` (Nebenwirkung):** Der Workflow liest `TS_OAUTH_CLIENT_ID` und `TS_OAUTH_SECRET`, um den Schlüsselablauf von worker-0 über die Tailscale-API zu prüfen. Ohne OAuth-Secret überspringt er diese Prüfung stillschweigend (das war schon vorher so, weil die Secrets fehlen). Wer sie braucht, legt dafür einen eigenen OAuth-Client mit nur dem Lese-Scope `devices:core:read` an; die Secret-Namen sollten dann nicht mit denen der CI kollidieren.
- **Nach dem Merge:** Renovate öffnet beim nächsten Lauf (montags) PRs für Pin-Updates und, falls es eine neuere Stable-Version gibt, für den Tailscale-Client.
- **Außerhalb von 015:** `npx semantic-release` und `pip install` ohne feste Versionen (Incident 031), `CKV_GHA_7` in `build-images.yml`.

