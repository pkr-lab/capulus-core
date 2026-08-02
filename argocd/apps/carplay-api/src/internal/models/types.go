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

// SystemMetrics is the aggregated fleet snapshot (VictoriaMetrics), mapped
// into the middle CarPlay column.
type SystemMetrics struct {
	CPU         float64 `json:"cpu"`         // 0-100, avg across monitored nodes
	RAM         float64 `json:"ram"`         // 0-100
	Disk        float64 `json:"disk"`        // 0-100, root filesystem
	Temperature float64 `json:"temperature"` // °C, hottest sensor
	Uptime      string  `json:"uptime"`      // "5d 12h 30m"
	LoadAvg     string  `json:"load_avg"`    // "0.45 0.62 0.58"
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

// DashboardResponse is the full payload for GET /api/dashboard.
type DashboardResponse struct {
	Alerts    []Alert         `json:"alerts"`
	Metrics   SystemMetrics   `json:"metrics"`
	Status    []ServiceStatus `json:"status"`
	UpdatedAt int64           `json:"updated_at"`
}

// HealthResponse is the payload for GET /health.
type HealthResponse struct {
	Status    string            `json:"status"`
	Timestamp int64             `json:"timestamp"`
	Services  map[string]string `json:"services"`
}
