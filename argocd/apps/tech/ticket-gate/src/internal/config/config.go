package config

import (
	"errors"
	"fmt"
	"log/slog"
	"strconv"
	"strings"
	"time"
)

type SMTP struct {
	Host     string
	Port     string
	Security string
	Username string
	Password string
	From     string
	FromName string
}

type Zammad struct {
	URL   string
	Token string
	Group string
}

type Config struct {
	Port             string
	LogLevel         slog.Level
	AllowedOrigins   []string
	HMACSecret       []byte
	ClientIPHeader   string
	CodeTTL          time.Duration
	TokenTTL         time.Duration
	SessionTTL       time.Duration
	MaxAttempts      int
	MailCooldown     time.Duration
	MailPerEmailHour int
	MailPerIPHour    int
	ConfirmPerIP     int
	ConfirmWindow    time.Duration
	SessionPerIPHour int
	TicketPerIPHour  int
	MaxSessions      int
	SMTP             SMTP
	Zammad           Zammad
}

type reader struct {
	get  func(string) string
	errs []error
}

func (r *reader) str(name, def string) string {
	if v := strings.TrimSpace(r.get(name)); v != "" {
		return v
	}
	return def
}

func (r *reader) required(name string) string {
	v := strings.TrimSpace(r.get(name))
	if v == "" {
		r.errs = append(r.errs, fmt.Errorf("%s fehlt", name))
	}
	return v
}

func (r *reader) integer(name string, def int) int {
	v := strings.TrimSpace(r.get(name))
	if v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil || n <= 0 {
		r.errs = append(r.errs, fmt.Errorf("%s muss eine positive Ganzzahl sein", name))
		return def
	}
	return n
}

func (r *reader) seconds(name string, def int) time.Duration {
	return time.Duration(r.integer(name, def)) * time.Second
}

func Load(get func(string) string) (Config, error) {
	r := &reader{get: get}
	cfg := Config{
		Port:             r.str("PORT", "8080"),
		ClientIPHeader:   r.str("CLIENT_IP_HEADER", ""),
		CodeTTL:          r.seconds("CODE_TTL_SECONDS", 600),
		TokenTTL:         r.seconds("TOKEN_TTL_SECONDS", 1800),
		SessionTTL:       r.seconds("SESSION_TTL_SECONDS", 7200),
		MaxAttempts:      r.integer("MAX_ATTEMPTS", 5),
		MailCooldown:     r.seconds("MAIL_COOLDOWN_SECONDS", 60),
		MailPerEmailHour: r.integer("MAIL_PER_EMAIL_PER_HOUR", 5),
		MailPerIPHour:    r.integer("MAIL_PER_IP_PER_HOUR", 10),
		ConfirmPerIP:     r.integer("CONFIRM_PER_IP", 20),
		ConfirmWindow:    r.seconds("CONFIRM_WINDOW_SECONDS", 600),
		SessionPerIPHour: r.integer("SESSION_PER_IP_PER_HOUR", 30),
		TicketPerIPHour:  r.integer("TICKET_PER_IP_PER_HOUR", 10),
		MaxSessions:      r.integer("MAX_SESSIONS", 50000),
	}

	switch strings.ToLower(r.str("LOG_LEVEL", "info")) {
	case "debug":
		cfg.LogLevel = slog.LevelDebug
	case "warn":
		cfg.LogLevel = slog.LevelWarn
	case "error":
		cfg.LogLevel = slog.LevelError
	default:
		cfg.LogLevel = slog.LevelInfo
	}

	for _, o := range strings.Split(r.get("ALLOWED_ORIGINS"), ",") {
		if o = strings.TrimSpace(o); o != "" {
			cfg.AllowedOrigins = append(cfg.AllowedOrigins, o)
		}
	}
	if len(cfg.AllowedOrigins) == 0 {
		r.errs = append(r.errs, errors.New("ALLOWED_ORIGINS fehlt"))
	}

	secret := r.required("HMAC_SECRET")
	if secret != "" && len(secret) < 32 {
		r.errs = append(r.errs, errors.New("HMAC_SECRET muss mindestens 32 Zeichen lang sein"))
	}
	cfg.HMACSecret = []byte(secret)

	cfg.SMTP = SMTP{
		Host:     r.required("SMTP_HOST"),
		Port:     r.str("SMTP_PORT", "465"),
		Security: strings.ToLower(r.str("SMTP_SECURITY", "tls")),
		Username: r.required("SMTP_USERNAME"),
		Password: r.required("SMTP_PASSWORD"),
		From:     r.required("SMTP_FROM"),
		FromName: r.str("SMTP_FROM_NAME", "EDV-Kretzer"),
	}
	if cfg.SMTP.Security != "tls" && cfg.SMTP.Security != "starttls" {
		r.errs = append(r.errs, errors.New("SMTP_SECURITY muss tls oder starttls sein"))
	}

	cfg.Zammad = Zammad{
		URL:   strings.TrimRight(r.required("ZAMMAD_URL"), "/"),
		Token: r.required("ZAMMAD_TOKEN"),
		Group: r.str("ZAMMAD_GROUP", "Users"),
	}

	if len(r.errs) > 0 {
		return Config{}, errors.Join(r.errs...)
	}
	return cfg, nil
}
