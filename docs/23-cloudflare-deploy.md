# Cloudflare Tunnel — Deploy-Anleitung

Diese Anleitung deckt den **Rollout- und Day-2-Betrieb** des
`cloudflared`-ArgoCD-Apps ab: Erstdeployment, Verifikation, neuen Dienst
freigeben, Secrets rotieren, Troubleshooting.

> Konzept, Architektur und Erstinstallation (Tunnel anlegen, Domain zu
> Cloudflare hinzufügen, Credentials versiegeln) stehen in
> [docs/22-cloudflare-tunnel.md](22-cloudflare-tunnel.md). Diese Anleitung
> setzt voraus, dass du dort bis einschließlich Schritt 5
> (`values.yaml` befüllt) durch bist.

---

## Inhaltsverzeichnis

1. [Voraussetzungen](#voraussetzungen)
2. [Erstdeployment](#erstdeployment)
3. [Rollout verifizieren](#rollout-verifizieren)
4. [Neuen Dienst freigeben](#neuen-dienst-freigeben)
5. [Dienst wieder entfernen](#dienst-wieder-entfernen)
6. [Credentials rotieren](#credentials-rotieren)
7. [Skalierung & Ausfallsicherheit](#skalierung--ausfallsicherheit)
8. [Troubleshooting](#troubleshooting)
9. [Rollback](#rollback)

---

## Voraussetzungen

- Tunnel via `cloudflared tunnel create` angelegt (docs/22, Schritt 2).
- `tunnel.id` und `tunnel.encryptedCredentialsJson` in
  `argocd/apps/platform/cloudflared/values.yaml` eingetragen.
- Mindestens ein DNS-Route-Eintrag via `cloudflared tunnel route dns`
  angelegt (docs/22, Schritt 4).
- ArgoCD läuft und das Root-ApplicationSet ist aktiv
  (`argocd/bootstrap/root-applicationset.yaml`).
- Sealed-Secrets-Controller ist deployt (`argocd/apps/platform/sealed-secrets/`).

---

## Erstdeployment

Wie jede andere App in diesem Repo läuft das Deployment rein über Git —
kein zusätzlicher Ansible- oder Helm-Befehl nötig:

```bash
git add argocd/apps/platform/cloudflared
git commit -m "feat(cloudflared): add Cloudflare Tunnel for external access"
git push
```

ArgoCD erkennt das neue Verzeichnis `argocd/apps/platform/cloudflared/` innerhalb
von ca. 3 Minuten, legt die `Application` **cloudflared** im gleichnamigen
Namespace an und synct sie automatisch (`syncPolicy.automated` im
Root-ApplicationSet).

**Sync-Status prüfen:**

```bash
ssh ubuntu@192.168.178.94 \
  'sudo kubectl -n argocd get application cloudflared'

# Details/Fehler
ssh ubuntu@192.168.178.94 \
  'sudo kubectl -n argocd describe application cloudflared'
```

Manuellen Sync erzwingen (falls ArgoCD wartet):

```bash
ssh ubuntu@192.168.178.94 \
  'sudo kubectl -n argocd patch application cloudflared \
   -p "{\"operation\":{\"sync\":{}}}" --type merge'
```

---

## Rollout verifizieren

**Pods laufen (2 Replicas, siehe `values.yaml → replicaCount`):**

```bash
ssh ubuntu@192.168.178.94 'sudo kubectl -n cloudflared get pods'
```

**Logs — Tunnel sollte "Registered tunnel connection" melden:**

```bash
ssh ubuntu@192.168.178.94 \
  'sudo kubectl -n cloudflared logs deploy/cloudflared --tail=50'
```

**Tunnel-Health im Cloudflare-Dashboard:**

[Zero Trust Dashboard](https://one.dash.cloudflare.com) → **Networks →
Tunnels** → `homeserver` sollte **Healthy** mit mehreren aktiven
Connections (eine pro Replica × i. d. R. 4 Edge-Verbindungen) anzeigen.

**Externer Zugriffstest — wichtig: über Mobilfunknetz oder fremdes WLAN,
NICHT über das Heimnetz/Tailscale testen**, sonst prüfst du versehentlich
nur den internen Traefik-Pfad:

```bash
curl -I https://wiki.deine-domain.de
```

Erwartet: `HTTP/2 200` (oder ggf. eine Cloudflare-Access-Login-Seite,
falls Option B aus docs/22 aktiv ist).

---

## Neuen Dienst freigeben

`argocd/apps/platform/cloudflared/values.yaml` selbst bleibt dabei
**unangetastet** — sie enthält nur noch zwei bis drei Wildcard-Regeln (eine
pro Tier: `*.tech.pke-lab.de`, `*.prod.pke-lab.de`, ggf. `*.dev.pke-lab.de`),
die pauschal an Traefik weiterreichen. Freigeben passiert stattdessen direkt
in der `values.yaml` des jeweiligen Dienstes, analog zum internen
`*.homeserver`-Host. Kompletter Ablauf am Beispiel Grafana:

Mit der empfohlenen Wildcard-DNS-Route aus
[docs/22, Schritt 4](22-cloudflare-tunnel.md#schritt-4--dns-routing-wildcard-statt-einzel-records)
ist dafür **kein DNS-Schritt** mehr nötig — `grafana.tech.deine-domain.de`
löst durch den bestehenden `*`-Record bereits zum Tunnel auf.

```yaml
# argocd/apps/platform/monitoring/values.yaml (Beispiel Grafana, Tier "tech")
grafana:
  ingress:
    hosts:
      - grafana.tech.homeserver
      - grafana.tech.deine-domain.de          # neu — macht Grafana extern erreichbar
```

> **Nur falls du dich in docs/22 für die Alternative mit expliziten
> Einzel-Records entschieden hast:** zusätzlich
> `cloudflared tunnel route dns homeserver grafana.tech.deine-domain.de`
> ausführen.

```bash
git add argocd/apps/platform/monitoring/values.yaml
git commit -m "feat(monitoring): expose grafana externally"
git push
```

ArgoCD synct die App, Traefik übernimmt die neue Ingress-Regel automatisch
(kein Neustart von `cloudflared` nötig — der bekommt von alldem gar nichts
mit, seine Wildcard-Regel matchte den Hostnamen ja schon vorher, nur ohne
dass Traefik dahinter eine passende Route hatte). Testen:

```bash
curl -I https://grafana.tech.deine-domain.de
```

> Denk an [Cloudflare Access](22-cloudflare-tunnel.md#zusätzliche-absicherung-cloudflare-access),
> falls der neue Dienst nicht komplett offen im Internet stehen soll.

---

## Dienst wieder entfernen

Einfach den externen Host wieder aus `ingress.hosts` der App entfernen —
Traefik findet danach keine passende Route mehr, `cloudflareds`
Wildcard-Regel matcht zwar weiterhin, liefert aber (über Traefiks eigenen
404) denselben Effekt wie vorher `defaultService: http_status:404`:

```bash
# grafana.tech.deine-domain.de aus ingress.hosts in monitoring/values.yaml löschen, dann
git add argocd/apps/platform/monitoring/values.yaml
git commit -m "feat(monitoring): remove grafana from external access"
git push
```

> **Nur bei expliziten Einzel-Records (Alternative aus docs/22):**
> zusätzlich den `CNAME` im Cloudflare-Dashboard unter **DNS → Records**
> löschen, sonst bleibt der verwaiste Record stehen (harmlos, aber
> unübersichtlich).

---

## Credentials rotieren

Falls die `credentials.json` kompromittiert sein könnte (z. B. versehentlich
unverschlüsselt geteilt):

```bash
# 1. Alten Tunnel löschen (invalidiert die alte credentials.json sofort)
cloudflared tunnel delete homeserver

# 2. Neuen Tunnel anlegen
cloudflared tunnel create homeserver

# 3. Neue Tunnel-ID + neu versiegelte Credentials in values.yaml eintragen
#    (siehe docs/22, Schritt 2 + 3)

# 4. DNS-Route(n) neu anlegen (zeigen sonst noch auf die alte Tunnel-ID)
#    Mit Wildcard-Setup reicht ein einziger Befehl für alle Hostnamen:
cloudflared tunnel route dns homeserver "*.deine-domain.de"
#    Bei expliziten Einzel-Records (Alternative) stattdessen pro
#    aktivem Hostnamen wiederholen:
#      cloudflared tunnel route dns homeserver wiki.deine-domain.de
#      cloudflared tunnel route dns homeserver ntfy.deine-domain.de

git add argocd/apps/platform/cloudflared/values.yaml
git commit -m "fix(cloudflared): rotate tunnel credentials"
git push
```

---

## Skalierung & Ausfallsicherheit

`cloudflared` unterstützt mehrere gleichzeitige Replicas für denselben
Tunnel nativ (kein Leader-Election-Mechanismus nötig — jede Replica hält
eigene Edge-Connections). Die Replica-Zahl wird nicht mehr manuell über
`replicaCount` gepflegt, sondern per HPA automatisch zwischen 2 (Minimum,
für die zwei unabhängigen Edge-Verbindungen) und 4 geregelt, ausgelöst ab
CPU 70% (`autoscaling` in `values.yaml`; Details für alle Apps:
[39-hpa-autoscaling.md](39-hpa-autoscaling.md)). `replicaCount: 2` bleibt
als Fallback-Wert stehen, greift aber nur, falls `autoscaling.enabled`
auf `false` gesetzt wird.

Da der Home-Server ein Single-Node-Cluster ist
([README.md](../README.md)), schützt eine höhere Replica-Zahl primär vor
Pod-Neustarts/Rolling-Updates, nicht vor einem Node-Ausfall — die
grundsätzliche Verfügbarkeit hängt weiterhin am Home-Server selbst.

---

## Troubleshooting

Siehe primär [docs/22 → Troubleshooting](22-cloudflare-tunnel.md#troubleshooting).
Ergänzend für den Deploy-Kontext:

### ArgoCD zeigt `OutOfSync`, synct aber nicht automatisch

```bash
ssh ubuntu@192.168.178.94 \
  'sudo kubectl -n argocd get application cloudflared -o yaml | grep -A5 syncPolicy'
```

Sollte `automated: {prune: true, selfHeal: true}` zeigen (kommt aus dem
Root-ApplicationSet). Falls nicht, manuellen Sync erzwingen (siehe oben).

### ConfigMap-Änderung kommt nicht im Pod an

Der Helm-Chart triggert Rollouts über eine Checksum-Annotation auf dem
Deployment. Falls ein Rollout dennoch hängt:

```bash
ssh ubuntu@192.168.178.94 \
  'sudo kubectl -n cloudflared rollout restart deployment/cloudflared'
ssh ubuntu@192.168.178.94 \
  'sudo kubectl -n cloudflared rollout status deployment/cloudflared'
```

### `kubectl -n cloudflared get pods` zeigt `Pending`

Meist Ressourcenmangel oder ein Problem mit dem SealedSecret (Pod kann
das Secret-Volume nicht mounten, weil `cloudflared-credentials` noch
nicht existiert):

```bash
ssh ubuntu@192.168.178.94 \
  'sudo kubectl -n cloudflared get sealedsecret,secret'
```

Falls das `Secret` fehlt, obwohl die `SealedSecret` existiert: Der
Sealed-Secrets-Controller konnte den Ciphertext nicht entschlüsseln
(falscher Namespace/Name beim `kubeseal`-Aufruf in docs/22, Schritt 3) —
Ciphertext neu erzeugen und `values.yaml` korrigieren.

---

## Rollback

Wie jede andere App per Git-Revert:

```bash
git log --oneline -- argocd/apps/platform/cloudflared
git revert <commit-hash>
git push
```

ArgoCD synct den vorherigen Zustand automatisch zurück. Um den kompletten
Tunnel vorübergehend zu deaktivieren, ohne ihn zu löschen, reicht es, das
ArgoCD-App-Verzeichnis nicht zu ändern und stattdessen `replicaCount: 0`
zu setzen und zu pushen — die DNS-Einträge bleiben bestehen, aber es
antwortet niemand mehr.
