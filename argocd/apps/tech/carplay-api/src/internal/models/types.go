package models

type Alert struct {
	ID      string `json:"id"`
	Topic   string `json:"topic"`
	Title   string `json:"title"`
	Message string `json:"message"`
	Time    int64  `json:"time"`
	Level   string `json:"level"`
	PollID  string `json:"poll_id,omitempty"`
}

type HostMetrics struct {
	ID          string  `json:"id"`
	Name        string  `json:"name"`
	Online      bool    `json:"online"`
	CPU         float64 `json:"cpu"`
	RAM         float64 `json:"ram"`
	Disk        float64 `json:"disk"`
	Temperature float64 `json:"temperature"`
	Uptime      string  `json:"uptime"`
}

type ServiceStatus struct {
	ID        string  `json:"id"`
	Name      string  `json:"name"`
	Status    string  `json:"status"`
	Ping      int     `json:"ping"`
	Uptime    float64 `json:"uptime"`
	LastCheck int64   `json:"last_check"`
}

type ServiceActivity struct {
	ID                string  `json:"id"`
	Name              string  `json:"name"`
	RequestsPerSecond float64 `json:"requests_per_second"`
}

type DashboardResponse struct {
	Alerts          []Alert           `json:"alerts"`
	Hosts           []HostMetrics     `json:"hosts"`
	Status          []ServiceStatus   `json:"status"`
	ServiceActivity []ServiceActivity `json:"service_activity"`
	UpdatedAt       int64             `json:"updated_at"`
}

type AppUpdate struct {
	ID             string  `json:"id"`
	Name           string  `json:"name"`
	Repo           string  `json:"repo"`
	CurrentVersion *string `json:"current_version"`
	LatestVersion  *string `json:"latest_version"`
	LatestURL      *string `json:"latest_url"`
	HasUpdate      *bool   `json:"has_update"`
}

type UpdatesResponse struct {
	UpdatedAt int64       `json:"updated_at"`
	Repos     []AppUpdate `json:"repos"`
}

type HealthResponse struct {
	Status    string            `json:"status"`
	Timestamp int64             `json:"timestamp"`
	Services  map[string]string `json:"services"`
}

type BrightnessResponse struct {
	Percent int `json:"percent"`
}

type BrightnessRequest struct {
	Percent int `json:"percent" binding:"min=0,max=100"`
}

type PowerTarget string

const (
	PowerTargetHomeserver PowerTarget = "homeserver"
	PowerTargetWorker0    PowerTarget = "worker-0"
	PowerTargetWorker1    PowerTarget = "worker-1"
)

type WakeRequest struct {
	Target PowerTarget `json:"target" binding:"required"`
}

type ShutdownRequest struct {
	Target PowerTarget `json:"target" binding:"required"`
	Code   string      `json:"code"`
}

type PowerActionResponse struct {
	Status string `json:"status"`
}
