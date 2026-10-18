# 004 Vaultwarden: Admin-Oberfläche `/admin` über das Internet erreichbar

- Severity: Medium
- Bereich: Extern
- Betroffen: `argocd/apps/tech/vaultwarden/values.yaml:41-43` (Host `vault-tech.pke-lab.de`, Pfad `/`), `adminSecret.enabled: true`
- Status: Behoben am 2026-10-17

## Beschreibung

Der Ingress leitet `vault-tech.pke-lab.de` mit Pfad-Präfix `/` an Vaultwarden. Weil `adminSecret.enabled: true` ist (Admin-Token gesetzt), ist die Admin-Oberfläche `/admin` damit weltweit erreichbar. Der Token liegt als SealedSecret vor, ob er ein Argon2-Hash oder ein Klartext-Token ist, ist aus dem Repo nicht erkennbar. Die Oberfläche erlaubt u. a. Nutzerverwaltung, Einladungen, Einstellungen und Diagnose. `SIGNUPS_ALLOWED` ist korrekt `false`.

## Nachweis

```
$ sed -n 36,44p argocd/apps/tech/vaultwarden/values.yaml
  hosts:
    - host: vault.tech.homeserver
      paths:
        - path: /
          pathType: Prefix
    - host: vault-tech.pke-lab.de
      paths:
        - path: /
          pathType: Prefix

$ grep -n -A3 '^adminSecret' argocd/apps/tech/vaultwarden/values.yaml
adminSecret:
  enabled: true
  secretName: vaultwarden-admin
  encryptedAdminToken: "Ag…(maskiert)"
```

## Risiko / Angriffsszenario

Ein Angreifer kann den Admin-Token per Brute-Force oder Credential-Stuffing angreifen (Vaultwarden hat für `/admin` kein eigenes Lockout außer dem Rate-Limit der Login-Route). Bei Erfolg: Nutzer löschen oder deaktivieren, Einladungen verschicken, SMTP-Einstellungen auslesen. Der Tresor selbst bleibt Ende-zu-Ende-verschlüsselt, ein Admin-Zugriff ist trotzdem ein schwerer Vorfall.

## Empfohlene Behebung

1. `/admin` nur aus LAN/Tailnet zulassen. Zweiter Ingress für den öffentlichen Host mit Middleware, die nur interne Quellen erlaubt:
   ```yaml
   apiVersion: traefik.io/v1alpha1
   kind: Middleware
   metadata:
     name: admin-nur-intern
     namespace: vaultwarden
   spec:
     ipAllowList:
       sourceRange:
         - 192.168.178.0/24
         - 100.64.0.0/10
   ```
   Der Ingress für `vault-tech.pke-lab.de` mit Pfad `/admin` bekommt die Annotation `traefik.ingress.kubernetes.io/router.middlewares: vaultwarden-admin-nur-intern@kubernetescrd`. Anfragen über den Tunnel kommen von der cloudflared-Pod-IP und werden damit blockiert.
2. Alternativ oder zusätzlich im Cloudflare-WAF `URI Path starts with /admin` für diesen Host blockieren.
3. Admin-Token als Argon2-PHC-Hash hinterlegen (`vaultwarden hash`), oder den Token entfernen, wenn `/admin` nicht gebraucht wird (dann ist die Oberfläche deaktiviert).
4. 2FA für alle Konten erzwingen (Organisationsrichtlinie).

## Rollback

Ingress-Regel und Middleware entfernen, synchronisieren. Bei einem Fehler in der Middleware bleibt der Tresor-Zugriff über die Pfade `/api` und `/identity` unberührt.

## Verifikation

```
curl -s -o /dev/null -w '%{http_code}\n' https://vault-tech.pke-lab.de/admin
```
muss `403` (oder `404`) liefern, aus dem LAN über `https://vault.tech.homeserver/admin` weiterhin `200`. Login der Bitwarden-Clients gegen `https://vault-tech.pke-lab.de` testen.

## Risiko der Behebung

Niedrig: eine zusätzliche Ingress-Regel, der Tresor-Zugriff der Clients bleibt unberührt.

## Behebung (2026-10-17)

**Fix** (PR #453, Merge `0f712ec`): Punkt 1 der Empfehlung. Ein zweiter Ingress `vaultwarden-admin` für den Pfad `/admin` am öffentlichen Host `vault-tech.pke-lab.de` trägt die Traefik-Middleware `vaultwarden-admin-nur-intern` (`ipAllowList` mit `192.168.178.0/24` und `100.64.0.0/10`). Anfragen durch den Cloudflare-Tunnel kommen von der cloudflared-Pod-IP und sind damit nie im erlaubten Bereich. Der interne Host `vault.tech.homeserver` und alle anderen Pfade bleiben unverändert. Ohne `ipStrategy.depth` zählt die Verbindungsadresse, ein selbst gesetztes `X-Forwarded-For` hebt die Sperre nicht aus.

Die weiteren Punkte der Empfehlung:

| Punkt | Stand |
|---|---|
| 2 Cloudflare-WAF-Regel für `/admin` | bewusst nicht gesetzt (optionale zweite Schicht im Cloudflare-Dashboard, in der Vaultwarden-Doku vermerkt) |
| 3 Admin-Token als Argon2-PHC-Hash | bereits so: Prüfung am 2026-10-17 ergab „hash“, keine Rotation nötig |
| 4 2FA für alle Konten | laut Betreiber bereits aktiv |

**Nachweis** (vorher gemessen, nachher nach dem Sync):

| Test | Vorher | Nachher |
|---|---|---|
| `https://vault-tech.pke-lab.de/admin` | `200` | `403` |
| `…/admin/`, `…/admin/users` | nicht gemessen | `403` |
| `…/admin` mit `X-Forwarded-For`, `X-Real-IP` oder `Forwarded` auf eine LAN-Adresse | nicht gemessen | `403` |
| `https://vault.tech.homeserver/admin` (intern) | `200` | `200` |
| öffentlich `/`, `/api/alive`, `/api/config`, `/app-id.json` | `200` | `200` |
| `POST /identity/accounts/prelogin` (Client-Login) | nicht gemessen | `200`, identisch zum internen Host |

Die Client-Pfade (`/identity`, `/api`, `/notifications/hub`) antworten auf dem öffentlichen und dem internen Host gleich. Ein echter Login mit einem Bitwarden-Client wurde nicht ausgeführt, der Tresor-Zugriff läuft über unveränderte Pfade.

**Geänderte Dateien.**

- `argocd/apps/tech/vaultwarden/templates/middleware-admin.yaml` (neu)
- `argocd/apps/tech/vaultwarden/templates/ingress-admin.yaml` (neu)
- `argocd/apps/tech/vaultwarden/values.yaml` (Block `adminRestriction`)
- `docs/3-apps-workloads/300a0-vaultwarden.md`, `docs/6-hintergruende/60040-helm-charts-tech.md`

**Rollback.** In `argocd/apps/tech/vaultwarden/values.yaml` `adminRestriction.enabled: false`, mergen, ArgoCD entfernt Ingress und Middleware. Der Tresor-Zugriff der Clients ist davon nicht betroffen.

**Hinweise.**

- Traefik matcht `Prefix` als reinen String-Präfix, gesperrt ist daher alles unter `/admin…` (auch `/administrator`). Vaultwarden hat dort keine Route.
- Fehlt die Middleware oder stimmt der Name in der Annotation nicht, verwirft Traefik den Router stillschweigend und `/admin` ist wieder offen (fail-open). Nach jeder Änderung an Namen oder Namespace von außen `/admin` testen: erwartet `403`.
