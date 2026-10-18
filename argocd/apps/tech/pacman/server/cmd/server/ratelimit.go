package main

import (
	"net/http"
	"strconv"
	"sync"
	"time"
)

const rateLimiterMaxEntries = 10000

type rateWindow struct {
	start time.Time
	count int
}

type rateLimiter struct {
	mu      sync.Mutex
	limit   int
	window  time.Duration
	entries map[string]*rateWindow
	now     func() time.Time
}

func newRateLimiter(limit int, window time.Duration) *rateLimiter {
	return &rateLimiter{
		limit:   limit,
		window:  window,
		entries: make(map[string]*rateWindow),
		now:     time.Now,
	}
}

func (l *rateLimiter) allow(key string) (bool, time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()

	now := l.now()
	if len(l.entries) >= rateLimiterMaxEntries {
		for k, w := range l.entries {
			if now.Sub(w.start) >= l.window {
				delete(l.entries, k)
			}
		}
	}

	w, ok := l.entries[key]
	if !ok || now.Sub(w.start) >= l.window {
		if !ok && len(l.entries) >= rateLimiterMaxEntries {
			return false, l.window
		}
		l.entries[key] = &rateWindow{start: now, count: 1}
		return true, 0
	}
	if w.count >= l.limit {
		return false, l.window - now.Sub(w.start)
	}
	w.count++
	return true, 0
}

func withRateLimit(limiter *rateLimiter, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ok, retryAfter := limiter.allow(clientIP(r))
		if !ok {
			seconds := int(retryAfter.Seconds()) + 1
			w.Header().Set("Retry-After", strconv.Itoa(seconds))
			w.WriteHeader(http.StatusTooManyRequests)
			return
		}
		next.ServeHTTP(w, r)
	})
}
