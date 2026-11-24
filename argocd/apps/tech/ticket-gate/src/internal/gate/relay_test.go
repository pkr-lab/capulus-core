package gate

import (
	"strings"
	"testing"

	"ticket-gate/internal/config"
)

const relayToken = "relay-token-0123456789abcdef0123456789"

func withRelay(c *config.Config) {
	c.RelayToken = []byte(relayToken)
	c.RelayPerHour = 5
	c.RelayPerRcptHour = 2
}

func relayBody(to string) map[string]string {
	return map[string]string{
		"from":    "Plaudi <no-reply@example.com>",
		"to":      to,
		"subject": "Dein Plaudi-Code: 123456",
		"text":    "Dein Anmeldecode lautet 123456",
		"html":    "<p>123456</p>",
	}
}

func TestRelayDisabledWithoutToken(t *testing.T) {
	e := newEnv(t)
	r := e.do("/v1/mail", relayToken, "203.0.113.5", relayBody("a@example.de"))
	mustErr(t, r, 404, "not_found")
	if len(e.mailer.relayedMails()) != 0 {
		t.Fatal("Mail trotz deaktiviertem Relay gesendet")
	}
}

func TestRelaySendsWithValidToken(t *testing.T) {
	e := newEnv(t, withRelay)
	r := e.do("/v1/mail", relayToken, "203.0.113.5", relayBody("Person@Example.DE"))
	if r.Status != 200 {
		t.Fatalf("Status %d (%s)", r.Status, r.Raw)
	}
	got := e.mailer.relayedMails()
	if len(got) != 1 || got[0].To != "person@example.de" || got[0].Subject != "Dein Plaudi-Code: 123456" || got[0].HTML != "<p>123456</p>" {
		t.Fatalf("Mail: %+v", got)
	}
}

func TestRelayRejectsMissingOrWrongToken(t *testing.T) {
	e := newEnv(t, withRelay)
	for _, token := range []string{"", "falsch", relayToken + "x", strings.ToUpper(relayToken)} {
		r := e.do("/v1/mail", token, "203.0.113.5", relayBody("a@example.de"))
		mustErr(t, r, 401, "token_invalid")
	}
	if len(e.mailer.relayedMails()) != 0 {
		t.Fatal("Mail ohne gültiges Token gesendet")
	}
}

func TestRelayRejectsInvalidInput(t *testing.T) {
	e := newEnv(t, withRelay)
	cases := map[string]map[string]string{
		"keine Adresse":    {"to": "kein-mail", "subject": "x", "text": "y"},
		"Header-Injektion": {"to": "a@example.de\r\nBcc: b@example.de", "subject": "x", "text": "y"},
		"kein Betreff":     {"to": "a@example.de", "subject": "  ", "text": "y"},
		"kein Text":        {"to": "a@example.de", "subject": "x", "text": ""},
		"Betreff zu lang":  {"to": "a@example.de", "subject": strings.Repeat("a", 201), "text": "y"},
		"Text zu lang":     {"to": "a@example.de", "subject": "x", "text": strings.Repeat("a", 10001)},
	}
	for name, body := range cases {
		r := e.do("/v1/mail", relayToken, "203.0.113.5", body)
		if r.Status != 400 {
			t.Fatalf("%s: Status %d (%s)", name, r.Status, r.Raw)
		}
	}
	r := e.doWith("/v1/mail", relayToken, "203.0.113.5", map[string]string{"to": "a@example.de", "subject": "x", "text": "y", "bcc": "b@example.de"}, nil)
	mustErr(t, r, 400, "request_invalid")
	if len(e.mailer.relayedMails()) != 0 {
		t.Fatal("ungültige Eingabe wurde gesendet")
	}
}

func TestRelaySubjectLineBreaksAreFlattened(t *testing.T) {
	e := newEnv(t, withRelay)
	body := relayBody("a@example.de")
	body["subject"] = "Hallo\r\nBcc: b@example.de"
	if r := e.do("/v1/mail", relayToken, "203.0.113.5", body); r.Status != 200 {
		t.Fatalf("Status %d (%s)", r.Status, r.Raw)
	}
	if got := e.mailer.relayedMails()[0].Subject; strings.ContainsAny(got, "\r\n") {
		t.Fatalf("Zeilenumbruch im Betreff: %q", got)
	}
}

func TestRelayLimits(t *testing.T) {
	e := newEnv(t, withRelay)
	for i := 0; i < 2; i++ {
		if r := e.do("/v1/mail", relayToken, "203.0.113.5", relayBody("a@example.de")); r.Status != 200 {
			t.Fatalf("Mail %d: %d", i, r.Status)
		}
	}
	mustErr(t, e.do("/v1/mail", relayToken, "203.0.113.5", relayBody("a@example.de")), 429, "rate_limited")
	for _, to := range []string{"b@example.de", "c@example.de"} {
		if r := e.do("/v1/mail", relayToken, "203.0.113.5", relayBody(to)); r.Status != 200 {
			t.Fatalf("%s: %d", to, r.Status)
		}
	}
	mustErr(t, e.do("/v1/mail", relayToken, "203.0.113.5", relayBody("d@example.de")), 429, "rate_limited")
}

func TestRelayRetriesOnceAfterDeliveryFailure(t *testing.T) {
	e := newEnv(t, withRelay)
	e.mailer.relFail = 1
	if r := e.do("/v1/mail", relayToken, "203.0.113.5", relayBody("a@example.de")); r.Status != 200 {
		t.Fatalf("Status %d (%s)", r.Status, r.Raw)
	}
	if e.mailer.attempts() != 2 || len(e.mailer.relayedMails()) != 1 {
		t.Fatalf("Versuche %d, zugestellt %d", e.mailer.attempts(), len(e.mailer.relayedMails()))
	}
}

func TestRelayGivesUpAfterTwoAttemptsWithoutLeakingAddress(t *testing.T) {
	e := newEnv(t, withRelay)
	e.mailer.relErr = errTicket
	if r := e.do("/v1/mail", relayToken, "203.0.113.5", relayBody("a@example.de")); r.Status != 200 {
		t.Fatalf("Status %d (%s)", r.Status, r.Raw)
	}
	if e.mailer.attempts() != 2 {
		t.Fatalf("Versuche %d, erwartet 2", e.mailer.attempts())
	}
	if !contains(e.logs.String(), "relay mail failed") || contains(e.logs.String(), "a@example.de") {
		t.Fatalf("Log: %s", e.logs.String())
	}
}

func TestRelayRejectsForeignOrigin(t *testing.T) {
	e := newEnv(t, withRelay)
	r := e.doWith("/v1/mail", relayToken, "203.0.113.5", relayBody("a@example.de"), map[string]string{"Origin": "https://evil.example"})
	mustErr(t, r, 403, "origin_not_allowed")
}
