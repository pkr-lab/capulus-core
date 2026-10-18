package main

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func testLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func request(remote string, headers map[string]string) *http.Request {
	r := httptest.NewRequest(http.MethodPost, "/api/fingerprint", nil)
	r.RemoteAddr = remote
	for k, v := range headers {
		r.Header.Set(k, v)
	}
	return r
}

func TestClientIPTrustsHeadersOnlyFromTrustedProxy(t *testing.T) {
	trustedProxies = parseCIDRs("10.42.0.0/16", testLogger())
	t.Cleanup(func() { trustedProxies = nil })

	cases := []struct {
		name    string
		remote  string
		headers map[string]string
		want    string
	}{
		{"trusted proxy with CF header", "10.42.2.5:5555", map[string]string{"CF-Connecting-IP": "203.0.113.7"}, "203.0.113.7"},
		{"trusted proxy with XFF", "10.42.2.5:5555", map[string]string{"X-Forwarded-For": "198.51.100.4, 10.42.2.5"}, "198.51.100.4"},
		{"untrusted source ignores CF header", "192.168.178.50:4444", map[string]string{"CF-Connecting-IP": "203.0.113.7"}, "192.168.178.50"},
		{"untrusted source ignores XFF", "192.168.178.50:4444", map[string]string{"X-Forwarded-For": "203.0.113.7"}, "192.168.178.50"},
		{"trusted proxy with garbage header", "10.42.2.5:5555", map[string]string{"CF-Connecting-IP": "nicht-eine-ip"}, "10.42.2.5"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := clientIP(request(tc.remote, tc.headers)); got != tc.want {
				t.Fatalf("clientIP = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestRateLimiterBlocksAfterLimitAndRecovers(t *testing.T) {
	now := time.Unix(1000, 0)
	l := newRateLimiter(3, time.Minute)
	l.now = func() time.Time { return now }

	for i := 0; i < 3; i++ {
		if ok, _ := l.allow("a"); !ok {
			t.Fatalf("request %d should be allowed", i+1)
		}
	}
	if ok, retry := l.allow("a"); ok || retry <= 0 {
		t.Fatalf("fourth request should be blocked with retry-after, got ok=%v retry=%v", ok, retry)
	}
	if ok, _ := l.allow("b"); !ok {
		t.Fatal("other clients must not be affected")
	}
	now = now.Add(61 * time.Second)
	if ok, _ := l.allow("a"); !ok {
		t.Fatal("client should be allowed again after the window")
	}
}

func TestWithRateLimitReturns429(t *testing.T) {
	trustedProxies = nil
	l := newRateLimiter(2, time.Minute)
	h := withRateLimit(l, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) }))

	var last *httptest.ResponseRecorder
	for i := 0; i < 3; i++ {
		last = httptest.NewRecorder()
		h.ServeHTTP(last, request("192.0.2.1:1000", nil))
	}
	if last.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want 429", last.Code)
	}
	if last.Header().Get("Retry-After") == "" {
		t.Fatal("missing Retry-After header")
	}
}
