package limiter

import (
	"sync"
	"time"
)

type Rule struct {
	Key    string
	Limit  int
	Window time.Duration
}

type entry struct {
	times  []time.Time
	window time.Duration
}

type Limiter struct {
	mu      sync.Mutex
	now     func() time.Time
	maxKeys int
	hits    map[string]*entry
}

func New(now func() time.Time, maxKeys int) *Limiter {
	return &Limiter{now: now, maxKeys: maxKeys, hits: make(map[string]*entry)}
}

func (l *Limiter) Take(rules ...Rule) (bool, time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()

	for _, r := range rules {
		e := l.hits[r.Key]
		if e == nil {
			if len(l.hits) >= l.maxKeys {
				return false, r.Window
			}
			continue
		}
		e.prune(now, r.Window)
		if len(e.times) >= r.Limit {
			return false, e.times[0].Add(r.Window).Sub(now)
		}
	}

	for _, r := range rules {
		e := l.hits[r.Key]
		if e == nil {
			e = &entry{}
			l.hits[r.Key] = e
		}
		e.window = r.Window
		e.times = append(e.times, now)
	}
	return true, 0
}

func (l *Limiter) Purge() {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	for k, e := range l.hits {
		e.prune(now, e.window)
		if len(e.times) == 0 {
			delete(l.hits, k)
		}
	}
}

func (l *Limiter) Size() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.hits)
}

func (e *entry) prune(now time.Time, window time.Duration) {
	i := 0
	for i < len(e.times) && now.Sub(e.times[i]) >= window {
		i++
	}
	e.times = e.times[i:]
}
