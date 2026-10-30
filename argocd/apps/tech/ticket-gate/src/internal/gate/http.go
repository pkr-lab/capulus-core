package gate

import (
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/netip"
	"strconv"
	"strings"
)

const maxBody = 32 << 10

func (s *Service) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	mux.HandleFunc("POST /v1/session", s.handleSession)
	mux.HandleFunc("POST /v1/verify/request", s.handleRequest)
	mux.HandleFunc("POST /v1/verify/confirm", s.handleConfirm)
	mux.HandleFunc("POST /v1/tickets", s.handleTicket)
	return s.middleware(mux)
}

func (s *Service) originAllowed(origin string) bool {
	for _, o := range s.cfg.AllowedOrigins {
		if o == origin {
			return true
		}
	}
	return false
}

func (s *Service) middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Cache-Control", "no-store")
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")

		if r.URL.Path == "/healthz" {
			next.ServeHTTP(w, r)
			return
		}

		origin := r.Header.Get("Origin")
		if origin != "" {
			if !s.originAllowed(origin) {
				writeJSON(w, http.StatusForbidden, map[string]any{"error": "origin_not_allowed"})
				return
			}
			h.Set("Access-Control-Allow-Origin", origin)
			h.Add("Vary", "Origin")
		}

		if r.Method == http.MethodOptions {
			if origin != "" {
				h.Set("Access-Control-Allow-Methods", "POST, OPTIONS")
				h.Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
				h.Set("Access-Control-Max-Age", "600")
			}
			w.WriteHeader(http.StatusNoContent)
			return
		}

		if r.Method == http.MethodPost && !strings.HasPrefix(strings.ToLower(r.Header.Get("Content-Type")), "application/json") {
			writeJSON(w, http.StatusUnsupportedMediaType, map[string]any{"error": "content_type_invalid"})
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, maxBody)
		next.ServeHTTP(w, r)
	})
}

func (s *Service) clientIP(r *http.Request) string {
	if s.cfg.ClientIPHeader != "" {
		if v := strings.TrimSpace(r.Header.Get(s.cfg.ClientIPHeader)); v != "" {
			if addr, err := netip.ParseAddr(v); err == nil {
				return addr.Unmap().String()
			}
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	if addr, err := netip.ParseAddr(host); err == nil {
		return addr.Unmap().String()
	}
	return host
}

func bearer(r *http.Request) string {
	h := r.Header.Get("Authorization")
	if len(h) > 7 && strings.EqualFold(h[:7], "bearer ") {
		return strings.TrimSpace(h[7:])
	}
	return ""
}

func decode(r *http.Request, dst any) error {
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		return err
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return errors.New("trailing data")
	}
	return nil
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func writeErr(w http.ResponseWriter, e *Error) {
	body := map[string]any{"error": e.Code}
	if e.RetryAfter > 0 {
		secs := int((e.RetryAfter + 999999999) / 1000000000)
		w.Header().Set("Retry-After", strconv.Itoa(secs))
		body["retry_after"] = secs
	}
	if e.Code == "code_invalid" && e.Left > 0 {
		body["attempts_left"] = e.Left
	}
	writeJSON(w, e.Status, body)
}

func badRequest(w http.ResponseWriter) {
	writeJSON(w, http.StatusBadRequest, map[string]any{"error": "request_invalid"})
}

func (s *Service) handleSession(w http.ResponseWriter, r *http.Request) {
	token, ttl, err := s.NewSession(s.clientIP(r))
	if err != nil {
		var e *Error
		errors.As(err, &e)
		writeErr(w, e)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"session_token": token, "expires_in": int(ttl.Seconds())})
}

func (s *Service) handleRequest(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Email string `json:"email"`
	}
	if err := decode(r, &in); err != nil {
		badRequest(w)
		return
	}
	resend, e := s.RequestCode(bearer(r), s.clientIP(r), in.Email)
	if e != nil {
		writeErr(w, e)
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"status": "ok", "resend_after": int(resend.Seconds())})
}

func (s *Service) handleConfirm(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Code string `json:"code"`
	}
	if err := decode(r, &in); err != nil {
		badRequest(w)
		return
	}
	v, e := s.ConfirmCode(bearer(r), s.clientIP(r), in.Code)
	if e != nil {
		writeErr(w, e)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"verification_token": v.Token,
		"email":              v.Email,
		"expires_in":         int(v.ExpiresIn.Seconds()),
	})
}

func (s *Service) handleTicket(w http.ResponseWriter, r *http.Request) {
	var in struct {
		VerificationToken string `json:"verification_token"`
		Name              string `json:"name"`
		Subject           string `json:"subject"`
		Message           string `json:"message"`
	}
	if err := decode(r, &in); err != nil {
		badRequest(w)
		return
	}
	number, e := s.CreateTicket(bearer(r), s.clientIP(r), TicketInput{
		VerificationToken: in.VerificationToken,
		Name:              in.Name,
		Subject:           in.Subject,
		Message:           in.Message,
	})
	if e != nil {
		writeErr(w, e)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"ticket_number": number})
}
