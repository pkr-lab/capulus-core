package clients

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"math"
	"net/http"
	"time"

	"carplay-api/internal/models"
)

type UptimeKumaClient struct {
	baseURL    string
	slug       string
	httpClient *http.Client
	logger     *slog.Logger
}

func NewUptimeKumaClient(baseURL, slug string, timeout time.Duration, logger *slog.Logger) *UptimeKumaClient {
	return &UptimeKumaClient{
		baseURL:    baseURL,
		slug:       slug,
		httpClient: &http.Client{Timeout: timeout},
		logger:     logger,
	}
}

type kumaStatusPage struct {
	PublicGroupList []struct {
		MonitorList []struct {
			ID   int    `json:"id"`
			Name string `json:"name"`
		} `json:"monitorList"`
	} `json:"publicGroupList"`
}

type kumaHeartbeat struct {
	Status int      `json:"status"`
	Time   string   `json:"time"`
	Ping   *float64 `json:"ping"`
}

type kumaHeartbeatResponse struct {
	HeartbeatList map[string][]kumaHeartbeat `json:"heartbeatList"`
	UptimeList    map[string]float64         `json:"uptimeList"`
}

func (c *UptimeKumaClient) getJSON(ctx context.Context, path string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+path, nil)
	if err != nil {
		return fmt.Errorf("building request: %w", err)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("requesting %s: %w", path, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("%s returned %d", path, resp.StatusCode)
	}

	if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
		return fmt.Errorf("decoding %s: %w", path, err)
	}
	return nil
}

func (c *UptimeKumaClient) GetStatuses(ctx context.Context) ([]models.ServiceStatus, error) {
	var page kumaStatusPage
	if err := c.getJSON(ctx, "/api/status-page/"+c.slug, &page); err != nil {
		return nil, fmt.Errorf("fetching status page: %w", err)
	}

	var hb kumaHeartbeatResponse
	if err := c.getJSON(ctx, "/api/status-page/heartbeat/"+c.slug, &hb); err != nil {
		return nil, fmt.Errorf("fetching heartbeats: %w", err)
	}

	var statuses []models.ServiceStatus
	for _, group := range page.PublicGroupList {
		for _, monitor := range group.MonitorList {
			key := fmt.Sprintf("%d", monitor.ID)
			beats := hb.HeartbeatList[key]

			status := models.ServiceStatus{
				ID:     key,
				Name:   monitor.Name,
				Status: "paused",
			}

			if len(beats) > 0 {
				latest := beats[len(beats)-1]
				status.Status = kumaStatusToString(latest.Status)
				status.LastCheck = parseKumaTime(latest.Time, c.logger)
				if latest.Ping != nil {
					status.Ping = int(math.Round(*latest.Ping))
				}
			}

			if uptime, ok := hb.UptimeList[key+"_24"]; ok {
				status.Uptime = uptime * 100
			}

			statuses = append(statuses, status)
		}
	}

	return statuses, nil
}

func kumaStatusToString(status int) string {
	switch status {
	case 1:
		return "up"
	case 3:
		return "maintenance"
	case 2:
		return "down"
	default:
		return "down"
	}
}

func parseKumaTime(raw string, logger *slog.Logger) int64 {
	layouts := []string{time.RFC3339, "2006-01-02 15:04:05", "2006-01-02T15:04:05.000Z"}
	for _, layout := range layouts {
		if t, err := time.Parse(layout, raw); err == nil {
			return t.Unix()
		}
	}
	logger.Warn("uptime-kuma: unrecognized heartbeat time format", "raw", raw)
	return time.Now().Unix()
}
