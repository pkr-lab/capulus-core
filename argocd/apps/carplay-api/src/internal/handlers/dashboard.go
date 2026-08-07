// Package handlers implements the two HTTP endpoints carplay-api exposes.
package handlers

import (
	"context"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/gin-gonic/gin"

	"carplay-api/internal/cache"
	"carplay-api/internal/clients"
	"carplay-api/internal/models"
	"carplay-api/pkg/metrics"
)

// DashboardHandler assembles GET /api/dashboard from three independent
// upstreams, cached for the configured TTL. Every upstream call already
// carries its own short timeout inside its client (see internal/clients);
// overallTimeout is the outer budget across all three combined.
type DashboardHandler struct {
	vm    *clients.VictoriaMetricsClient
	ntfy  *clients.NtfyClient
	kuma  *clients.UptimeKumaClient
	hosts []clients.HostConfig
	cache *cache.TTLCache[models.DashboardResponse]
	stats *metrics.Registry

	overallTimeout time.Duration
	ntfyLimit      int
	ntfySince      string

	logger *slog.Logger
}

func NewDashboardHandler(
	vm *clients.VictoriaMetricsClient,
	ntfy *clients.NtfyClient,
	kuma *clients.UptimeKumaClient,
	hosts []clients.HostConfig,
	cacheTTL, overallTimeout time.Duration,
	ntfyLimit int,
	ntfySince string,
	stats *metrics.Registry,
	logger *slog.Logger,
) *DashboardHandler {
	return &DashboardHandler{
		vm:             vm,
		ntfy:           ntfy,
		kuma:           kuma,
		hosts:          hosts,
		cache:          cache.New[models.DashboardResponse](cacheTTL),
		stats:          stats,
		overallTimeout: overallTimeout,
		ntfyLimit:      ntfyLimit,
		ntfySince:      ntfySince,
		logger:         logger,
	}
}

func (h *DashboardHandler) Handle(c *gin.Context) {
	if cached, ok := h.cache.Get(); ok {
		h.stats.RecordCacheHit()
		c.JSON(http.StatusOK, cached)
		return
	}
	h.stats.RecordCacheMiss()

	ctx, cancel := context.WithTimeout(c.Request.Context(), h.overallTimeout)
	defer cancel()

	alerts := []models.Alert{}
	statuses := []models.ServiceStatus{}
	var hostMetrics []models.HostMetrics

	var wg sync.WaitGroup
	wg.Add(3)

	go func() {
		defer wg.Done()
		result, err := h.ntfy.GetAlerts(ctx, h.ntfySince, h.ntfyLimit)
		if err != nil {
			h.logger.Warn("ntfy fetch failed, showing no alerts", "error", err)
			return
		}
		alerts = result
	}()

	go func() {
		defer wg.Done()
		// Per-host queries degrade internally (missing metric -> zero
		// value, missing "up" series -> Online=false) — there's no
		// all-or-nothing failure mode to log here.
		hostMetrics = h.vm.GetHostMetrics(ctx, h.hosts)
	}()

	go func() {
		defer wg.Done()
		result, err := h.kuma.GetStatuses(ctx)
		if err != nil {
			h.logger.Warn("uptime-kuma fetch failed, showing no statuses", "error", err)
			return
		}
		statuses = result
	}()

	wg.Wait()

	response := models.DashboardResponse{
		Alerts:    alerts,
		Hosts:     hostMetrics,
		Status:    statuses,
		UpdatedAt: time.Now().Unix(),
	}

	h.cache.Set(response)
	c.JSON(http.StatusOK, response)
}
