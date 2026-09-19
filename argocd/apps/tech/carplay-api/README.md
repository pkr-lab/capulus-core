# carplay-api

Backend for the **Homeserver Dashboard** iOS app (a pure iPhone app — no
CarPlay component; this directory/namespace kept its name from an earlier
CarPlay-oriented cut of the project). Combines VictoriaMetrics (per-host
metrics), ntfy (alerts) and Uptime-Kuma (service status) into one payload,
cached for 30s, served over Gin — plus brightness and Wake-on-LAN/shutdown
endpoints proxied to power-agent (`ansible/roles/power_agent`) on the
homeserver host.

Full setup/operations guide: [`docs/3-apps-workloads/300d0-carplay-api.md`](../../../docs/3-apps-workloads/300d0-carplay-api.md).

## Deviations from the original spec

A few things in the original spec don't match how this cluster (or the
upstream services) actually work. Rather than ship something that 404s or
lies about its security model, these were adjusted — details in
docs/3-apps-workloads/300d0-carplay-api.md:

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
| GET | `/api/dashboard` | Bearer token (if `CARPLAY_API_TOKEN` set) | Combined alerts + per-host metrics + status, cached 30s. |
| GET | `/api/brightness` | Bearer token | Current Homeserver screen brightness, proxied to power-agent. |
| PUT | `/api/brightness` | Bearer token | Body `{"percent": 0-100}` — sets Homeserver screen brightness. |
| POST | `/api/power/wake` | Bearer token | Body `{"target": "worker-0"\|"worker-1"}` — sends a WoL magic packet. |
| POST | `/api/power/shutdown` | Bearer token | Body `{"target": "worker-0"\|"worker-1"\|"homeserver", "code"?: "..."}` — `code` required and checked against `SHUTDOWN_CONFIRMATION_CODE` only when `target` is `"homeserver"`. |
| GET | `/api/updates` | Bearer token | Per-repo update status (name, current vs. latest GitHub release) read from the `github-release-watcher`'s `updates` ConfigMap — see [docs/f-cicd-automatisierung/f0040-github-release-watcher.md](../../../docs/f-cicd-automatisierung/f0040-github-release-watcher.md). |

Brightness and power endpoints are proxied to **power-agent**
(`ansible/roles/power_agent`), a small privileged daemon on the bare
Homeserver host — this pod runs unprivileged and has no host/sysfs/SSH
access of its own, see [docs/3-apps-workloads/300d0-carplay-api.md](../../../docs/3-apps-workloads/300d0-carplay-api.md#power-agent).

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
| `HOSTS` | see `values.yaml` `config.hosts` | `id\|name\|instance` triples, comma-separated — one per host card on the app's home screen. `instance` must match VictoriaMetrics' `instance` label exactly. |
| `NTFY_URL` | `http://ntfy.ntfy.svc.cluster.local` | ntfy base URL. |
| `NTFY_TOPIC` | `alerts` | Topic to poll. |
| `NTFY_TOKEN` | *(empty)* | Optional ntfy access token (unneeded while ntfy's `auth-default-access` is `read-write`). |
| `NTFY_SINCE` | `12h` | How far back to poll cached messages. |
| `NTFY_LIMIT` | `10` | Max alerts returned. |
| `UPTIME_KUMA_URL` | `http://uptime-kuma.uptime-kuma.svc.cluster.local` | Uptime-Kuma base URL. |
| `UPTIME_KUMA_SLUG` | `homeserver` | Status-page slug to read. |
| `POWER_AGENT_URL` | `http://192.168.178.94:9101` | Base URL of the power-agent daemon on the Homeserver host. |
| `POWER_AGENT_TOKEN` | *(empty)* | Bearer token for power-agent. Unset = every brightness/power request fails with 502. |
| `POWER_AGENT_TIMEOUT` | `8` | Timeout for power-agent calls, seconds — poweroff/WoL can take longer than the 3s VictoriaMetrics budget. |
| `SHUTDOWN_CONFIRMATION_CODE` | *(empty)* | Required to match `code` on `POST /api/power/shutdown` with `target: "homeserver"`. Unset = homeserver shutdown always rejected with 503. |

## Local development

```bash
cd src
go run ./cmd/server
# in another shell
curl localhost:8080/health
```

## Build & push

Automated via [`.github/workflows/build-images.yml`](../../../../.github/workflows/build-images.yml)
on every push to `main` touching `Dockerfile`/`src/**` here — builds and
pushes to `ghcr.io/pkr-lab/carplay-api`. See
[pacman/README.md](../pacman/README.md#image-bauen) for the general
mechanics (tag scheme, where the run reports the new tag, manual
`workflow_dispatch` rebuild). The workflow does not touch `values.yaml`;
set `image.tag` to the reported tag and commit that yourself (and add an
`imagePullSecrets` entry if the GHCR package is private).

## Tests

None yet — see docs/3-apps-workloads/300d0-carplay-api.md for suggested coverage
(`internal/clients` PromQL/ntfy/Kuma parsing are the highest-value targets,
since they're the parts most likely to drift from upstream API changes).
