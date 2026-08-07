package clients

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

// PowerAgentClient talks to power-agent, the small privileged HTTP daemon
// that runs directly on the homeserver host (ansible/roles/power_agent) —
// NOT a k8s workload. carplay-api's pod has no host access (sysfs
// backlight, sudo poweroff, the cluster_power_manager SSH key for worker
// shutdown), so every brightness/wake/shutdown request is proxied to this
// agent over the LAN, authenticated with its own bearer token (deliberately
// separate from CARPLAY_API_TOKEN — the app's token should not itself be
// enough to power anything off).
type PowerAgentClient struct {
	baseURL    string
	token      string
	httpClient *http.Client
}

func NewPowerAgentClient(baseURL, token string, timeout time.Duration) *PowerAgentClient {
	return &PowerAgentClient{
		baseURL:    baseURL,
		token:      token,
		httpClient: &http.Client{Timeout: timeout},
	}
}

type AgentError struct {
	StatusCode int
	Message    string
}

func (e *AgentError) Error() string {
	return fmt.Sprintf("power-agent returned %d: %s", e.StatusCode, e.Message)
}

func (c *PowerAgentClient) do(ctx context.Context, method, path string, body any, out any) error {
	var reqBody *bytes.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("encoding request: %w", err)
		}
		reqBody = bytes.NewReader(encoded)
	} else {
		reqBody = bytes.NewReader(nil)
	}

	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, reqBody)
	if err != nil {
		return fmt.Errorf("building request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("calling power-agent: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		var errBody struct {
			Error string `json:"error"`
		}
		_ = json.NewDecoder(resp.Body).Decode(&errBody)
		return &AgentError{StatusCode: resp.StatusCode, Message: errBody.Error}
	}

	if out == nil {
		return nil
	}
	if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
		return fmt.Errorf("decoding power-agent response: %w", err)
	}
	return nil
}

type brightnessPayload struct {
	Percent int `json:"percent"`
}

func (c *PowerAgentClient) GetBrightness(ctx context.Context) (int, error) {
	var out brightnessPayload
	if err := c.do(ctx, http.MethodGet, "/brightness", nil, &out); err != nil {
		return 0, err
	}
	return out.Percent, nil
}

func (c *PowerAgentClient) SetBrightness(ctx context.Context, percent int) (int, error) {
	var out brightnessPayload
	if err := c.do(ctx, http.MethodPut, "/brightness", brightnessPayload{Percent: percent}, &out); err != nil {
		return 0, err
	}
	return out.Percent, nil
}

type targetPayload struct {
	Target string `json:"target"`
}

func (c *PowerAgentClient) Wake(ctx context.Context, target string) error {
	return c.do(ctx, http.MethodPost, "/wake", targetPayload{Target: target}, nil)
}

func (c *PowerAgentClient) Shutdown(ctx context.Context, target string) error {
	return c.do(ctx, http.MethodPost, "/poweroff", targetPayload{Target: target}, nil)
}

func (c *PowerAgentClient) ShutdownSelf(ctx context.Context) error {
	return c.do(ctx, http.MethodPost, "/poweroff-self", nil, nil)
}
