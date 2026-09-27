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

func (c *VictoriaMetricsClient) queryGroupedBy(ctx context.Context, promql, label string) (map[string]float64, error) {
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
		key := series.Metric[label]
		if key == "" {
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
		out[key] = value
	}
	return out, nil
}

func (c *VictoriaMetricsClient) queryByInstance(ctx context.Context, promql string) (map[string]float64, error) {
	return c.queryGroupedBy(ctx, promql, "instance")
}

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

type ServiceConfig struct {
	ID    string
	Name  string
	Match string
}

func (c *VictoriaMetricsClient) GetServiceActivity(ctx context.Context, services []ServiceConfig) []models.ServiceActivity {
	if len(services) == 0 {
		return nil
	}

	byRawService, err := c.queryGroupedBy(ctx, `sum by (service) (rate(traefik_service_requests_total[5m]))`, "service")
	if err != nil {
		c.logger.Warn("victoriametrics traefik query failed", "error", err)
	}

	out := make([]models.ServiceActivity, len(services))
	for i, svc := range services {
		var rate float64
		for rawService, value := range byRawService {
			if strings.Contains(rawService, svc.Match) {
				rate += value
			}
		}
		out[i] = models.ServiceActivity{
			ID:                svc.ID,
			Name:              svc.Name,
			RequestsPerSecond: math.Round(rate*100) / 100,
		}
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
