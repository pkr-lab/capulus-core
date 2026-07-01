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
  `argocd/apps/cloudflared/values.yaml` eingetragen.
- Mindestens ein DNS-Route-Eintrag via `cloudflared tunnel route dns`
  angelegt (docs/22, Schritt 4).
- ArgoCD läuft und das Root-ApplicationSet ist aktiv
  (`argocd/bootstrap/root-applicationset.yaml`).
- Sealed-Secrets-Controller ist deployt (`argocd/apps/sealed-secrets/`).

---

## Erstdeployment

Wie jede andere App in diesem Repo läuft das Deployment rein über Git —
kein zusätzlicher Ansible- oder Helm-Befehl nötig:

```bash
git add argocd/apps/cloudflared
git commit -m "feat(cloudflared): add Cloudflare Tunnel for external access"
git push
```

ArgoCD erkennt das neue Verzeichnis `argocd/apps/cloudflared/` innerhalb
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

Kompletter Ablauf, um z. B. Grafana zusätzlich freizugeben. Mit der
empfohlenen Wildcard-DNS-Route aus
[docs/22, Schritt 4](22-cloudflare-tunnel.md#schritt-4--dns-routing-wildcard-statt-einzel-records)
ist dafür **kein DNS-Schritt** mehr nötig — `grafana.deine-domain.de`
löst durch den bestehenden `*`-Record bereits zum Tunnel auf, es fehlt nur
noch die Ingress-Regel:

```bash
# 1. Internen Service-Namen und Port prüfen
ssh ubuntu@192.168.178.94 'sudo kubectl -n monitoring get svc'

# 2. Ingress-Regel in values.yaml ergänzen
```

> **Nur falls du dich in docs/22 für die Alternative mit expliziten
> Einzel-Records entschieden hast:** vor Schritt 2 zusätzlich
> `cloudflared tunnel route dns homeserver grafana.deine-domain.de`
> ausführen.

```yaml
# argocd/apps/cloudflared/values.yaml
tunnel:
  ingress:
    rules:
      - hostname: wiki.deine-domain.de
        service: http://wikijs-wikijs.wikijs.svc.cluster.local:80
      - hostname: ntfy.deine-domain.de
        service: http://ntfy.ntfy.svc.cluster.local:80
      - hostname: grafana.deine-domain.de          # neu
        service: http://monitoring-grafana.monitoring.svc.cluster.local:80
```

```bash
git add argocd/apps/cloudflared/values.yaml
git commit -m "feat(cloudflared): expose grafana externally"
git push
```

ArgoCD synct die geänderte ConfigMap, der `cloudflared`-Pod liest die
neue `config.yaml` beim nächsten Neustart automatisch ein (Helm-Chart
setzt dafür intern einen Checksum-Annotation-Rollout aus — kein manueller
Restart nötig). Falls du sofort testen willst:

```bash
ssh ubuntu@192.168.178.94 \
  'sudo kubectl -n cloudflared rollout restart deployment/cloudflared'
```

> Denk an [Cloudflare Access](22-cloudflare-tunnel.md#zusätzliche-absicherung-cloudflare-access),
> falls der neue Dienst nicht komplett offen im Internet stehen soll.

---

## Dienst wieder entfernen

Mit der Wildcard-DNS-Route reicht das Entfernen der Ingress-Regel — der
Hostname bleibt zwar über den `*`-Record technisch auflösbar, liefert aber
mangels passender Regel nur noch `defaultService: http_status:404`:

```bash
# Eintrag aus tunnel.ingress.rules in values.yaml löschen, dann
git add argocd/apps/cloudflared/values.yaml
git commit -m "feat(cloudflared): remove grafana from external access"
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

git add argocd/apps/cloudflared/values.yaml
git commit -m "fix(cloudflared): rotate tunnel credentials"
git push
```

---

## Skalierung & Ausfallsicherheit

`cloudflared` unterstützt mehrere gleichzeitige Replicas für denselben
Tunnel nativ (kein Leader-Election-Mechanismus nötig — jede Replica hält
eigene Edge-Connections). Default in `values.yaml` ist `replicaCount: 2`.

Höher schrauben, falls gewünscht:

```yaml
replicaCount: 3
```

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
git log --oneline -- argocd/apps/cloudflared
git revert <commit-hash>
git push
```

ArgoCD synct den vorherigen Zustand automatisch zurück. Um den kompletten
Tunnel vorübergehend zu deaktivieren, ohne ihn zu löschen, reicht es, das
ArgoCD-App-Verzeichnis nicht zu ändern und stattdessen `replicaCount: 0`
zu setzen und zu pushen — die DNS-Einträge bleiben bestehen, aber es
antwortet niemand mehr.
