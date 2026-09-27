package auth

import (
	"net/http"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
)

type window struct {
	start time.Time
	count int
}

type RateLimiter struct {
	mu         sync.Mutex
	windows    map[string]*window
	limit      int
	windowSize time.Duration
}

func NewRateLimiter(limit int, windowSize time.Duration) *RateLimiter {
	rl := &RateLimiter{
		windows:    make(map[string]*window),
		limit:      limit,
		windowSize: windowSize,
	}
	go rl.sweepLoop()
	return rl
}

func (rl *RateLimiter) sweepLoop() {
	ticker := time.NewTicker(5 * time.Minute)
	for range ticker.C {
		cutoff := time.Now().Add(-2 * rl.windowSize)
		rl.mu.Lock()
		for ip, w := range rl.windows {
			if w.start.Before(cutoff) {
				delete(rl.windows, ip)
			}
		}
		rl.mu.Unlock()
	}
}

func (rl *RateLimiter) allow(ip string) bool {
	rl.mu.Lock()
	defer rl.mu.Unlock()

	now := time.Now()
	w, exists := rl.windows[ip]
	if !exists || now.Sub(w.start) >= rl.windowSize {
		rl.windows[ip] = &window{start: now, count: 1}
		return true
	}

	if w.count >= rl.limit {
		return false
	}
	w.count++
	return true
}

func (rl *RateLimiter) Middleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		if !rl.allow(c.ClientIP()) {
			c.AbortWithStatusJSON(http.StatusTooManyRequests, gin.H{"error": "rate limit exceeded"})
			return
		}
		c.Next()
	}
}
