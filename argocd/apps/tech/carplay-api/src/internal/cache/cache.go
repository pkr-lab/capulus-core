package cache

import (
	"sync"
	"time"
)

type TTLCache[T any] struct {
	mu        sync.RWMutex
	value     T
	expiresAt time.Time
	ttl       time.Duration
}

func New[T any](ttl time.Duration) *TTLCache[T] {
	return &TTLCache[T]{ttl: ttl}
}

func (c *TTLCache[T]) Get() (T, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()

	var zero T
	if time.Now().After(c.expiresAt) {
		return zero, false
	}
	return c.value, true
}

func (c *TTLCache[T]) Set(value T) {
	c.mu.Lock()
	defer c.mu.Unlock()

	c.value = value
	c.expiresAt = time.Now().Add(c.ttl)
}
