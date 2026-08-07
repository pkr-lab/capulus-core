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
	"math"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"carplay-api/internal/models"
)

// VictoriaMetricsClient queries a Prometheus-API-compatible VictoriaMetrics
// instance (single-node vmsingle in this cluster, see
// argocd/apps/monitoring/).
type VictoriaMetricsClient struct {
	baseURL    string
	httpClient *http.Client
	logger     *slog.Logger
}

func NewVictoriaMetricsClient(baseURL string, timeout time.Duration, logger *slog.Logger) *VictoriaMetricsClient {
	return &VictoriaMetricsClient{
		baseURL:    baseURL,
		httpClient: &http.Client{Timeout: timeout},
		logger:     logger,
	}
}

// HostConfig maps one monitored machine to the VictoriaMetrics "instance"
// label node-exporter is scraped under (host_config.go / values.yaml
// config.hosts — no relabeling to hostnames happens in this cluster's
// scrape config, so it's "ip:9100", not "homeserver:9100").
type HostConfig struct {
	ID       string
	Name     string
	Instance string
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

// queryByInstance runs a PromQL instant query expected to be grouped
// `by (instance)` and returns one float64 per instance label value found in
// the result vector. An instance missing from the map means "no series" for
// that metric (query failed, or nothing scraped for it yet) — callers treat
// that the same as zero rather than erroring the whole response.
func (c *VictoriaMetricsClient) queryByInstance(ctx context.Context, promql string) (map[string]float64, error) {
	endpoint := fmt.Sprintf("%s/api/v1/query?%s", c.baseURL, url.Values{"query": {promql}}.Encode())

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, fmt.Errorf("building request: %w", err)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("querying victoriametrics: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("victoriametrics returned %d", resp.StatusCode)
	}

	var parsed vmQueryResponse
	if err := json.NewDecoder(resp.Body).Decode(&parsed); err != nil {
		return nil, fmt.Errorf("decoding victoriametrics response: %w", err)
	}

	if parsed.Status != "success" {
		return nil, fmt.Errorf("victoriametrics query status %q for %q", parsed.Status, promql)
	}

	out := make(map[string]float64, len(parsed.Data.Result))
	for _, series := range parsed.Data.Result {
		instance := series.Metric["instance"]
		if instance == "" {
			continue
		}
		raw, ok := series.Value[1].(string)
		if !ok {
			continue
		}
		value, err := strconv.ParseFloat(raw, 64)
		if err != nil {
			continue
		}
		out[instance] = value
	}
	return out, nil
}

// GetHostMetrics assembles one HostMetrics per configured host from six
// PromQL queries run concurrently, each grouped by instance so a single
// round trip covers every host at once. A host absent from the "up" series,
// or reporting up=0, comes back with Online=false and every metric at its
// zero value — the caller (dashboard handler) relies on that to decide
// whether a host card should show on the app's home screen at all.
func (c *VictoriaMetricsClient) GetHostMetrics(ctx context.Context, hosts []HostConfig) []models.HostMetrics {
	if len(hosts) == 0 {
		return nil
	}

	instances := make([]string, len(hosts))
	for i, h := range hosts {
		instances[i] = h.Instance
	}
	instanceMatch := fmt.Sprintf(`instance=~"%s"`, regexAlternation(instances))

	type queryDef struct {
		metric string
		promql string
	}
	defs := []queryDef{
		{"up", fmt.Sprintf(`max by (instance) (up{%s})`, instanceMatch)},
		{"cpu", fmt.Sprintf(`100 - (avg by (instance) (rate(node_cpu_seconds_total{mode="idle",%s}[5m])) * 100)`, instanceMatch)},
		{"ram", fmt.Sprintf(`100 * (1 - (node_memory_MemAvailable_bytes{%s} / node_memory_MemTotal_bytes{%s}))`, instanceMatch, instanceMatch)},
		{"disk", fmt.Sprintf(`100 * (1 - (node_filesystem_avail_bytes{mountpoint="/",%s} / node_filesystem_size_bytes{mountpoint="/",%s}))`, instanceMatch, instanceMatch)},
		{"temperature", fmt.Sprintf(`max by (instance) (node_hwmon_temp_celsius{%s})`, instanceMatch)},
		{"boot", fmt.Sprintf(`max by (instance) (node_boot_time_seconds{%s})`, instanceMatch)},
	}

	type result struct {
		metric string
		values map[string]float64
	}
	results := make(chan result, len(defs))

	for _, def := range defs {
		go func(d queryDef) {
			values, err := c.queryByInstance(ctx, d.promql)
			if err != nil {
				c.logger.Warn("victoriametrics host query failed", "metric", d.metric, "error", err)
			}
			results <- result{metric: d.metric, values: values}
		}(def)
	}

	byMetric := make(map[string]map[string]float64, len(defs))
	for range defs {
		r := <-results
		byMetric[r.metric] = r.values
	}

	now := float64(time.Now().Unix())
	out := make([]models.HostMetrics, len(hosts))
	for i, h := range hosts {
		online := byMetric["up"][h.Instance] == 1

		m := models.HostMetrics{ID: h.ID, Name: h.Name, Online: online}
		if online {
			m.CPU = clampPercent(byMetric["cpu"][h.Instance])
			m.RAM = clampPercent(byMetric["ram"][h.Instance])
			m.Disk = clampPercent(byMetric["disk"][h.Instance])
			m.Temperature = byMetric["temperature"][h.Instance]
			if boot, ok := byMetric["boot"][h.Instance]; ok && boot > 0 {
				m.Uptime = formatUptime(now - boot)
			}
		}
		out[i] = m
	}
	return out
}

func clampPercent(v float64) float64 {
	if math.IsNaN(v) || v < 0 {
		return 0
	}
	if v > 100 {
		return 100
	}
	return v
}

// regexAlternation builds a PromQL label-matcher regex ("a|b|c") from exact
// values, escaping each one so IPs' dots don't accidentally act as
// wildcards. The escaped value is embedded in a double-quoted MetricsQL
// string literal, so a single backslash (what regexp.QuoteMeta produces,
// e.g. "192.168.0.1" -> `192\.168\.0\.1`) gets parsed by VictoriaMetrics as
// a string-literal escape sequence and rejected with 422 ("cannot parse
// string literal") since "\." isn't one it recognizes. Doubling the
// backslash makes it decode back to a single one before the regex engine
// sees it.
func regexAlternation(values []string) string {
	escaped := make([]string, len(values))
	for i, v := range values {
		escaped[i] = strings.ReplaceAll(regexp.QuoteMeta(v), `\`, `\\`)
	}
	return strings.Join(escaped, "|")
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
