// pacman-server serves the vendored Pacman Canvas static assets and logs
// one structured JSON line per request (client IP, user agent, and — if a
// GeoLite2 database is mounted — the resolved location) for a security
// training that demonstrates what a web server can learn about a visitor.
package main

import (
	"log/slog"
	"net"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/oschwald/geoip2-golang"
)

func main() {
	staticDir := getenv("STATIC_DIR", "/usr/share/pacman/html")
	listenAddr := getenv("LISTEN_ADDR", ":8080")
	dbPath := getenv("GEOIP_DB_PATH", "/geoip/GeoLite2-City.mmdb")

	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))

	geo := openGeoIP(logger, dbPath)
	if geo != nil {
		defer geo.Close()
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok\n"))
	})
	mux.Handle("/", withAccessLog(logger, geo, http.FileServer(http.Dir(staticDir))))

	logger.Info("pacman server starting", "addr", listenAddr, "static_dir", staticDir, "geoip_enabled", geo != nil)
	if err := http.ListenAndServe(listenAddr, mux); err != nil {
		logger.Error("server exited", "error", err.Error())
		os.Exit(1)
	}
}

func openGeoIP(logger *slog.Logger, dbPath string) *geoip2.Reader {
	if _, err := os.Stat(dbPath); err != nil {
		logger.Warn("geoip: database not found, continuing without geo enrichment", "path", dbPath)
		return nil
	}
	reader, err := geoip2.Open(dbPath)
	if err != nil {
		logger.Warn("geoip: failed to open database, continuing without geo enrichment", "path", dbPath, "error", err.Error())
		return nil
	}
	logger.Info("geoip: database loaded", "path", dbPath)
	return reader
}

func getenv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// clientIP extracts the real visitor IP (v4 or v6). Cloudflare sets
// CF-Connecting-IP at its edge — a single authoritative value — before the
// request ever reaches the cluster, unlike X-Forwarded-For which can carry
// a multi-hop chain. Falls back to the first X-Forwarded-For entry, then to
// the raw TCP peer address.
func clientIP(r *http.Request) string {
	if ip := r.Header.Get("CF-Connecting-IP"); ip != "" {
		return ip
	}
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		first, _, _ := strings.Cut(xff, ",")
		return strings.TrimSpace(first)
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(status int) {
	r.status = status
	r.ResponseWriter.WriteHeader(status)
}

func withAccessLog(logger *slog.Logger, geo *geoip2.Reader, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rec, r)

		ip := clientIP(r)
		fields := []any{
			"remote_ip", ip,
			"x_forwarded_for", r.Header.Get("X-Forwarded-For"),
			"method", r.Method,
			"path", r.URL.Path,
			"status", rec.status,
			"duration_ms", time.Since(start).Milliseconds(),
			"user_agent", r.Header.Get("User-Agent"),
			"referer", r.Header.Get("Referer"),
		}

		if geo != nil {
			if parsed := net.ParseIP(ip); parsed != nil {
				if city, err := geo.City(parsed); err == nil {
					fields = append(fields,
						"geo_country_iso", city.Country.IsoCode,
						"geo_country_name", city.Country.Names["en"],
						"geo_city", city.City.Names["en"],
						"geo_lat", city.Location.Latitude,
						"geo_lon", city.Location.Longitude,
					)
				}
			}
		}

		logger.Info("http_access", fields...)
	})
}
