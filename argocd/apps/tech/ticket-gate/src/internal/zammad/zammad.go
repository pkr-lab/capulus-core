package zammad

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"

	"ticket-gate/internal/config"
)

type Ticket struct {
	Email   string
	Name    string
	Subject string
	Message string
}

type Ticketer interface {
	Create(ctx context.Context, t Ticket) (string, error)
}

type Client struct {
	cfg  config.Zammad
	http *http.Client
}

func New(cfg config.Zammad) *Client {
	return &Client{cfg: cfg, http: &http.Client{Timeout: 15 * time.Second}}
}

type article struct {
	Subject  string `json:"subject"`
	Body     string `json:"body"`
	Type     string `json:"type"`
	Sender   string `json:"sender"`
	Internal bool   `json:"internal"`
}

type payload struct {
	Title      string  `json:"title"`
	Group      string  `json:"group"`
	CustomerID string  `json:"customer_id"`
	Article    article `json:"article"`
}

func (c *Client) Create(ctx context.Context, t Ticket) (string, error) {
	body := t.Message
	if t.Name != "" {
		body = "Name: " + t.Name + "\n\n" + body
	}
	raw, err := json.Marshal(payload{
		Title:      t.Subject,
		Group:      c.cfg.Group,
		CustomerID: "guess:" + t.Email,
		Article:    article{Subject: t.Subject, Body: body, Type: "web", Sender: "Customer"},
	})
	if err != nil {
		return "", err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.cfg.URL+"/api/v1/tickets", bytes.NewReader(raw))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Token token="+c.cfg.Token)

	resp, err := c.http.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return "", err
	}
	if resp.StatusCode != http.StatusCreated && resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("zammad antwortete mit Status %d", resp.StatusCode)
	}
	var out struct {
		Number string `json:"number"`
	}
	if err := json.Unmarshal(data, &out); err != nil {
		return "", err
	}
	if out.Number == "" {
		return "", errors.New("zammad lieferte keine Ticketnummer")
	}
	return out.Number, nil
}
