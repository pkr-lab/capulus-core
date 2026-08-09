// Command server runs carplay-api: a small read-only aggregation API that
// combines VictoriaMetrics, ntfy and Uptime-Kuma into the single payload the
// Homeserver CarPlay Dashboard iOS app polls every 30 seconds.
package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/gin-gonic/gin"

	"carplay-api/internal/clients"
	"carplay-api/internal/handlers"
	"carplay-api/pkg/auth"
	"carplay-api/pkg/metrics"
)

func main() {
	cfg := loadConfig()

	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: cfg.logLevel}))
	slog.SetDefault(logger)

	if err := run(cfg, logger); err != nil {
		logger.Error("server exited with error", "error", err)
		os.Exit(1)
	}
}

func run(cfg config, logger *slog.Logger) error {
	if cfg.logLevel > slog.LevelDebug {
		gin.SetMode(gin.ReleaseMode)
	}

	vm := clients.NewVictoriaMetricsClient(cfg.vmURL, 3*time.Second, logger)
	ntfy := clients.NewNtfyClient(cfg.ntfyURL, cfg.ntfyTopic, cfg.ntfyToken, 2*time.Second, logger)
	kuma := clients.NewUptimeKumaClient(cfg.kumaURL, cfg.kumaSlug, 2*time.Second, logger)
	powerAgent := clients.NewPowerAgentClient(cfg.powerAgentURL, cfg.powerAgentToken, cfg.powerAgentTimeout)

	stats := metrics.NewRegistry()
	dashboardHandler := handlers.NewDashboardHandler(
		vm, ntfy, kuma, cfg.hosts, cfg.services,
		cfg.cacheTTL, cfg.apiTimeout,
		cfg.ntfyLimit, cfg.ntfySince,
		stats, logger,
	)
	healthHandler := handlers.NewHealthHandler(cfg.vmURL, cfg.ntfyURL, cfg.kumaURL, 2*time.Second)
	powerHandler := handlers.NewPowerHandler(powerAgent, cfg.shutdownConfirmationCode, logger)

	// Only available when actually running in-cluster (needs the mounted
	// ServiceAccount token) — nil here just means GET /api/updates always
	// returns an empty list instead of failing the whole binary, e.g. for
	// local `go run` outside k3s.
	k8sConfigMaps, err := clients.NewK8sConfigMapClient()
	if err != nil {
		logger.Warn("k8s in-cluster client unavailable, /api/updates will always be empty", "error", err)
		k8sConfigMaps = nil
	}
	updatesHandler := handlers.NewUpdatesHandler(
		k8sConfigMaps, cfg.updatesNamespace, cfg.updatesConfigMapName,
		cfg.updatesCacheTTL, logger,
	)

	router := gin.New()
	if err := router.SetTrustedProxies(cfg.trustedProxies); err != nil {
		return fmt.Errorf("setting trusted proxies: %w", err)
	}

	router.Use(gin.Recovery())
	router.Use(requestLogger(logger))
	router.Use(stats.Middleware())

	if len(cfg.corsAllowedOrigins) > 0 {
		router.Use(auth.CORS(cfg.corsAllowedOrigins))
	}
	if len(cfg.ipAllowlist) > 0 {
		router.Use(auth.IPAllowlist(cfg.ipAllowlist))
	}

	rateLimiter := auth.NewRateLimiter(cfg.rateLimitPerMinute, time.Minute)

	router.GET("/health", healthHandler.Handle)
	router.GET("/metrics", stats.Handler())

	api := router.Group("/api")
	api.Use(rateLimiter.Middleware())
	if cfg.bearerToken != "" {
		api.Use(auth.BearerAuth(cfg.bearerToken))
	} else {
		logger.Warn("CARPLAY_API_TOKEN not set — /api/dashboard is running WITHOUT authentication")
	}
	api.GET("/dashboard", dashboardHandler.Handle)
	api.GET("/updates", updatesHandler.Handle)
	api.GET("/brightness", powerHandler.GetBrightness)
	api.PUT("/brightness", powerHandler.SetBrightness)
	api.POST("/power/wake", powerHandler.Wake)
	api.POST("/power/shutdown", powerHandler.Shutdown)

	srv := &http.Server{
		Addr:              ":" + cfg.port,
		Handler:           router,
		ReadHeaderTimeout: 5 * time.Second,
	}

	serverErr := make(chan error, 1)
	go func() {
		logger.Info("carplay-api listening", "port", cfg.port)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			serverErr <- err
		}
	}()

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	select {
	case err := <-serverErr:
		return fmt.Errorf("listen: %w", err)
	case <-ctx.Done():
		logger.Info("shutting down")
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return srv.Shutdown(shutdownCtx)
}

// requestLogger emits one structured JSON line per request: method, path,
// status, duration and a per-request trace ID. Deliberately excludes
// headers and query strings — the Authorization bearer token and any other
// sensitive value must never end up in logs.
func requestLogger(logger *slog.Logger) gin.HandlerFunc {
	return func(c *gin.Context) {
		traceID := newTraceID()
		c.Set("trace_id", traceID)
		c.Header("X-Trace-Id", traceID)

		start := time.Now()
		c.Next()

		path := c.FullPath()
		if path == "" {
			path = c.Request.URL.Path
		}

		logger.Info("request",
			"trace_id", traceID,
			"method", c.Request.Method,
			"path", path,
			"status", c.Writer.Status(),
			"duration_ms", time.Since(start).Milliseconds(),
			"client_ip", c.ClientIP(),
		)
	}
}

func newTraceID() string {
	buf := make([]byte, 8)
	if _, err := rand.Read(buf); err != nil {
		return "unknown"
	}
	return hex.EncodeToString(buf)
}

type config struct {
	port     string
	logLevel slog.Level

	cacheTTL   time.Duration
	apiTimeout time.Duration

	bearerToken        string
	ipAllowlist        []string
	corsAllowedOrigins []string
	rateLimitPerMinute int
	trustedProxies     []string

	vmURL    string
	hosts    []clients.HostConfig
	services []clients.ServiceConfig

	ntfyURL   string
	ntfyTopic string
	ntfyToken string
	ntfySince string
	ntfyLimit int

	kumaURL  string
	kumaSlug string

	// See argocd/apps/github-release-watcher — different namespace than
	// this pod, read via the in-cluster k8s API + a cross-namespace
	// RoleBinding (role.yaml "...-updates-reader"), not HTTP.
	updatesNamespace     string
	updatesConfigMapName string
	updatesCacheTTL      time.Duration

	powerAgentURL     string
	powerAgentToken   string
	powerAgentTimeout time.Duration

	// Compared against the "code" field of POST /api/power/shutdown when
	// Target is "homeserver" — deliberately kept in lockstep with the
	// ArgoCD admin password by whoever rotates it (see
	// docs/43-carplay-api.md), not verified live against ArgoCD itself.
	shutdownConfirmationCode string
}

func loadConfig() config {
	return config{
		port:     getEnv("PORT", "8080"),
		logLevel: parseLogLevel(getEnv("LOG_LEVEL", "info")),

		cacheTTL:   time.Duration(getEnvInt("CACHE_TTL", 30)) * time.Second,
		apiTimeout: time.Duration(getEnvInt("API_TIMEOUT", 5)) * time.Second,

		bearerToken:        os.Getenv("CARPLAY_API_TOKEN"),
		ipAllowlist:        splitCSV(os.Getenv("IP_ALLOWLIST_CIDRS")),
		corsAllowedOrigins: splitCSV(os.Getenv("CORS_ALLOWED_ORIGINS")),
		rateLimitPerMinute: getEnvInt("RATE_LIMIT_PER_MINUTE", 100),
		trustedProxies:     splitCSV(os.Getenv("TRUSTED_PROXIES")),

		vmURL: getEnv("VM_URL", "http://vmsingle-monitoring-victoria-metrics-k8s-stack.monitoring.svc.cluster.local:8428"),
		hosts: parseHosts(getEnv("HOSTS",
			"homeserver|Homeserver|192.168.178.94:9100,"+
				"worker-0|Worker 0|192.168.178.95:9100,"+
				"worker-1|Worker 1|192.168.178.96:9100,"+
				"nas|NAS|192.168.178.97:9100",
		)),
		// Default list mirrors the iOS app's Kurzlink-Kacheln
		// (Constants.SelfHostedServices) — Match is a substring of the raw
		// Traefik "service" metric label (see clients.ServiceConfig on why
		// it's a substring, not an exact match).
		services: parseServices(getEnv("SERVICES",
			"nextcloud|Nextcloud|nextcloud,"+
				"immich|Immich|immich,"+
				"vaultwarden|Vaultwarden|vaultwarden,"+
				"paperless|Paperless-ngx|paperless,"+
				"mealie|Mealie|mealie,"+
				"n8n|n8n|n8n,"+
				"wikijs|Wiki.js|wikijs,"+
				"zammad|Zammad|zammad",
		)),

		ntfyURL:   getEnv("NTFY_URL", "http://ntfy.ntfy.svc.cluster.local"),
		ntfyTopic: getEnv("NTFY_TOPIC", "alerts"),
		ntfyToken: os.Getenv("NTFY_TOKEN"),
		ntfySince: getEnv("NTFY_SINCE", "12h"),
		ntfyLimit: getEnvInt("NTFY_LIMIT", 10),

		kumaURL:  getEnv("UPTIME_KUMA_URL", "http://uptime-kuma.uptime-kuma.svc.cluster.local"),
		kumaSlug: getEnv("UPTIME_KUMA_SLUG", "homeserver"),

		updatesNamespace:     getEnv("UPDATES_NAMESPACE", "github-release-watcher"),
		updatesConfigMapName: getEnv("UPDATES_CONFIGMAP_NAME", "github-release-watcher-updates"),
		updatesCacheTTL:      time.Duration(getEnvInt("UPDATES_CACHE_TTL", 900)) * time.Second,

		powerAgentURL:     getEnv("POWER_AGENT_URL", "http://192.168.178.94:9101"),
		powerAgentToken:   os.Getenv("POWER_AGENT_TOKEN"),
		powerAgentTimeout: time.Duration(getEnvInt("POWER_AGENT_TIMEOUT", 8)) * time.Second,

		shutdownConfirmationCode: os.Getenv("SHUTDOWN_CONFIRMATION_CODE"),
	}
}

// parseHosts reads the "id|name|instance,id|name|instance,..." format HOSTS
// uses (values.yaml config.hosts) into HostConfig entries. instance is the
// VictoriaMetrics "instance" label for that machine's node-exporter target
// (see clients.HostConfig) — not necessarily its hostname. Malformed
// entries are silently skipped rather than crashing startup over a typo'd
// Helm value.
func parseHosts(v string) []clients.HostConfig {
	var hosts []clients.HostConfig
	for _, entry := range strings.Split(v, ",") {
		entry = strings.TrimSpace(entry)
		if entry == "" {
			continue
		}
		parts := strings.SplitN(entry, "|", 3)
		if len(parts) != 3 {
			continue
		}
		hosts = append(hosts, clients.HostConfig{
			ID:       strings.TrimSpace(parts[0]),
			Name:     strings.TrimSpace(parts[1]),
			Instance: strings.TrimSpace(parts[2]),
		})
	}
	return hosts
}

// parseServices reads the "id|name|match,id|name|match,..." format SERVICES
// uses (values.yaml config.services), same shape as parseHosts. match is a
// substring of the raw Traefik "service" metric label, see
// clients.ServiceConfig.
func parseServices(v string) []clients.ServiceConfig {
	var services []clients.ServiceConfig
	for _, entry := range strings.Split(v, ",") {
		entry = strings.TrimSpace(entry)
		if entry == "" {
			continue
		}
		parts := strings.SplitN(entry, "|", 3)
		if len(parts) != 3 {
			continue
		}
		services = append(services, clients.ServiceConfig{
			ID:    strings.TrimSpace(parts[0]),
			Name:  strings.TrimSpace(parts[1]),
			Match: strings.TrimSpace(parts[2]),
		})
	}
	return services
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func getEnvInt(key string, fallback int) int {
	v := os.Getenv(key)
	if v == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(v)
	if err != nil {
		return fallback
	}
	return parsed
}

func splitCSV(v string) []string {
	if v == "" {
		return nil
	}
	parts := strings.Split(v, ",")
	result := make([]string, 0, len(parts))
	for _, p := range parts {
		if trimmed := strings.TrimSpace(p); trimmed != "" {
			result = append(result, trimmed)
		}
	}
	return result
}

func parseLogLevel(v string) slog.Level {
	switch strings.ToLower(v) {
	case "debug":
		return slog.LevelDebug
	case "warn", "warning":
		return slog.LevelWarn
	case "error":
		return slog.LevelError
	default:
		return slog.LevelInfo
	}
}
