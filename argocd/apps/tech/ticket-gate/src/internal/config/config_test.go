package config

import (
	"strings"
	"testing"
)

func env(m map[string]string) func(string) string {
	return func(k string) string { return m[k] }
}

func base() map[string]string {
	return map[string]string{
		"ALLOWED_ORIGINS": "https://www.edv-kretzer.de, https://edv-kretzer.de",
		"HMAC_SECRET":     strings.Repeat("s", 32),
		"SMTP_HOST":       "mail.example.de",
		"SMTP_USERNAME":   "info@example.de",
		"SMTP_PASSWORD":   "pw",
		"SMTP_FROM":       "info@example.de",
		"ZAMMAD_URL":      "http://zammad-nginx.zammad.svc:8080/",
		"ZAMMAD_TOKEN":    "tok",
	}
}

func TestLoadDefaults(t *testing.T) {
	cfg, err := Load(env(base()))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.MaxAttempts != 5 || cfg.CodeTTL.Minutes() != 10 || cfg.TokenTTL.Minutes() != 30 || cfg.MailCooldown.Seconds() != 60 || cfg.MailPerEmailHour != 5 {
		t.Fatalf("Defaults: %+v", cfg)
	}
	if len(cfg.AllowedOrigins) != 2 || cfg.Zammad.URL != "http://zammad-nginx.zammad.svc:8080" {
		t.Fatalf("Werte: %+v", cfg)
	}
}

func TestLoadRequiresSecretsAndOrigins(t *testing.T) {
	for _, key := range []string{"ALLOWED_ORIGINS", "HMAC_SECRET", "SMTP_HOST", "SMTP_PASSWORD", "ZAMMAD_TOKEN", "ZAMMAD_URL", "SMTP_FROM"} {
		m := base()
		delete(m, key)
		if _, err := Load(env(m)); err == nil {
			t.Fatalf("%s fehlt, kein Fehler", key)
		}
	}
}

func TestLoadRejectsWeakSecretAndBadNumbers(t *testing.T) {
	m := base()
	m["HMAC_SECRET"] = "kurz"
	if _, err := Load(env(m)); err == nil {
		t.Fatal("kurzes Secret akzeptiert")
	}
	m = base()
	m["MAX_ATTEMPTS"] = "abc"
	if _, err := Load(env(m)); err == nil {
		t.Fatal("ungültige Zahl akzeptiert")
	}
	m = base()
	m["SMTP_SECURITY"] = "plain"
	if _, err := Load(env(m)); err == nil {
		t.Fatal("SMTP_SECURITY=plain akzeptiert")
	}
}
