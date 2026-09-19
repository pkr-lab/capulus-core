// Package auth provides the two independent layers carplay-api relies on
// instead of the mTLS the original spec asked for: this cluster's Traefik
// ingress doesn't terminate client-certificate TLS, so "mTLS" here would
// have been a checkbox with nothing behind it. The real boundary is
// network-level (Tailscale-only ingress, see docs/3-apps-workloads/300d0-carplay-api.md) plus a
// Bearer token checked at the application layer.
package auth

import (
	"crypto/subtle"
	"net"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
)

// BearerAuth rejects any request whose Authorization header isn't exactly
// "Bearer <token>", using a constant-time comparison so response timing
// can't be used to brute-force the token byte by byte.
func BearerAuth(token string) gin.HandlerFunc {
	expected := []byte(token)
	return func(c *gin.Context) {
		header := c.GetHeader("Authorization")
		const prefix = "Bearer "
		if !strings.HasPrefix(header, prefix) {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "missing bearer token"})
			return
		}

		provided := []byte(strings.TrimPrefix(header, prefix))
		if len(provided) != len(expected) || subtle.ConstantTimeCompare(provided, expected) != 1 {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "invalid bearer token"})
			return
		}

		c.Next()
	}
}

// IPAllowlist rejects any request whose client IP doesn't fall inside one of
// the given CIDR ranges — the actual "only our network can reach this"
// control. Malformed CIDR strings are dropped with a startup-time panic
// rather than silently ignored, since a typo here would otherwise silently
// open the API to the world.
func IPAllowlist(cidrs []string) gin.HandlerFunc {
	nets := make([]*net.IPNet, 0, len(cidrs))
	for _, cidr := range cidrs {
		_, ipNet, err := net.ParseCIDR(cidr)
		if err != nil {
			panic("auth: invalid CIDR in allowlist: " + cidr)
		}
		nets = append(nets, ipNet)
	}

	return func(c *gin.Context) {
		clientIP := net.ParseIP(c.ClientIP())
		if clientIP == nil {
			c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": "unable to determine client IP"})
			return
		}

		for _, ipNet := range nets {
			if ipNet.Contains(clientIP) {
				c.Next()
				return
			}
		}

		c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": "client network not allowed"})
	}
}

// CORS allows only the configured origins (e.g. the CarPlay app's WKWebView
// origin, if ever used from a browser context) instead of gin's wide-open
// default. Non-browser clients like the iOS app's URLSession ignore CORS
// entirely, so this only matters for a hypothetical web dashboard.
func CORS(allowedOrigins []string) gin.HandlerFunc {
	allowed := make(map[string]bool, len(allowedOrigins))
	for _, origin := range allowedOrigins {
		allowed[origin] = true
	}

	return func(c *gin.Context) {
		origin := c.GetHeader("Origin")
		if origin != "" && allowed[origin] {
			c.Header("Access-Control-Allow-Origin", origin)
			c.Header("Access-Control-Allow-Methods", "GET, OPTIONS")
			c.Header("Access-Control-Allow-Headers", "Authorization, Content-Type")
			c.Header("Vary", "Origin")
		}

		if c.Request.Method == http.MethodOptions {
			c.AbortWithStatus(http.StatusNoContent)
			return
		}

		c.Next()
	}
}
