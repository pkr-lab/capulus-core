package handlers

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"

	"carplay-api/internal/cache"
	"carplay-api/internal/clients"
	"carplay-api/internal/models"
)

type UpdatesHandler struct {
	k8s           *clients.K8sConfigMapClient
	namespace     string
	configMapName string
	cache         *cache.TTLCache[models.UpdatesResponse]
	logger        *slog.Logger
}

func NewUpdatesHandler(
	k8s *clients.K8sConfigMapClient,
	namespace, configMapName string,
	cacheTTL time.Duration,
	logger *slog.Logger,
) *UpdatesHandler {
	return &UpdatesHandler{
		k8s:           k8s,
		namespace:     namespace,
		configMapName: configMapName,
		cache:         cache.New[models.UpdatesResponse](cacheTTL),
		logger:        logger,
	}
}

func (h *UpdatesHandler) Handle(c *gin.Context) {
	if cached, ok := h.cache.Get(); ok {
		c.JSON(http.StatusOK, cached)
		return
	}

	empty := models.UpdatesResponse{Repos: []models.AppUpdate{}}

	if h.k8s == nil {
		c.JSON(http.StatusOK, empty)
		return
	}

	ctx, cancel := context.WithTimeout(c.Request.Context(), 3*time.Second)
	defer cancel()

	raw, err := h.k8s.GetConfigMapData(ctx, h.namespace, h.configMapName, "updates.json")
	if err != nil {
		h.logger.Warn("reading updates configmap failed", "error", err)
		c.JSON(http.StatusOK, empty)
		return
	}
	if raw == "" {
		c.JSON(http.StatusOK, empty)
		return
	}

	var response models.UpdatesResponse
	if err := json.Unmarshal([]byte(raw), &response); err != nil {
		h.logger.Warn("decoding updates configmap failed", "error", err)
		c.JSON(http.StatusOK, empty)
		return
	}
	if response.Repos == nil {
		response.Repos = []models.AppUpdate{}
	}

	h.cache.Set(response)
	c.JSON(http.StatusOK, response)
}
