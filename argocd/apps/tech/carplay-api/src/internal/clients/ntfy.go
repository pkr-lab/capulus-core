package clients

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"sort"
	"time"

	"carplay-api/internal/models"
)

type NtfyClient struct {
	baseURL    string
	topic      string
	token      string
	httpClient *http.Client
	logger     *slog.Logger
}

func NewNtfyClient(baseURL, topic, token string, timeout time.Duration, logger *slog.Logger) *NtfyClient {
	return &NtfyClient{
		baseURL:    baseURL,
		topic:      topic,
		token:      token,
		httpClient: &http.Client{Timeout: timeout},
		logger:     logger,
	}
}

type ntfyMessage struct {
	ID       string   `json:"id"`
	Time     int64    `json:"time"`
	Event    string   `json:"event"`
	Topic    string   `json:"topic"`
	Title    string   `json:"title"`
	Message  string   `json:"message"`
	Priority int      `json:"priority"`
	Tags     []string `json:"tags"`
}

func (c *NtfyClient) GetAlerts(ctx context.Context, since string, limit int) ([]models.Alert, error) {
	endpoint := fmt.Sprintf("%s/%s/json?poll=1&since=%s", c.baseURL, c.topic, since)

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, fmt.Errorf("building request: %w", err)
	}
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("querying ntfy: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("ntfy returned %d", resp.StatusCode)
	}

	var alerts []models.Alert
	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)

	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}

		var msg ntfyMessage
		if err := json.Unmarshal(line, &msg); err != nil {
			c.logger.Warn("ntfy: skipping malformed line", "error", err)
			continue
		}
		if msg.Event != "message" {
			continue
		}

		title := msg.Title
		if title == "" {
			title = msg.Topic
		}

		alerts = append(alerts, models.Alert{
			ID:      msg.ID,
			Topic:   msg.Topic,
			Title:   title,
			Message: msg.Message,
			Time:    msg.Time,
			Level:   priorityToLevel(msg.Priority),
		})
	}
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("reading ntfy response: %w", err)
	}

	sort.SliceStable(alerts, func(i, j int) bool {
		ri, rj := levelRank(alerts[i].Level), levelRank(alerts[j].Level)
		if ri != rj {
			return ri < rj
		}
		return alerts[i].Time > alerts[j].Time
	})

	if len(alerts) > limit {
		alerts = alerts[:limit]
	}

	return alerts, nil
}

func priorityToLevel(priority int) string {
	switch {
	case priority >= 5:
		return "critical"
	case priority == 4:
		return "warning"
	default:
		return "info"
	}
}

func levelRank(level string) int {
	switch level {
	case "critical":
		return 0
	case "warning":
		return 1
	default:
		return 2
	}
}
