// Package models holds every wire-format type returned by the carplay-api
// HTTP endpoints. Field names and JSON tags are the CarPlay app's contract —
// changing them is a breaking change for the iOS client.
package models

// Alert is one ntfy notification, mapped into the left CarPlay column.
type Alert struct {
	ID      string `json:"id"`
	Topic   string `json:"topic"`
	Title   string `json:"title"`
	Message string `json:"message"`
	Time    int64  `json:"time"`
	Level   string `json:"level"` // "critical", "warning", "info"
	PollID  string `json:"poll_id,omitempty"`
}

// HostMetrics is one monitored machine's snapshot (VictoriaMetrics),
// mapped into a card on the app's home screen. Online reflects the "up"
// scrape result for that instance — false (with every metric at its zero
// value) means the app should omit or gray out the card rather than show
// stale/misleading numbers.
type HostMetrics struct {
	ID          string  `json:"id"`   // stable slug: "homeserver", "worker-0", "worker-1", "nas"
	Name        string  `json:"name"` // display name
	Online      bool    `json:"online"`
	CPU         float64 `json:"cpu"`         // 0-100
	RAM         float64 `json:"ram"`         // 0-100
	Disk        float64 `json:"disk"`        // 0-100, root filesystem
	Temperature float64 `json:"temperature"` // °C, 0 if no sensor reports one (e.g. NAS)
	Uptime      string  `json:"uptime"`      // "5d 12h 30m", "" if offline
}

// ServiceStatus is one Uptime-Kuma monitor, mapped into the right CarPlay
// column.
type ServiceStatus struct {
	ID        string  `json:"id"`
	Name      string  `json:"name"`
	Status    string  `json:"status"` // "up", "down", "maintenance", "paused"
	Ping      int     `json:"ping"`   // ms
	Uptime    float64 `json:"uptime"` // % over 24h
	LastCheck int64   `json:"last_check"`
}

// ServiceActivity is one self-hosted app's current Traefik request rate —
// an activity proxy, NOT a distinct-user count (Traefik has no notion of
// identity, see clients.VictoriaMetricsClient.GetServiceActivity).
type ServiceActivity struct {
	ID                string  `json:"id"`
	Name              string  `json:"name"`
	RequestsPerSecond float64 `json:"requests_per_second"`
}

// DashboardResponse is the full payload for GET /api/dashboard.
type DashboardResponse struct {
	Alerts          []Alert           `json:"alerts"`
	Hosts           []HostMetrics     `json:"hosts"`
	Status          []ServiceStatus   `json:"status"`
	ServiceActivity []ServiceActivity `json:"service_activity"`
	UpdatedAt       int64             `json:"updated_at"`
}

// AppUpdate is one watched repo's update status, sourced from github-
// release-watcher's updates ConfigMap (argocd/apps/workloads/github-release-watcher).
// Pointer fields are nil when unknown — e.g. CurrentVersion is nil until
// someone fills in config.services entries' currentVersion in that chart's
// values.yaml, and HasUpdate stays nil (not false) whenever it can't be
// determined, so the app shows "unbekannt" instead of a false "up to date".
type AppUpdate struct {
	ID             string  `json:"id"`
	Name           string  `json:"name"`
	Repo           string  `json:"repo"`
	CurrentVersion *string `json:"current_version"`
	LatestVersion  *string `json:"latest_version"`
	LatestURL      *string `json:"latest_url"`
	HasUpdate      *bool   `json:"has_update"`
}

// UpdatesResponse is the payload for GET /api/updates.
type UpdatesResponse struct {
	UpdatedAt int64       `json:"updated_at"`
	Repos     []AppUpdate `json:"repos"`
}

// HealthResponse is the payload for GET /health.
type HealthResponse struct {
	Status    string            `json:"status"`
	Timestamp int64             `json:"timestamp"`
	Services  map[string]string `json:"services"`
}

// BrightnessResponse is the payload for GET/PUT /api/brightness.
type BrightnessResponse struct {
	Percent int `json:"percent"` // 0-100
}

// BrightnessRequest is the body for PUT /api/brightness.
type BrightnessRequest struct {
	Percent int `json:"percent" binding:"min=0,max=100"`
}

// PowerTarget identifies which machine a wake/shutdown request targets.
type PowerTarget string

const (
	PowerTargetHomeserver PowerTarget = "homeserver"
	PowerTargetWorker0    PowerTarget = "worker-0"
	PowerTargetWorker1    PowerTarget = "worker-1"
)

// WakeRequest is the body for POST /api/power/wake. Only worker-0/worker-1
// can be woken — the homeserver is the always-on control plane and has no
// WoL path (see docs/37-cluster-power-manager.md).
type WakeRequest struct {
	Target PowerTarget `json:"target" binding:"required"`
}

// ShutdownRequest is the body for POST /api/power/shutdown. Code is
// required (and checked against SHUTDOWN_CONFIRMATION_CODE) only when
// Target is "homeserver" — shutting down the control plane takes the whole
// cluster (including this API) down with it, so it gets an extra
// confirmation step the worker nodes don't need.
type ShutdownRequest struct {
	Target PowerTarget `json:"target" binding:"required"`
	Code   string      `json:"code"`
}

// PowerActionResponse is the payload for POST /api/power/wake and
// POST /api/power/shutdown.
type PowerActionResponse struct {
	Status string `json:"status"` // "ok"
}
