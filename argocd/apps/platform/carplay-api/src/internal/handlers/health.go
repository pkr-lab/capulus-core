package handlers

import (
	"context"
	"net/http"
	"sync"
	"time"

	"github.com/gin-gonic/gin"

	"carplay-api/internal/models"
)

// HealthHandler answers GET /health. It always returns 200 as long as the
// Go process itself can serve HTTP — with one replica, failing k8s's
// liveness/readiness probe because an upstream (ntfy, Uptime-Kuma, ...) is
// temporarily unreachable would only restart or de-route a perfectly
// healthy pod, achieving nothing. Per-dependency status is reported in the
// body for observability instead.
type HealthHandler struct {
	vmBaseURL   string
	ntfyBaseURL string
	kumaBaseURL string
	client      *http.Client
}

func NewHealthHandler(vmBaseURL, ntfyBaseURL, kumaBaseURL string, checkTimeout time.Duration) *HealthHandler {
	return &HealthHandler{
		vmBaseURL:   vmBaseURL,
		ntfyBaseURL: ntfyBaseURL,
		kumaBaseURL: kumaBaseURL,
		client:      &http.Client{Timeout: checkTimeout},
	}
}

func (h *HealthHandler) Handle(c *gin.Context) {
	ctx, cancel := context.WithTimeout(c.Request.Context(), 3*time.Second)
	defer cancel()

	services := map[string]string{
		"victoriametrics": "unknown",
		"ntfy":            "unknown",
		"uptimekuma":      "unknown",
	}
	var mu sync.Mutex
	var wg sync.WaitGroup

	checks := map[string]string{
		"victoriametrics": h.vmBaseURL + "/health",
		"ntfy":            h.ntfyBaseURL + "/v1/health",
		"uptimekuma":      h.kumaBaseURL + "/",
	}

	for name, url := range checks {
		wg.Add(1)
		go func(name, url string) {
			defer wg.Done()
			status := "ok"
			if !h.probe(ctx, url) {
				status = "error"
			}
			mu.Lock()
			services[name] = status
			mu.Unlock()
		}(name, url)
	}
	wg.Wait()

	c.JSON(http.StatusOK, models.HealthResponse{
		Status:    "healthy",
		Timestamp: time.Now().Unix(),
		Services:  services,
	})
}

func (h *HealthHandler) probe(ctx context.Context, url string) bool {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return false
	}
	resp, err := h.client.Do(req)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	return resp.StatusCode < 500
}
