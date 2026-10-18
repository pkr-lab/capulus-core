# 030 MinIO-OIDC-`clientSecret` im Klartext in der Git-Historie des öffentlichen Repos

- Severity: Low
- Bereich: Repo
- Betroffen: Commit `6626b2b` (2026-06-10) `argocd/apps/minio/values.yaml:61`, `.gitleaksignore`
- Status: Behoben am 2026-10-18 (geprüft: Authentik und OIDC-Client existieren nirgends mehr, keine Änderung nötig)

## Beschreibung

Im Commit `6626b2b` stand der OIDC-`clientSecret` für MinIO im Klartext in der `values.yaml`, mit dem damaligen Kommentar „Repo ist privat – kein kubeseal nötig“. Das Repo ist inzwischen öffentlich. Der aktuelle MinIO-Chart nutzt kein OIDC mehr (`oidc`/`authentik` kommen in `argocd/apps/tech/minio/values.yaml` nicht vor), und Authentik wurde entfernt; der Fund ist deshalb voraussichtlich ohne Wirkung, solange kein Authentik-Client mit dem Secret weiter existiert.

## Nachweis

```
$ git show 6626b2b:argocd/apps/minio/values.yaml | sed -n 57,61p
  oidc:
    enabled: true
    configUrl: "…(maskiert)"
    clientId: "…(maskiert)"
    clientSecret: "…(maskiert)"
$ grep -n -i 'oidc\|authentik' argocd/apps/tech/minio/values.yaml
(keine Treffer)
```

## Risiko / Angriffsszenario

Nur relevant, falls der OIDC-Client in einer wiederhergestellten oder noch laufenden Authentik-Instanz existiert: Dann kann jemand mit dem Secret Tokens für MinIO anfordern.

## Empfohlene Behebung

Prüfen, ob in einer noch vorhandenen Authentik-Instanz der Client `minio` existiert, und ihn löschen bzw. das Secret rotieren. `.gitleaksignore` nach der Prüfung um den Eintrag bereinigen (Historie bleibt).

## Rollback

Nicht erforderlich.

## Verifikation

Authentik-Admin → Applications → OAuth2-Provider `minio` nicht vorhanden bzw. neues Secret gesetzt; `git grep` im Arbeitsstand liefert keine `clientSecret`-Werte im Klartext.

## Risiko der Behebung

Niedrig: Der Authentik-OIDC-Client existiert mit der Entfernung von Authentik im Oktober 2026 vermutlich nicht mehr.

## Behebung (2026-10-18)

**Prüfung statt Änderung.** Der Fund hat keine Wirkung mehr, weil es den Aussteller des Secrets nicht mehr gibt:

| Prüfung | Ergebnis |
|---|---|
| Namespaces, Pods, Ingresses, Deployments mit `authentik` im Namen in TECH (`kubectl get … -A`) | keine |
| dasselbe in PROD (`prod-vm`) und ENTW (`entw-vm`, per `k3s kubectl`) | keine |
| `git grep -i oidc` im Chart `argocd/apps/tech/minio` | keine Treffer, MinIO nutzt keinen OIDC mehr |
| Verweise auf Authentik im Arbeitsstand | Kommentare in `uptime-kuma/templates/ingress-native.yaml` und im Immich-Backup-Template sowie das Feld `authentik-bind-password` im SealedSecret von lldap (siehe unten) |

Das Secret aus Commit `6626b2b` gehört damit zu einem Client einer Instanz, die nicht mehr läuft. Es gibt nichts zu rotieren. DNS (`authentik.tech.homeserver`, `authentik-tech.pke-lab.de`) löst nur über die Wildcard auf, dahinter steht kein Dienst.

**Bewusst nicht geändert: `.gitleaksignore`.** Die Empfehlung, den Eintrag nach der Prüfung zu entfernen, würde die CI brechen: Der Commit bleibt in der öffentlichen Historie, gitleaks würde ihn bei jedem Lauf über die ganze Historie wieder melden. Der Eintrag bleibt, mit dem Vermerk in der Datei.

**Geänderte Dateien.** Keine (nur diese Incident-Datei).

**Rollback.** Nicht erforderlich.

**Offen.**

- Das SealedSecret `argocd/apps/tech/lldap/templates/sealedsecret.yaml` enthält noch `authentik-bind-password`, das Bind-Passwort eines lldap-Benutzers für Authentik. Wird der Benutzer in lldap nicht mehr gebraucht, sollten Benutzer und Schlüssel entfernt werden (Löschen eines Zugangs, das ich ohne dich nicht vornehme).
- Falls jemals ein Authentik-Backup mit dem Client wiederhergestellt wird, den Client `minio` dort vor dem Start löschen.
