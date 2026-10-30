package gate

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"ticket-gate/internal/config"
	"ticket-gate/internal/zammad"
)

type fakeClock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *fakeClock) Advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t = c.t.Add(d)
}

type sentMail struct {
	To   string
	Code string
}

type fakeMailer struct {
	mu   sync.Mutex
	sent []sentMail
}

func (m *fakeMailer) SendCode(_ context.Context, to, code string, _ time.Duration) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.sent = append(m.sent, sentMail{To: to, Code: code})
	return nil
}

func (m *fakeMailer) last(to string) string {
	to = strings.ToLower(strings.TrimSpace(to))
	m.mu.Lock()
	defer m.mu.Unlock()
	for i := len(m.sent) - 1; i >= 0; i-- {
		if m.sent[i].To == to {
			return m.sent[i].Code
		}
	}
	return ""
}

func (m *fakeMailer) count() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.sent)
}

type fakeTickets struct {
	mu      sync.Mutex
	created []zammad.Ticket
	err     error
}

func (f *fakeTickets) Create(_ context.Context, t zammad.Ticket) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.err != nil {
		return "", f.err
	}
	f.created = append(f.created, t)
	return "10001", nil
}

func (f *fakeTickets) all() []zammad.Ticket {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]zammad.Ticket(nil), f.created...)
}

type env struct {
	t       *testing.T
	svc     *Service
	h       http.Handler
	clock   *fakeClock
	mailer  *fakeMailer
	tickets *fakeTickets
	logs    *bytes.Buffer
}

const testOrigin = "https://www.edv-kretzer.de"

func testConfig() config.Config {
	return config.Config{
		AllowedOrigins:   []string{testOrigin},
		HMACSecret:       []byte("0123456789abcdef0123456789abcdef"),
		ClientIPHeader:   "X-Test-IP",
		CodeTTL:          10 * time.Minute,
		TokenTTL:         30 * time.Minute,
		SessionTTL:       2 * time.Hour,
		MaxAttempts:      5,
		MailCooldown:     60 * time.Second,
		MailPerEmailHour: 5,
		MailPerIPHour:    1000,
		ConfirmPerIP:     1000,
		ConfirmWindow:    10 * time.Minute,
		SessionPerIPHour: 1000,
		TicketPerIPHour:  1000,
		MaxSessions:      1000,
	}
}

func newEnv(t *testing.T, mutate ...func(*config.Config)) *env {
	t.Helper()
	cfg := testConfig()
	for _, m := range mutate {
		m(&cfg)
	}
	e := &env{
		t:       t,
		clock:   &fakeClock{t: time.Date(2026, 10, 30, 12, 0, 0, 0, time.UTC)},
		mailer:  &fakeMailer{},
		tickets: &fakeTickets{},
		logs:    &bytes.Buffer{},
	}
	e.svc = NewService(Deps{
		Config:  cfg,
		Mailer:  e.mailer,
		Tickets: e.tickets,
		Now:     e.clock.Now,
		Logger:  slog.New(slog.NewJSONHandler(e.logs, &slog.HandlerOptions{Level: slog.LevelDebug})),
		Spawn:   func(f func()) { f() },
	})
	e.h = e.svc.Handler()
	return e
}

type resp struct {
	Status int
	Body   map[string]any
	Raw    string
	Header http.Header
}

func (e *env) do(path, token, ip string, body any) resp {
	e.t.Helper()
	return e.doWith(path, token, ip, body, nil)
}

func (e *env) doWith(path, token, ip string, body any, headers map[string]string) resp {
	e.t.Helper()
	var rdr io.Reader = http.NoBody
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			e.t.Fatal(err)
		}
		rdr = bytes.NewReader(raw)
	}
	req := httptest.NewRequest(http.MethodPost, path, rdr)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Test-IP", ip)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	e.h.ServeHTTP(rec, req)
	out := resp{Status: rec.Code, Raw: rec.Body.String(), Header: rec.Header()}
	_ = json.Unmarshal(rec.Body.Bytes(), &out.Body)
	return out
}

func (e *env) session(ip string) string {
	e.t.Helper()
	r := e.do("/v1/session", "", ip, nil)
	if r.Status != 200 {
		e.t.Fatalf("session: %d %s", r.Status, r.Raw)
	}
	return r.Body["session_token"].(string)
}

func (e *env) requestCode(sess, email, ip string) resp {
	e.t.Helper()
	return e.do("/v1/verify/request", sess, ip, map[string]string{"email": email})
}

func (e *env) confirm(sess, code, ip string) resp {
	e.t.Helper()
	return e.do("/v1/verify/confirm", sess, ip, map[string]string{"code": code})
}

func (e *env) verified(sess, email, ip string) string {
	e.t.Helper()
	if r := e.requestCode(sess, email, ip); r.Status != 202 {
		e.t.Fatalf("request: %d %s", r.Status, r.Raw)
	}
	r := e.confirm(sess, e.mailer.last(email), ip)
	if r.Status != 200 {
		e.t.Fatalf("confirm: %d %s", r.Status, r.Raw)
	}
	return r.Body["verification_token"].(string)
}

func (e *env) submit(sess, token, ip string) resp {
	e.t.Helper()
	return e.do("/v1/tickets", sess, ip, map[string]string{
		"verification_token": token,
		"subject":            "Frage zu capulus",
		"message":            "Hallo, ich habe eine Frage.",
	})
}

func wrongCode(right string) string {
	if right == "000000" {
		return "000001"
	}
	return "000000"
}

func mustErr(t *testing.T, r resp, status int, code string) {
	t.Helper()
	if r.Status != status {
		t.Fatalf("Status %d, erwartet %d (%s)", r.Status, status, r.Raw)
	}
	if got, _ := r.Body["error"].(string); got != code {
		t.Fatalf("Fehler %q, erwartet %q (%s)", got, code, r.Raw)
	}
}

var errTicket = errors.New("zammad down")

func contains(s, sub string) bool { return strings.Contains(s, sub) }
