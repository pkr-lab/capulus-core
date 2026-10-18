# capulus-core

GitOps-Repository des Capulus-Homelabs: ArgoCD-Applications für die drei k3s-Cluster TECH, PROD und ENTW, die Promotion-Kette ENTW → TECH → PROD, das Token-Register und die Hilfsskripte. Ein Merge nach `main` rollt auf TECH und PROD aus.

## Quickstart

```bash
git clone https://github.com/pkr-lab/capulus-core.git
cd capulus-core
make lint
python3 scripts/check-token-register.py
```

Neue App: Ordner unter `argocd/apps/<cluster>/<app>/` anlegen (Helm-Chart oder Manifeste), bei TECH zusätzlich den Namespace in `capulus-ansible` eintragen und `argocd/bootstrap/` neu rendern. Die Hosts und Cluster provisioniert [capulus-ansible](https://github.com/pkr-lab/capulus-ansible), die iOS-App liegt in [capulus-ios](https://github.com/pkr-lab/capulus-ios).

## Inhalt

| Pfad | Inhalt |
|---|---|
| `argocd/apps/{tech,prod,entw}/` | eine App pro Ordner |
| `argocd/bootstrap/`, `argocd/bootstrap-prod/` | Hub-ApplicationSet und AppProjects |
| `ops/token-register.yaml` | Register aller Tokens und Passwörter |
| `pki/` | Root-CA des Homelabs |
| `scripts/` | Promotion, Versiegeln, Checks |
| `.github/workflows/` | CI, Image-Builds, Promotion, Release |

## Dokumentation

Die gesamte Dokumentation liegt im Repo [pkr-lab-docs](https://github.com/pkr-lab/pkr-lab-docs):

- [Überblick und Architektur](https://github.com/pkr-lab/pkr-lab-docs/blob/main/capulus-core/index.md)
- [Installation](https://github.com/pkr-lab/pkr-lab-docs/blob/main/capulus-core/installation.md)
- [Konfiguration](https://github.com/pkr-lab/pkr-lab-docs/blob/main/capulus-core/konfiguration.md)
- [Nutzung](https://github.com/pkr-lab/pkr-lab-docs/blob/main/capulus-core/nutzung.md)
- [Releases](https://github.com/pkr-lab/pkr-lab-docs/blob/main/capulus-core/releases.md)

## Lizenz

MIT, siehe [LICENSE](LICENSE).
