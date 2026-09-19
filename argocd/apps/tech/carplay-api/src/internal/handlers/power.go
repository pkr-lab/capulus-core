package handlers

import (
	"crypto/subtle"
	"errors"
	"log/slog"
	"net/http"

	"github.com/gin-gonic/gin"

	"carplay-api/internal/clients"
	"carplay-api/internal/models"
)

// PowerHandler exposes brightness + wake/shutdown, proxied to power-agent
// (see clients.PowerAgentClient for why this can't be done from the pod
// itself). Every handler here maps an *AgentError back to the status code
// the agent reported, so e.g. an unreachable homeserver screen surfaces as
// a real error to the app instead of a misleading 200.
type PowerHandler struct {
	agent          *clients.PowerAgentClient
	shutdownCode   string
	shutdownCodeOn bool
	logger         *slog.Logger
}

func NewPowerHandler(agent *clients.PowerAgentClient, shutdownCode string, logger *slog.Logger) *PowerHandler {
	return &PowerHandler{
		agent:          agent,
		shutdownCode:   shutdownCode,
		shutdownCodeOn: shutdownCode != "",
		logger:         logger,
	}
}

func (h *PowerHandler) GetBrightness(c *gin.Context) {
	percent, err := h.agent.GetBrightness(c.Request.Context())
	if err != nil {
		h.respondAgentError(c, "reading brightness", err)
		return
	}
	c.JSON(http.StatusOK, models.BrightnessResponse{Percent: percent})
}

func (h *PowerHandler) SetBrightness(c *gin.Context) {
	var req models.BrightnessRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "percent must be an integer 0-100"})
		return
	}

	percent, err := h.agent.SetBrightness(c.Request.Context(), req.Percent)
	if err != nil {
		h.respondAgentError(c, "setting brightness", err)
		return
	}
	c.JSON(http.StatusOK, models.BrightnessResponse{Percent: percent})
}

func (h *PowerHandler) Wake(c *gin.Context) {
	var req models.WakeRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "target is required"})
		return
	}

	if req.Target == models.PowerTargetHomeserver {
		// The homeserver is the always-on control plane — it has no WoL
		// path to wake it from, see docs/2-betrieb-hardware/20020-cluster-power-manager.md.
		c.JSON(http.StatusBadRequest, gin.H{"error": "homeserver has no wake action"})
		return
	}

	if err := h.agent.Wake(c.Request.Context(), string(req.Target)); err != nil {
		h.respondAgentError(c, "waking "+string(req.Target), err)
		return
	}
	c.JSON(http.StatusOK, models.PowerActionResponse{Status: "ok"})
}

func (h *PowerHandler) Shutdown(c *gin.Context) {
	var req models.ShutdownRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "target is required"})
		return
	}

	if req.Target == models.PowerTargetHomeserver {
		if !h.shutdownCodeOn {
			h.logger.Warn("homeserver shutdown blocked: SHUTDOWN_CONFIRMATION_CODE not configured")
			c.JSON(http.StatusServiceUnavailable, gin.H{"error": "shutdown confirmation is not configured on the server"})
			return
		}
		provided := []byte(req.Code)
		expected := []byte(h.shutdownCode)
		if len(provided) != len(expected) || subtle.ConstantTimeCompare(provided, expected) != 1 {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "confirmation code does not match"})
			return
		}

		if err := h.agent.ShutdownSelf(c.Request.Context()); err != nil {
			h.respondAgentError(c, "shutting down homeserver", err)
			return
		}
		c.JSON(http.StatusOK, models.PowerActionResponse{Status: "ok"})
		return
	}

	if err := h.agent.Shutdown(c.Request.Context(), string(req.Target)); err != nil {
		h.respondAgentError(c, "shutting down "+string(req.Target), err)
		return
	}
	c.JSON(http.StatusOK, models.PowerActionResponse{Status: "ok"})
}

func (h *PowerHandler) respondAgentError(c *gin.Context, action string, err error) {
	var agentErr *clients.AgentError
	if errors.As(err, &agentErr) {
		h.logger.Warn(action+" failed", "error", err, "agent_status", agentErr.StatusCode)
		c.JSON(http.StatusBadGateway, gin.H{"error": action + " failed: power-agent returned " + http.StatusText(agentErr.StatusCode)})
		return
	}
	h.logger.Warn(action+" failed", "error", err)
	c.JSON(http.StatusBadGateway, gin.H{"error": action + " failed: power-agent unreachable"})
}
