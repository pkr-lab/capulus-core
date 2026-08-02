// Package cache implements a minimal single-value TTL cache. The dashboard
// is expensive to assemble (three upstream calls) but changes slowly, so one
// cached value shared by every request is enough — no per-key store needed.
package cache

import (
	"sync"
	"time"
)

// TTLCache holds one value of type T, valid for a fixed duration after it
// was set. Safe for concurrent use.
type TTLCache[T any] struct {
	mu        sync.RWMutex
	value     T
	expiresAt time.Time
	ttl       time.Duration
}

// New creates a cache that expires values after ttl.
func New[T any](ttl time.Duration) *TTLCache[T] {
	return &TTLCache[T]{ttl: ttl}
}

// Get returns the cached value and true if it exists and hasn't expired.
func (c *TTLCache[T]) Get() (T, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()

	var zero T
	if time.Now().After(c.expiresAt) {
		return zero, false
	}
	return c.value, true
}

// Set stores value, valid until now+ttl.
func (c *TTLCache[T]) Set(value T) {
	c.mu.Lock()
	defer c.mu.Unlock()

	c.value = value
	c.expiresAt = time.Now().Add(c.ttl)
}
