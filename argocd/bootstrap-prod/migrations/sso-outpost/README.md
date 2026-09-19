# Authentik-SSO in PROD (zurueckgestellt)

Diese Manifeste sind **nicht deployt** (kein ApplicationSet liest diesen Ordner).
Sie stellen Authentik-SSO fuer PROD-Apps bereit und werden gebraucht, sobald eine
App hinter der Middleware `authentik-authentik@kubernetescrd` nach PROD zieht.
Vorerst ist die Middleware aus den PROD-Apps ausgebaut (Batch 4, mealie).

Inhalt: `outpost.yaml` (Authentik-Proxy-Outpost, meldet sich per Token bei
Authentik in TECH an), `middleware.yaml` (ForwardAuth auf den Outpost). Die
oeffentliche Root-CA fuer die Verbindung nach TECH (ConfigMap `homeserver-root-ca`
im Namespace `authentik`, Schluessel `ca.pem`) liegt hier bewusst nicht; beim
Wiedereinschalten erzeugen (siehe unten).

Warum ein Remote-Outpost und keine Middleware direkt gegen TECH: siehe
docs/4-planung/40080-multi-cluster-entw-prod-tech.md (Batch 4). Kurz: der
Traefik in TECH ueberschreibt X-Forwarded-Host, Authentik liefert 404.

## Wieder einschalten

1. Ordner nach `argocd/apps/prod/authentik/` verschieben und in
   `argocd/bootstrap-prod/applicationset.yaml` (Set `home-server-apps-prod`) den
   Pfad `argocd/apps/prod/authentik` in der Liste ergaenzen; ApplicationSet erneut
   anwenden. (Der Namespace `authentik` steht schon im AppProject `prod`.)
2. CA-ConfigMap aus der oeffentlichen Root-CA erzeugen (nur Zertifikat, kein Schluessel):
   `kubectl create configmap homeserver-root-ca -n authentik --from-file=ca.pem=docs/assets/homeserver-root-ca.pem --dry-run=client -o yaml > argocd/apps/prod/authentik/root-ca-configmap.yaml`
3. Outpost `prod` in Authentik anlegen und Token als SealedSecret ablegen, siehe
   `argocd/bootstrap-prod/migrations/README.md`, Abschnitt "Remote-Outpost".
4. In den PROD-Apps die Annotation
   `traefik.ingress.kubernetes.io/router.middlewares: "authentik-authentik@kubernetescrd"`
   wieder setzen (mealie: `argocd/apps/prod/mealie/values.yaml`).
