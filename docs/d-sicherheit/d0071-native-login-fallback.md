# Native Anmeldung — Fallback-URLs statt Authelia

Seit dem Authelia-Rollout ([d0070-authelia-sso.md](d0070-authelia-sso.md))
hat jede geschützte App zusätzlich zu ihrem normalen, Authelia-gesicherten
Hostnamen einen zweiten, ungeschützten `-native`-Hostnamen — direkter Zugriff
auf die App-eigene Anmeldemaske, ohne über Authelia zu gehen. Gedacht für:
native Mobile-/Desktop-Clients, die keinen Browser-Redirect verstehen, sowie
als bewusster manueller Fallback, falls Authelia selbst nicht erreichbar ist
oder man aus einem anderen Grund die App-eigene Anmeldung braucht.

---

## URLs

| App | Authelia-geschützt (Standard) | Native Anmeldung (Fallback) |
|---|---|---|
| Uptime Kuma | https://uptime-kuma.prod.homeserver | https://uptime-kuma-native.prod.homeserver |
| Mealie | https://mealie.prod.homeserver / https://mealie-prod.pke-lab.de | https://mealie-native.prod.homeserver |

Grafana, Immich und Nextcloud haben **keinen** `-native`-Host mehr — alle
drei liegen (Stand 22.08.2026, siehe
[d0070-authelia-sso.md](d0070-authelia-sso.md)) nicht mehr hinter Authelia,
eigener App-Login reicht, kein Bypass nötig.

Diese Tabelle wächst mit jedem weiteren Rollout-Batch
([d0070-authelia-sso.md](d0070-authelia-sso.md) → Rollout-Log).

---

## Warum kein Link direkt auf Authelias Login-Seite

Authelia erlaubt nur Favicon-/Logo-/Text-Overrides, kein Einfügen eines
echten Links in die Login-Maske selbst, ohne das Frontend zu forken (siehe
[40000-authelia-sso.md](../4-planung/40000-authelia-sso.md), Baustein 3).
Diese Seite hier ist deshalb der tatsächliche "Knopfdruck" — als Bookmark
oder Link aus Wiki.js heraus, nicht als Button auf der Authelia-Seite selbst.
