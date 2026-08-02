# carplay-api

Read-only aggregation API for the **Homeserver CarPlay Dashboard** iOS app.
Combines VictoriaMetrics (system metrics), ntfy (alerts) and Uptime-Kuma
(service status) into one payload, cached for 30s, served over Gin.

Full setup/operations guide: [`docs/43-carplay-api.md`](../../../docs/43-carplay-api.md).

## Deviations from the original spec

A few things in the original spec don't match how this cluster (or the
upstream services) actually work. Rather than ship something that 404s or
lies about its security model, these were adjusted — details in
docs/43-carplay-api.md:

- **Uptime-Kuma**: no Bearer-token `/api/status_page/monitors` REST API
  exists in real Uptime-Kuma. The client uses Kuma's actual (public,
  unauthenticated) status-page JSON API instead — requires a status page
  configured in the Kuma UI.
- **K8s packaging**: this is a Helm chart (`Chart.yaml` + `values.yaml` +
  `templates/`), like every other app in `argocd/apps/`, not raw
  kustomize/kubectl YAML. Secrets are `SealedSecret`s, not plaintext.
- **Namespace**: `carplay-api`, not `homeserver-app` — the root
  `ApplicationSet` derives the namespace from the directory name.
- **mTLS**: not implemented. Traefik in this cluster doesn't terminate
  client-certificate TLS, so a "cert pinning" check here would have had
  nothing behind it. The real boundary is Bearer token + restricting ingress
  to the Tailscale network (`IP_ALLOWLIST_CIDRS`), see below.
- **CORS**: kept, but it's a browser-only mechanism and doesn't restrict the
  iOS app (URLSession ignores it) or non-browser clients. The actual network
  restriction is the IP allowlist / Tailscale-only ingress.

## Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/health` | none | Liveness/readiness. Always 200 if the process is up; body reports per-dependency reachability for diagnostics. |
| GET | `/metrics` | none (ClusterIP-internal) | Prometheus text exposition: request counts/durations, cache hit/miss. |
| GET | `/api/dashboard` | Bearer token (if `CARPLAY_API_TOKEN` set) | Combined alerts + metrics + status, cached 30s. |

## Configuration (environment variables)

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | HTTP listen port. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`. |
| `CACHE_TTL` | `30` | Dashboard cache lifetime, seconds. |
| `API_TIMEOUT` | `5` | Overall budget across the 3 upstream calls, seconds. |
| `CARPLAY_API_TOKEN` | *(empty)* | Bearer token required on `/api/*`. **Unset = no auth**, logged loudly at startup — set this in production. |
| `IP_ALLOWLIST_CIDRS` | *(empty)* | Comma-separated CIDRs; empty = allow all. E.g. Tailscale CGNAT range `100.64.0.0/10`. |
| `CORS_ALLOWED_ORIGINS` | *(empty)* | Comma-separated allowed Origins; empty = CORS headers never sent. |
| `RATE_LIMIT_PER_MINUTE` | `100` | Per-client-IP fixed-window limit on `/api/*`. |
| `TRUSTED_PROXIES` | *(empty = trust none)* | CIDRs of proxies allowed to set `X-Forwarded-For` (needed for correct client IPs behind Traefik). |
| `VM_URL` | `http://vmsingle-monitoring-victoria-metrics-k8s-stack.monitoring.svc.cluster.local:8428` | VictoriaMetrics query API base. |
| `VM_INSTANCE_FILTER` | `homeserver\|worker-0\|worker-1` | Regex alternation of `instance` labels to aggregate. |
| `NTFY_URL` | `http://ntfy.ntfy.svc.cluster.local` | ntfy base URL. |
| `NTFY_TOPIC` | `alerts` | Topic to poll. |
| `NTFY_TOKEN` | *(empty)* | Optional ntfy access token (unneeded while ntfy's `auth-default-access` is `read-write`). |
| `NTFY_SINCE` | `12h` | How far back to poll cached messages. |
| `NTFY_LIMIT` | `10` | Max alerts returned. |
| `UPTIME_KUMA_URL` | `http://uptime-kuma.uptime-kuma.svc.cluster.local` | Uptime-Kuma base URL. |
| `UPTIME_KUMA_SLUG` | `homeserver` | Status-page slug to read. |

## Local development

```bash
cd src
go run ./cmd/server
# in another shell
curl localhost:8080/health
```

## Build & push (this repo's actual CI, not GitHub Actions)

There's no GitHub Actions in this repo — image builds go through the
`kaniko-build-push` Argo WorkflowTemplate already installed by
`argocd/apps/argo-workflows/`:

```bash
argo submit --from workflowtemplate/kaniko-build-push \
  -p repo=https://github.com/pkr-lab/capulus-core.git \
  -p revision=main \
  -p context=argocd/apps/carplay-api \
  -p dockerfile=argocd/apps/carplay-api/Dockerfile \
  -p image=ghcr.io/<your-gh-username>/carplay-api:latest
```

Then point `image.repository`/`image.tag` in `values.yaml` at the pushed
image (and an `imagePullSecrets` entry if the GHCR package is private).

## Tests

None yet — see docs/43-carplay-api.md for suggested coverage
(`internal/clients` PromQL/ntfy/Kuma parsing are the highest-value targets,
since they're the parts most likely to drift from upstream API changes).
