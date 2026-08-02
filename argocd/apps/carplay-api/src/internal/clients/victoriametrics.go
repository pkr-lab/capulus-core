// Package clients holds one HTTP client per upstream dependency
// (VictoriaMetrics, ntfy, Uptime-Kuma). Every client is timeout-bounded and
// never returns a hard failure to its caller for "upstream down" — it
// degrades to a zero/empty value plus a logged warning, so one flaky
// dependency never takes the whole dashboard down.
package clients

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"time"

	"carplay-api/internal/models"
)

// VictoriaMetricsClient queries a Prometheus-API-compatible VictoriaMetrics
// instance (single-node vmsingle in this cluster, see
// argocd/apps/monitoring/).
type VictoriaMetricsClient struct {
	baseURL        string
	instanceFilter string // regex alternation, e.g. "homeserver|worker-0|worker-1"
	httpClient     *http.Client
	logger         *slog.Logger
}

func NewVictoriaMetricsClient(baseURL, instanceFilter string, timeout time.Duration, logger *slog.Logger) *VictoriaMetricsClient {
	return &VictoriaMetricsClient{
		baseURL:        baseURL,
		instanceFilter: instanceFilter,
		httpClient:     &http.Client{Timeout: timeout},
		logger:         logger,
	}
}

type vmQueryResponse struct {
	Status string `json:"status"`
	Data   struct {
		ResultType string `json:"resultType"`
		Result     []struct {
			Metric map[string]string `json:"metric"`
			Value  [2]any            `json:"value"`
		} `json:"result"`
	} `json:"data"`
}

// query runs a PromQL instant query and returns the first sample's value.
// Returns an error if the request fails, the response can't be parsed, or
// the result vector is empty (no matching series — e.g. node_exporter not
// scraped yet).
func (c *VictoriaMetricsClient) query(ctx context.Context, promql string) (float64, error) {
	endpoint := fmt.Sprintf("%s/api/v1/query?%s", c.baseURL, url.Values{"query": {promql}}.Encode())

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return 0, fmt.Errorf("building request: %w", err)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return 0, fmt.Errorf("querying victoriametrics: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return 0, fmt.Errorf("victoriametrics returned %d", resp.StatusCode)
	}

	var parsed vmQueryResponse
	if err := json.NewDecoder(resp.Body).Decode(&parsed); err != nil {
		return 0, fmt.Errorf("decoding victoriametrics response: %w", err)
	}

	if parsed.Status != "success" || len(parsed.Data.Result) == 0 {
		return 0, fmt.Errorf("no data for query %q", promql)
	}

	raw, ok := parsed.Data.Result[0].Value[1].(string)
	if !ok {
		return 0, fmt.Errorf("unexpected value format for query %q", promql)
	}

	value, err := strconv.ParseFloat(raw, 64)
	if err != nil {
		return 0, fmt.Errorf("parsing value %q: %w", raw, err)
	}

	return value, nil
}

// GetMetrics assembles SystemMetrics from six independent PromQL queries run
// concurrently. Each query degrades to its zero value on its own — the
// returned error is non-nil only when every single query failed, which
// callers use purely to flag VictoriaMetrics as unreachable in /health.
func (c *VictoriaMetricsClient) GetMetrics(ctx context.Context) (models.SystemMetrics, error) {
	type queryDef struct {
		name  string
		promql string
		assign func(v float64)
	}

	var metrics models.SystemMetrics
	var load1, load5, load15 float64
	var uptimeSeconds float64

	instanceMatch := fmt.Sprintf(`instance=~"%s"`, c.instanceFilter)

	defs := []queryDef{
		{
			name:   "cpu",
			promql: fmt.Sprintf(`100 - avg(rate(node_cpu_seconds_total{mode="idle",%s}[5m])) * 100`, instanceMatch),
			assign: func(v float64) { metrics.CPU = v },
		},
		{
			name: "ram",
			promql: fmt.Sprintf(
				`100 * (1 - sum(node_memory_MemAvailable_bytes{%s}) / sum(node_memory_MemTotal_bytes{%s}))`,
				instanceMatch, instanceMatch,
			),
			assign: func(v float64) { metrics.RAM = v },
		},
		{
			name: "disk",
			promql: fmt.Sprintf(
				`100 * (1 - sum(node_filesystem_avail_bytes{mountpoint="/",%s}) / sum(node_filesystem_size_bytes{mountpoint="/",%s}))`,
				instanceMatch, instanceMatch,
			),
			assign: func(v float64) { metrics.Disk = v },
		},
		{
			name:   "temperature",
			promql: fmt.Sprintf(`max(node_hwmon_temp_celsius{%s})`, instanceMatch),
			assign: func(v float64) { metrics.Temperature = v },
		},
		{
			// Smallest uptime across the fleet = most recently booted node.
			// node_boot_time_seconds is a boot *timestamp*, not a duration —
			// it has to be subtracted from "now" to get an uptime.
			name:   "uptime",
			promql: fmt.Sprintf(`time() - max(node_boot_time_seconds{%s})`, instanceMatch),
			assign: func(v float64) { uptimeSeconds = v },
		},
		{
			name:   "load1",
			promql: fmt.Sprintf(`avg(node_load1{%s})`, instanceMatch),
			assign: func(v float64) { load1 = v },
		},
		{
			name:   "load5",
			promql: fmt.Sprintf(`avg(node_load5{%s})`, instanceMatch),
			assign: func(v float64) { load5 = v },
		},
		{
			name:   "load15",
			promql: fmt.Sprintf(`avg(node_load15{%s})`, instanceMatch),
			assign: func(v float64) { load15 = v },
		},
	}

	type result struct {
		name string
		err  error
	}
	results := make(chan result, len(defs))

	for _, def := range defs {
		go func(d queryDef) {
			v, err := c.query(ctx, d.promql)
			if err == nil {
				d.assign(v)
			}
			results <- result{name: d.name, err: err}
		}(def)
	}

	failures := 0
	for range defs {
		r := <-results
		if r.err != nil {
			failures++
			c.logger.Warn("victoriametrics query failed", "metric", r.name, "error", r.err)
		}
	}

	if failures == len(defs) {
		metrics.Uptime = "N/A"
		metrics.LoadAvg = "N/A"
		return metrics, fmt.Errorf("all victoriametrics queries failed")
	}

	metrics.Uptime = formatUptime(uptimeSeconds)
	metrics.LoadAvg = fmt.Sprintf("%.2f %.2f %.2f", load1, load5, load15)

	return metrics, nil
}

func formatUptime(seconds float64) string {
	if seconds <= 0 {
		return "N/A"
	}
	d := time.Duration(seconds) * time.Second
	days := int(d.Hours() / 24)
	hours := int(d.Hours()) % 24
	minutes := int(d.Minutes()) % 60
	return fmt.Sprintf("%dd %dh %dm", days, hours, minutes)
}
