# Tailscale-Runner-PoC — kommt ein GitHub-Runner an das interne ArgoCD?

[`.github/workflows/tailscale-poc.yml`](../../.github/workflows/tailscale-poc.yml)
ist ein reiner Machbarkeitsnachweis (Phase 0, Schritt 0.8 in
[40080](../4-planung/40080-multi-cluster-entw-prod-tech.md)): Kann ein
GitHub-Actions-Cloud-Runner per Tailscale dem Tailnet beitreten und das nicht
öffentlich erreichbare ArgoCD ansprechen? Die Antwort entscheidet, ob eine
spätere Promotion-Stufe mit Health-Gate (ArgoCD-Status, Smoke-Tests gegen
`*.dev.homeserver`) aus GitHub Actions heraus möglich ist, ohne einen Port zu
öffnen.

**Stand:** der Workflow wurde angelegt und das Secret gesetzt, aber **noch nie
ausgeführt** (0 Läufe). Er läuft nur manuell und ist für den Dauerbetrieb nicht
gedacht. Die [ENTW-Promotion](f0080-entw-promotion.md) braucht ihn noch nicht, sie
gibt nur anhand der CI frei.

## Ablauf

1. `tailscale/github-action` holt den Runner mit dem Auth-Key temporär ins Tailnet.
2. `tailscale status` zeigt die erreichbaren Knoten.
3. `curl -sk https://homeserver:30443` gegen ArgoCD; jeder HTTP-Status außer einem
   Verbindungsfehler gilt als Erfolg (es geht um Erreichbarkeit, nicht um Login).

## Voraussetzungen

| Was | Wo |
|---|---|
| Repo-Secret `TAILSCALE_AUTHKEY` | GitHub → Settings → Secrets (gesetzt am 2026-09-18). Für einen wechselnden Runner passt ein *reusable* Key; die Voreinstellungen für Server-Keys (single-use, nicht ephemeral) in [c0010](../c-netzwerk-dns/c0010-tailscale.md#auth-key-besorgen) gelten hier nicht. |
| ACL, die den Runner-Tag auf `homeserver:30443` zulässt | [c0010-tailscale.md → ACL-Konfiguration](../c-netzwerk-dns/c0010-tailscale.md#acl-konfiguration) |

## Ausführen und Ergebnis

GitHub → Actions → „Tailscale Runner PoC“ → *Run workflow*. Grün = Ansatz
tauglich, Schritt 0.8 in 40080 kann abgehakt werden.

## Troubleshooting

| Symptom | Ursache / Lösung |
|---|---|
| Schritt „Connect runner to tailnet“ scheitert mit Auth-Fehler | Key abgelaufen, nicht reusable oder falsch kopiert — neuen Key erzeugen, Secret ersetzen. |
| `tailscale status` zeigt den Homeserver nicht | ACL erlaubt den Runner-Tag nicht — Tag/ACL in der Tailscale-Admin-Konsole prüfen. |
| `curl` läuft in ein Timeout | Der Runner sieht den Homeserver im Tailnet, aber `:30443` ist für ihn nicht erreichbar — ACL (Port) und UFW auf dem Homeserver prüfen. |
| Workflow bricht mit „FEHLGESCHLAGEN“ ab | Meldung des letzten Schritts, wenn `curl` gar keine Verbindung bekam — Ursache siehe die Zeilen darüber. |

Die Inputs `oauth-client-id`/`oauth-secret` sind im Workflow leer gelassen,
angemeldet wird über `authkey`.
