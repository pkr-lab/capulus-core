# 023 Image-Tags nicht fixiert: `latest`, `stable`, ohne Tag; nur 2 von 54 Images per Digest gepinnt

- Severity: Low
- Bereich: Repo
- Betroffen: `argocd/apps/prod/xibosignage/templates/quickchart-deployment.yaml` (`ianw/quickchart:latest`), `argocd/apps/tech/lldap/values.yaml:7` (`stable`), Zammad-Subchart (`busybox` ohne Tag)
- Status: Behoben am 2026-10-18 (im Code, gestaged, wirkt nach Merge; Digest-Pinning läuft über Renovate)

## Beschreibung

Von 54 aus den Charts gerenderten Container-Images sind 52 nur über Tags referenziert, 3 davon über veränderliche Tags (`latest`, `stable`) bzw. ohne Tag. Ein Neustart des Pods kann damit unbemerkt andere Software ziehen. 34 Images stammen von Docker Hub (davon 6 mit `docker.io/`-Präfix; Rate-Limit- und Typosquatting-Risiko), 17 von ghcr.io, 2 von quay.io, 1 von registry.k8s.io.

## Nachweis

```
$ helm template … | grep -h 'image:' | sort -u | grep -E ':(latest|stable)$|^[^:]+$'
busybox
ianw/quickchart:latest
lldap/lldap:stable
$ ... | grep -c '@sha256'
2
```

## Risiko / Angriffsszenario

Unkontrollierte Updates (auch kompromittierte Upstream-Images) landen ohne Review und ohne Rollback-Pfad im Cluster. `lldap` ist der Identitätsspeicher.

## Empfohlene Behebung

1. Konkrete Versionen eintragen (`lldap/lldap:v0.6.1` o. ä., aktuelle Version prüfen).
2. In `renovate.json` `pinDigests: true` für Docker aktivieren, damit Renovate Digests pflegt:
   ```diff
   +  "packageRules": [
   +    { "matchDatasources": ["docker"], "pinDigests": true }
   +  ]
   ```
3. Für `busybox` im Zammad-Subchart `initContainers.image`/`global.image` setzen.

## Rollback

Vorheriges Tag eintragen und synchronisieren.

## Verifikation

```
helm template argocd/apps/prod/xibosignage | grep 'image:' | grep -c ':latest'
```
Ergebnis `0`.

## Risiko der Behebung

Niedrig: Image wird einmalig auf eine konkrete Version fixiert.

## Behebung (2026-10-18)

**Fix.**

- `lldap`: `stable` durch `v0.6.3` ersetzt. Die Docker-Hub-Tags `stable` und `v0.6.3` haben denselben Digest (`sha256:2a8454b6…`), und das laufende Image (`lldap --version`: 0.6.3) trägt ihn ebenfalls. Der Wechsel ändert nichts an der Software.
- quickchart (Xibo, PROD): `latest` durch `v1.8.1` ersetzt. `latest` und `v1.8.1` haben denselben Digest (`sha256:12e2d442…`), der im PROD-Cluster läuft.
- `renovate.json`: `pinDigests: true` für Docker, ausgenommen `ghcr.io/pkr-lab/**` (eigene Images, deren Tag `build-images.yml` und `bump-image-tag.py` setzen). Renovate ergänzt die Digests beim nächsten Lauf als PR.
- `busybox` ohne Tag im Zammad-Chart gehört zu einem Helm-Test-Pod (`wget` gegen nginx), der nicht deployt wird und über Values nicht änderbar ist; es läuft im Cluster kein `busybox`-Pod.

**Nachweis.**

| Test | Ergebnis |
|---|---|
| `helm template` aller Charts in TECH, PROD, ENTW, Suche nach `:latest`, `:stable` und Images ohne Tag | nur `busybox` (Zammad-Test-Pod) |
| Digest-Vergleich Docker Hub (API) mit dem laufenden Pod | lldap `stable` = `v0.6.3` = laufender Digest, quickchart `latest` = `v1.8.1` = laufender Digest |
| `renovate.json` | gültiges JSON |
| Doc-Link-Check | 0 kaputte Links |

**Geänderte Dateien.**

- `argocd/apps/tech/lldap/values.yaml`, `argocd/apps/prod/xibosignage/values.yaml`, `renovate.json`
- Doku: `docs/6-hintergruende/60040-helm-charts-tech.md`, `docs/f-cicd-automatisierung/f0020-renovate.md`

**Rollback.** `git revert`; für ein einzelnes Image das alte Tag zurückschreiben.

**Offen.** Die Digests selbst trägt Renovate in einem späteren PR nach (Montag vor 6 Uhr). Prüfen: Ob die `helm-values`-Erkennung für `repository` plus `tag` den Digest in `tag: "x@sha256:…"` schreibt, zeigt erst der erste PR.
