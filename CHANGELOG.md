## [4.0.0](https://github.com/pkr-lab/capulus-core/compare/v3.97.2...v4.0.0)

Bündelt die Breaking Changes seit [v3.0.0](https://github.com/pkr-lab/capulus-core/compare/v3.0.0...v3.97.2). Alle Änderungen laufen bereits auf TECH und PROD, das Release hebt nur die Major-Version und hält die nötigen Anpassungen fest. Die Versionen 3.56.0 bis 3.97.2 stehen nur in den [GitHub Releases](https://github.com/pkr-lab/capulus-core/releases).

### ⚠ BREAKING CHANGES

* **repo:** `ansible/` liegt in [capulus-ansible](https://github.com/pkr-lab/capulus-ansible), `ios/` in [capulus-ios](https://github.com/pkr-lab/capulus-ios), `docs/`, `IdeasToDeploy.md` und die App-READMEs in [pkr-lab-docs](https://github.com/pkr-lab/pkr-lab-docs). `argocd/bootstrap/` entsteht in capulus-ansible mit `make render-bootstrap CORE_DIR=<Pfad zu capulus-core>`. Der CI-Job `docs-links` und `scripts/check-doc-links.py` entfallen. ([fbbc711](https://github.com/pkr-lab/capulus-core/commit/fbbc711e7ef7a627da637ce45fee78c11a8776f7), [75ea17d](https://github.com/pkr-lab/capulus-core/commit/75ea17da3b64f822edd51e82ff0615ed67e0486a), [90e27fc](https://github.com/pkr-lab/capulus-core/commit/90e27fc04229702c1b82039dd5229e5158387d42))
* **release:** `.releaserc.json` entfällt, semantic-release läuft über den zentralen Workflow in [pkr-lab/.github](https://github.com/pkr-lab/.github). `CHANGELOG.md` wird nicht mehr automatisch fortgeschrieben, die Release Notes stehen in den [GitHub Releases](https://github.com/pkr-lab/capulus-core/releases). ([000aa15](https://github.com/pkr-lab/capulus-core/commit/000aa155e3a59013dd1c1b528ea8b76f528e1e6e), [9db7095](https://github.com/pkr-lab/capulus-core/commit/9db7095bed27d87799879493e535e49735e8879c))
* **domain:** Die öffentliche Zone ist `pkr-lab.de` statt `pke-lab.de`. Externe Hosts heißen `<app>-tech.pkr-lab.de` bzw. `<app>-prod.pkr-lab.de`, die Tunnel bedienen die alten Namen nicht mehr. Gespeicherte URLs in Clients (ntfy-App, Bitwarden, iOS-App, externe Webhook-Aufrufer) umstellen. Der MDM-`profilePrefix` bleibt `de.pke-lab.mdm`. ([8a8ea68](https://github.com/pkr-lab/capulus-core/commit/8a8ea68db98a6c2da9c3c313a6b1bfd1b597dba9))
* **uptime-kuma, ticket-gate:** Die öffentliche Status-Page und ticket-gate erlauben als Origin nur noch `https://pkr-docs.de` und `https://www.pkr-docs.de`, `edv-kretzer.de` entfällt. ([2424b6e](https://github.com/pkr-lab/capulus-core/commit/2424b6e0e88387f09c09da40417ce3b08926ff7d), [3b9f34c](https://github.com/pkr-lab/capulus-core/commit/3b9f34cd841d1d2c61eabc3f6cb29263190482d2))
* **apps:** Entfernt: TECH `authentik` (SSO und 2FA per ForwardAuth entfallen, die Nutzer bleiben in lldap), `gotify` und `gotify-bridge` (Push nur noch über ntfy), `ollama` (n8n nutzt den Ollama-PC im LAN) und `pacman`, PROD `mealie`, `tinyteller` und `demo-app`. ([b76dd86](https://github.com/pkr-lab/capulus-core/commit/b76dd867d0a27cedb4bc10f3bbc131d7928f022f), [cc3e681](https://github.com/pkr-lab/capulus-core/commit/cc3e681e9b7e68dcd8e43067be2c9c6339a4f6ac), [d697609](https://github.com/pkr-lab/capulus-core/commit/d697609155a6c6476e5e9ec6bc8c52b66806db05), [243f3d7](https://github.com/pkr-lab/capulus-core/commit/243f3d7517eeb6cbc2439862add3b25232eb5f5b))
* **ntfy:** `auth-default-access` steht auf `deny-all`. Lesen und Schreiben ohne Token oder Login scheitert mit 401/403, auch aus dem Cluster. Sender brauchen einen Token des Benutzers `publisher`, Leser den Benutzer `reader`. ([f8068bd](https://github.com/pkr-lab/capulus-core/commit/f8068bd29a5258532cb84c80921424dc7618bd26), [225b273](https://github.com/pkr-lab/capulus-core/commit/225b2732de619739bc34ca6518d800e4a639b9e5))
* **n8n:** Die Webhooks `alamos-einsatz`, `banana-pi-down` und `nightly-worker-update` verlangen Header-Auth, Aufrufe ohne Header weist n8n ab. Editor und Webhooks laufen über `https://n8n-tech.pkr-lab.de` mit Secure-Cookie, `N8N_BASIC_AUTH_ACTIVE` entfällt. ([94c1e39](https://github.com/pkr-lab/capulus-core/commit/94c1e390f266e64821daa94c9e34ce196dd4e317))
* **argocd:** Die NodePorts 30080/30443 entfallen. API, CLI und CI erreichen ArgoCD nur noch über den HTTPS-Ingress (`argocd.tech.homeserver`, `argocd.dev.homeserver`) mit Zertifikatsprüfung gegen `pki/homeserver-root-ca.pem`. ([45eb100](https://github.com/pkr-lab/capulus-core/commit/45eb100289062ff3427693bfbeb2d70d6188cf8c), [f4244ba](https://github.com/pkr-lab/capulus-core/commit/f4244ba33dcb2f5ab2a148f509b6d03bfa46c951))
* **prod:** NetworkPolicy mit Ingress-Default-Deny für wikijs, wiki-docs-sync, xibosignage, paperless-ngx, immich und nextcloud: Verbindungen nur noch aus dem eigenen Namespace und aus `kube-system` (Traefik). Weitere Namespaces über `networkPolicy.extraIngressNamespaces` freigeben. ([abd738a](https://github.com/pkr-lab/capulus-core/commit/abd738ac955aa82bc9a55f9d1c71430d9d44583a), [966c149](https://github.com/pkr-lab/capulus-core/commit/966c1499fc6b45388e3fc0db99bd4661b87aa57a))
* **vaultwarden:** `/admin` ist nur noch aus dem LAN (`192.168.178.0/24`) und dem Tailnet (`100.64.0.0/10`) erreichbar. Das restic-Backup ist eine `Backup`-Ressource des capulus-operator und braucht dessen CRDs aus `argocd/apps/tech/capulus-operator`. ([56b58e1](https://github.com/pkr-lab/capulus-core/commit/56b58e1431f88c83cb15f370f56b28b2e8082b32), [b38ade8](https://github.com/pkr-lab/capulus-core/commit/b38ade86c1bcdaadc495a74ba081d21defd162d2))
* **entw:** Die eigene ArgoCD liest `argocd/apps/entw/` auf dem Branch `entw`, die ApplicationSets und AppProjects `platform` und `workloads` entfallen auch dort. ([0ec4673](https://github.com/pkr-lab/capulus-core/commit/0ec46731716ded9aa7c2e9e1ba7e12c993d2fc01))
* **wiki-docs-sync:** Quelle ist pkr-lab-docs (Image `ghcr.io/pkr-lab/capulus-wiki-sync`), Ziel der Pfad `docs/` in Wiki.js. Der alte Seitenbaum `Github/capulus-core` ist gelöscht. ([e506ab7](https://github.com/pkr-lab/capulus-core/commit/e506ab7af507d37b8e338fc1c53f836ad9f25f03), [7d4cf99](https://github.com/pkr-lab/capulus-core/commit/7d4cf99fd1983de220bf634bbe7b914b91135b23))
* **hosts:** Vor dem Repo-Split eingeführt, gepflegt in capulus-ansible und capulus-ios: SSH ohne Passwort- und Root-Login, UFW ohne offene Cluster-Ports und ohne pauschale LAN-/Tailnet-Regel, power-agent lauscht nur auf der cni0-Adresse des homeservers, carplay-api und WoL-Agent nur noch per HTTPS (ATS-Ausnahme der iOS-App entfernt). ([153ae35](https://github.com/pkr-lab/capulus-core/commit/153ae3513f2aea71645e549463febca9a2434d40), [0887700](https://github.com/pkr-lab/capulus-core/commit/0887700dcbc355f3ce5c110fc91680dfb8913554), [9cc8e4a](https://github.com/pkr-lab/capulus-core/commit/9cc8e4a09c33aa07dd9abe6b660eb1ea80baa255), [c1ae2fa](https://github.com/pkr-lab/capulus-core/commit/c1ae2faf17fcdeab97155133876bed8671e0da5d))

## [3.55.0](https://github.com/pkr-lab/capulus-core/compare/v3.54.0...v3.55.0) (2026-10-19)

### Features

* **n8n:** enable restic backup and add encrypted password ([df2886c](https://github.com/pkr-lab/capulus-core/commit/df2886ce7151cab59f6b1b50aef22303648062f3))

## [3.54.0](https://github.com/pkr-lab/capulus-core/compare/v3.53.0...v3.54.0) (2026-10-19)

### Features

* **uptime-kuma:** CORS-Header für die öffentliche Status-Page der Website ([d31fdca](https://github.com/pkr-lab/capulus-core/commit/d31fdcaee1d4bfc6eca47c1a2c1d66ff4bd05115))

## [3.53.0](https://github.com/pkr-lab/capulus-core/compare/v3.52.2...v3.53.0) (2026-10-19)

### Features

* **n8n:** verschlüsseltes restic-Backup hinter Schalter (Incident 037) ([073b487](https://github.com/pkr-lab/capulus-core/commit/073b487cfda76c9a23e0c1c44cb6ff9a8f5665dd))

## [3.52.2](https://github.com/pkr-lab/capulus-core/compare/v3.52.1...v3.52.2) (2026-10-19)

### Bug Fixes

* **n8n:** update storageClassName to local-path and add nodeSelector ([77a1d35](https://github.com/pkr-lab/capulus-core/commit/77a1d3550658e15e3a6bed73c6ed9635309c1a8c))

## [3.52.1](https://github.com/pkr-lab/capulus-core/compare/v3.52.0...v3.52.1) (2026-10-19)

### Bug Fixes

* **renovate:** wiki-sync-Image ohne Wartezeit und Wochenfenster aktualisieren ([05ed5fb](https://github.com/pkr-lab/capulus-core/commit/05ed5fbc1037a58b744031fdfdb8913b3b5034c8))
* **renovate:** Wochenfenster auf ganzen Montag erweitern und nur capulus-Repos bearbeiten ([64d7ec7](https://github.com/pkr-lab/capulus-core/commit/64d7ec7c9e808435b2d6e6bdc9d9acbb96f641f5))

## [3.52.0](https://github.com/pkr-lab/capulus-core/compare/v3.51.0...v3.52.0) (2026-10-18)

### Features

* **ci:** Release und Commitlint über die zentralen Workflows ([727623c](https://github.com/pkr-lab/capulus-core/commit/727623c3044b4388091782be451f0a7634e9d636))
