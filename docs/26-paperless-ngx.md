# Paperless-ngx — Dokumentenmanagement mit OCR

Paperless-ngx digitalisiert Briefe, Rechnungen und Verträge per OCR und macht
sie volltextdurchsuchbar. Dokumente können per Scanner, Smartphone-Foto oder
E-Mail eingereicht werden — alles Weitere läuft automatisch.

---

## Architektur

```
paperless.homeserver  →  Traefik  →  paperless-ngx (Port 8000)
                                          ├── Redis Sidecar (localhost:6379)
                                          ├── PVC: data   (20 Gi, nas)
                                          ├── PVC: media  (50 Gi, nas)
                                          ├── PVC: consume (5 Gi, nas)
                                          ├── PVC: export (10 Gi, nas)
                                          └── PVC: redis   (1 Gi, nas)
```

- **OCR-Sprachen:** Deutsch + Englisch (konfigurierbar via `PAPERLESS_OCR_LANGUAGE`)
- **Datenbank:** SQLite (ausreichend für Home-Lab, keine externe DB nötig)
- **Redis:** als Sidecar-Container im selben Pod (Adresse: `localhost:6379`)

---

## Erster Start

Nach dem Deploy muss ein Admin-Account angelegt werden:

```bash
kubectl -n paperless-ngx exec -it deploy/paperless-ngx -- \
  python3 manage.py createsuperuser
```

Danach ist die Web-UI unter **http://paperless.homeserver** erreichbar.

---

## Secret Key sichern

Der `PAPERLESS_SECRET_KEY` in `values.yaml` ist ein Platzhalter und **muss**
vor dem ersten produktiven Einsatz durch einen echten geheimen Wert ersetzt
werden. Empfohlen: SealedSecret anlegen.

```bash
# Zufälligen Key generieren:
python3 -c "import secrets; print(secrets.token_hex(50))"

# Als SealedSecret:
echo -n "<generated-key>" | kubeseal --raw \
  --namespace paperless-ngx --name paperless-ngx-secret \
  --from-file=/dev/stdin
```

Dann in `values.yaml` die Env-Variable auf einen `secretKeyRef` umstellen.

---

## Dokumente einreichen

### Consume-Ordner (automatisch)

Dateien im Consume-Verzeichnis werden automatisch verarbeitet. Der PVC
`paperless-ngx-consume` kann per `kubectl cp` befüllt werden:

```bash
kubectl -n paperless-ngx cp /lokale/datei.pdf \
  $(kubectl -n paperless-ngx get pod -l app.kubernetes.io/name=paperless-ngx \
    -o jsonpath='{.items[0].metadata.name}'):/usr/src/paperless/consume/
```

### Web-Upload

Direkt über die Web-UI unter **http://paperless.homeserver/upload**.

### E-Mail-Import (optional)

Paperless kann E-Mails mit Anhängen automatisch abholen (IMAP). Konfiguration
in der Admin-UI unter *Mail* → *E-Mail-Konten*.

---

## n8n-Integration

Mit n8n (http://n8n.homeserver) lassen sich Paperless-Ereignisse
weiterverarbeiten, z. B.:

```
Neues Dokument in Paperless (Webhook)
  → Kategorisierung prüfen
  → ntfy-Push "📄 Neue Rechnung erkannt: {Titel}"
```

Paperless bietet eine REST-API unter `http://paperless.homeserver/api/`.

---

## Backup

```bash
# Export aller Dokumente (inkl. Metadaten):
kubectl -n paperless-ngx exec deploy/paperless-ngx -- \
  document_exporter ../export

# Export-Verzeichnis lokal sichern:
kubectl -n paperless-ngx cp \
  $(kubectl -n paperless-ngx get pod -l app.kubernetes.io/name=paperless-ngx \
    -o jsonpath='{.items[0].metadata.name}'):/usr/src/paperless/export/ \
  ./paperless-backup/
```

---

## Konfiguration (values.yaml)

| Key | Bedeutung | Default |
|---|---|---|
| `persistence.media.size` | Speicher für Originaldokumente | `50Gi` |
| `persistence.data.size` | Datenbank + Thumbnails + Caches | `20Gi` |
| `env.PAPERLESS_OCR_LANGUAGE` | Tesseract-Sprachcodes | `deu+eng` |
| `env.PAPERLESS_URL` | Öffentliche URL für Links | `http://paperless.homeserver` |
| `resources.limits.memory` | RAM-Limit (OCR ist speicherhungrig) | `2Gi` |
