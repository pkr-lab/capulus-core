package main

import (
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
)

func testConfig(token string) config {
	return config{
		port:               "0",
		bearerToken:        token,
		rateLimitPerMinute: 100,
		vmURL:              "http://127.0.0.1:1",
		ntfyURL:            "http://127.0.0.1:1",
		kumaURL:            "http://127.0.0.1:1",
		powerAgentURL:      "http://127.0.0.1:1",
	}
}

func testLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func TestRunRefusesToStartWithoutToken(t *testing.T) {
	err := run(testConfig(""), testLogger())
	if !errors.Is(err, errMissingToken) {
		t.Fatalf("expected errMissingToken, got %v", err)
	}
}

func TestMetricsRequiresBearerToken(t *testing.T) {
	router, err := newRouter(testConfig("secret-token"), testLogger())
	if err != nil {
		t.Fatalf("newRouter: %v", err)
	}

	cases := []struct {
		name   string
		header string
		want   int
	}{
		{"no header", "", http.StatusUnauthorized},
		{"wrong token", "Bearer other", http.StatusUnauthorized},
		{"valid token", "Bearer secret-token", http.StatusOK},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/metrics", nil)
			if tc.header != "" {
				req.Header.Set("Authorization", tc.header)
			}
			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, req)
			if rec.Code != tc.want {
				t.Fatalf("status = %d, want %d", rec.Code, tc.want)
			}
		})
	}
}

func TestAPIRequiresBearerToken(t *testing.T) {
	router, err := newRouter(testConfig("secret-token"), testLogger())
	if err != nil {
		t.Fatalf("newRouter: %v", err)
	}
	req := httptest.NewRequest(http.MethodGet, "/api/dashboard", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusUnauthorized)
	}
}

func TestTrustedProxyUsesForwardedClientIP(t *testing.T) {
	cfg := testConfig("secret-token")
	cfg.trustedProxies = []string{"10.42.0.0/16"}
	router, err := newRouter(cfg, testLogger())
	if err != nil {
		t.Fatalf("newRouter: %v", err)
	}
	req := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	req.RemoteAddr = "10.42.2.5:41234"
	req.Header.Set("X-Forwarded-For", "100.64.0.9")
	req.Header.Set("Authorization", "Bearer secret-token")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}
}
