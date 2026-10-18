# 025 `vm-write` und `logs-write`: Schreibzugriff auf Metriken und Logs ohne Authentifizierung aus dem LAN

- Severity: Low
- Bereich: Netzwerk
- Betroffen: `argocd/apps/tech/monitoring/templates/ingress-vm-write.yaml`, `argocd/apps/tech/logging/templates/ingress-journal-push.yaml`
- Status: Im Code vorbereitet am 2026-10-18 (Basic-Auth hinter Schalter, Standard aus; Zugangsdaten erzeugen, Clients ausrollen, dann Schalter an: Schritte unten)

## Beschreibung

Zwei Ingresses geben die Schreibpfade von VictoriaMetrics (`vm-write.tech.homeserver/api/v1/write`) und VictoriaLogs (`logs-write.tech.homeserver/insert/journald`) frei, ohne Middleware, Basic-Auth oder IP-Filter. Die Endpunkte sind nur intern erreichbar, aber für das ganze LAN und Tailnet (Incident 008).

## Nachweis

```
$ sed -n 9,18p argocd/apps/tech/monitoring/templates/ingress-vm-write.yaml
    - host: vm-write.tech.homeserver
      http:
        paths:
          - path: /api/v1/write
$ grep -n 'path' argocd/apps/tech/logging/templates/ingress-journal-push.yaml
12:          - path: /insert/journald
```

## Risiko / Angriffsszenario

Ein Gerät im LAN kann gefälschte Metriken einspeisen (z. B. `up`-Reihen für ausgefallene Hosts, Heartbeats) und so Alarme unterdrücken oder auslösen, oder Speicher durch Flut-Schreibzugriffe füllen.

## Empfohlene Behebung

1. Traefik-Middleware `basicAuth` (Secret als SealedSecret) oder `ipAllowList` auf die Worker-/Pi-IPs an die beiden Ingresses hängen.
2. vmagent (`-remoteWrite.basicAuth.username/passwordFile`) und `systemd-journal-upload` (URL mit Zugangsdaten oder Client-Zertifikat) anpassen.

## Rollback

Annotation entfernen, synchronisieren.

## Verifikation

```
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://vm-write.tech.homeserver/api/v1/write
```
Ohne Zugangsdaten `401`/`403`, mit Zugangsdaten vom vmagent `204`. Grafana zeigt weiter Daten aller Hosts.

## Risiko der Behebung

Niedrig bis mittel: vmagent und `systemd-journal-upload` auf allen Hosts brauchen die neuen Zugangsdaten.

## Bearbeitungsstand (2026-10-18)

Nicht umgesetzt, weil die Umsetzung Änderungen an allen schreibenden Hosts braucht, die ich ohne dich nicht ausrollen kann.

- **Warum keine IP-Allowlist (Punkt 1, Variante `ipAllowList`):** Der Traefik-Service ist ein MetalLB-`LoadBalancer` (`192.168.178.200`) mit `externalTrafficPolicy: Cluster`. Dabei ersetzt das SNAT die Client-Adresse durch eine Node-Adresse, eine `ipAllowList` auf die Host-IPs würde die Quelle nicht sehen und entweder alles oder nichts durchlassen. Mit `externalTrafficPolicy: Local` würde sich das ändern, das ist aber eine Änderung am Eingangspfad aller Dienste.
- **Was bleibt:** `basicAuth` an beiden Ingresses (Middleware mit SealedSecret), dazu Zugangsdaten für `vmagent` (`-remoteWrite.basicAuth.username` und `-remoteWrite.basicAuth.passwordFile`) und `systemd-journal-upload` auf allen Hosts, Pis, PROD- und ENTW-VM. Das braucht neue Credentials (SealedSecret per `kubeseal`, Vault-Variablen) und einen Rollenlauf auf jedem Host; eine Reihenfolge ohne Lücke ist: erst Clients beide Wege (mit Zugangsdaten) vorbereiten, dann Middleware aktivieren. Sag Bescheid, wenn ich den Code dafür vorbereiten soll (Rollen-Variablen und Ingress-Middleware hinter einem Schalter, standardmäßig aus).

## Umsetzung (2026-10-18, nach Freigabe)

Gebaut ist `basicAuth` an beiden Ingresses, **standardmäßig aus**. Beschreibung, Begründung und Reihenfolge: `docs/6-hintergruende/60060-monitoring-und-alerting.md`, Abschnitt „Schreib-Endpunkte“.

- Server: `argocd/apps/tech/monitoring/templates/write-auth.yaml` und `argocd/apps/tech/logging/templates/write-auth.yaml` (SealedSecret plus Traefik-`Middleware`), Annotation an `ingress-vm-write.yaml` und `ingress-journal-push.yaml`, Schalter `writeAuth.enabled` und `writeAuth.encryptedUsers` in den `values.yaml`.
- Clients: Rollen `vmagent` und `journal_upload` (Zugangsdaten aus Vault-Variablen, ohne Variablen unverändert).
- `scripts/seal-write-auth.sh` erzeugt zwei Zugänge (`vm-writer`, `logs-writer`), versiegelt sie in beide `values.yaml` und schreibt die Vault-Zeilen in `~/write-auth-vault.yml`.

**Nachweis** (vor dem Rollout): `helm template` beider Charts ohne Schalter: keine Middleware; mit `--set writeAuth.enabled=true --set writeAuth.encryptedUsers=…`: Middleware, SealedSecret und Annotation vorhanden. Beide Client-Vorlagen mit und ohne Passwort gerendert (`URL=https://writer:…@logs-write…`, `-remoteWrite.basicAuth.*`), `--syntax-check` der Playbooks ok. Die Wirkung auf dem Server ist noch nicht live geprüft.

**Offen (du):** die vier Schritte aus 60060 ausführen, Befehle in der Zusammenfassung. Restrisiko: Das Log-Passwort kann bei einem Upload-Fehler im Journal (und damit in VictoriaLogs) stehen, weil `systemd-journal-upload` die URL ausgibt; der Zugang ist write-only und vom Metrik-Zugang getrennt.

## Stand der Einrichtung (2026-10-18)

`./scripts/seal-write-auth.sh` wurde ausgeführt: beide Benutzerdateien sind in `argocd/apps/tech/monitoring/values.yaml` und `argocd/apps/tech/logging/values.yaml` versiegelt (`writeAuth.encryptedUsers`), der Schalter `writeAuth.enabled` steht noch auf `false`. Die Vault-Zeilen liegen in `~/write-auth-vault.yml` und gehören in `capulus-ansible/group_vars/all.yml`. Als Nächstes: Merge, Rollenläufe mit den Tags `vmagent` und `journal-upload` auf allen Hosts, Prüfung, dann `enabled: true`.

