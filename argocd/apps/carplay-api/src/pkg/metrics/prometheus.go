// Package metrics exposes a hand-rolled Prometheus text-format /metrics
// endpoint. A full client_golang dependency would be overkill for four
// counters on a single-replica sidecar-sized service, and it's not the
// dependency the spec actually asked for (Gin is) — this keeps the
// dependency tree, image size, and go.sum small.
package metrics

import (
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
)

type requestKey struct {
	method string
	path   string
	status int
}

// Registry tracks HTTP request counts/durations and cache hit/miss counts
// for this process. Safe for concurrent use.
type Registry struct {
	mu sync.Mutex

	requestsTotal   map[requestKey]int64
	durationSeconds map[requestKey]float64 // running sum, paired with requestsTotal as the count

	cacheHits   int64
	cacheMisses int64

	startedAt time.Time
}

func NewRegistry() *Registry {
	return &Registry{
		requestsTotal:   make(map[requestKey]int64),
		durationSeconds: make(map[requestKey]float64),
		startedAt:       time.Now(),
	}
}

func (r *Registry) observeRequest(method, path string, status int, duration time.Duration) {
	key := requestKey{method: method, path: path, status: status}

	r.mu.Lock()
	defer r.mu.Unlock()
	r.requestsTotal[key]++
	r.durationSeconds[key] += duration.Seconds()
}

// RecordCacheHit/RecordCacheMiss let handlers report dashboard cache
// effectiveness.
func (r *Registry) RecordCacheHit() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.cacheHits++
}

func (r *Registry) RecordCacheMiss() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.cacheMisses++
}

// Middleware records every request's method, route (not raw path, to avoid
// unbounded label cardinality from unknown paths), status, and duration.
func (r *Registry) Middleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		start := time.Now()
		c.Next()

		path := c.FullPath()
		if path == "" {
			path = "unmatched"
		}
		r.observeRequest(c.Request.Method, path, c.Writer.Status(), time.Since(start))
	}
}

// Handler renders the current state in Prometheus text exposition format.
func (r *Registry) Handler() gin.HandlerFunc {
	return func(c *gin.Context) {
		c.String(200, r.render())
	}
}

func (r *Registry) render() string {
	r.mu.Lock()
	defer r.mu.Unlock()

	var b strings.Builder

	b.WriteString("# HELP carplay_api_uptime_seconds Time since process start.\n")
	b.WriteString("# TYPE carplay_api_uptime_seconds gauge\n")
	fmt.Fprintf(&b, "carplay_api_uptime_seconds %f\n", time.Since(r.startedAt).Seconds())

	b.WriteString("# HELP carplay_api_http_requests_total Total HTTP requests.\n")
	b.WriteString("# TYPE carplay_api_http_requests_total counter\n")
	for _, key := range sortedKeys(r.requestsTotal) {
		fmt.Fprintf(&b, "carplay_api_http_requests_total{method=%q,path=%q,status=\"%d\"} %d\n",
			key.method, key.path, key.status, r.requestsTotal[key])
	}

	b.WriteString("# HELP carplay_api_http_request_duration_seconds_sum Cumulative request duration.\n")
	b.WriteString("# TYPE carplay_api_http_request_duration_seconds_sum counter\n")
	for _, key := range sortedKeys(r.requestsTotal) {
		fmt.Fprintf(&b, "carplay_api_http_request_duration_seconds_sum{method=%q,path=%q,status=\"%d\"} %f\n",
			key.method, key.path, key.status, r.durationSeconds[key])
	}

	b.WriteString("# HELP carplay_api_dashboard_cache_hits_total Dashboard cache hits.\n")
	b.WriteString("# TYPE carplay_api_dashboard_cache_hits_total counter\n")
	fmt.Fprintf(&b, "carplay_api_dashboard_cache_hits_total %d\n", r.cacheHits)

	b.WriteString("# HELP carplay_api_dashboard_cache_misses_total Dashboard cache misses.\n")
	b.WriteString("# TYPE carplay_api_dashboard_cache_misses_total counter\n")
	fmt.Fprintf(&b, "carplay_api_dashboard_cache_misses_total %d\n", r.cacheMisses)

	return b.String()
}

func sortedKeys(m map[requestKey]int64) []requestKey {
	keys := make([]requestKey, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool {
		if keys[i].path != keys[j].path {
			return keys[i].path < keys[j].path
		}
		if keys[i].method != keys[j].method {
			return keys[i].method < keys[j].method
		}
		return keys[i].status < keys[j].status
	})
	return keys
}
