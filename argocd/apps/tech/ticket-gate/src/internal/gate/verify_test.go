package gate

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"
	"time"

	"ticket-gate/internal/config"
)

func TestTicketWithoutAnyAuthIsRejected(t *testing.T) {
	e := newEnv(t)
	r := e.do("/v1/tickets", "", "10.0.0.1", map[string]string{"subject": "x", "message": "y"})
	mustErr(t, r, 401, "session_invalid")
	if len(e.tickets.all()) != 0 {
		t.Fatal("Ticket wurde angelegt")
	}
}

func TestTicketWithoutVerificationIsRejected(t *testing.T) {
	e := newEnv(t)
	sess := e.session("10.0.0.1")
	r := e.do("/v1/tickets", sess, "10.0.0.1", map[string]string{"subject": "x", "message": "y"})
	mustErr(t, r, 403, "verification_required")
	r = e.submit(sess, "erfundenes-token", "10.0.0.1")
	mustErr(t, r, 403, "verification_required")
	if len(e.tickets.all()) != 0 {
		t.Fatal("Ticket wurde angelegt")
	}
}

func TestTicketWithEmailFieldIsRejected(t *testing.T) {
	e := newEnv(t)
	sess := e.session("10.0.0.1")
	token := e.verified(sess, "ich@example.de", "10.0.0.1")
	r := e.do("/v1/tickets", sess, "10.0.0.1", map[string]string{
		"verification_token": token,
		"email":              "opfer@example.de",
		"subject":            "x",
		"message":            "y",
	})
	mustErr(t, r, 400, "request_invalid")
	if len(e.tickets.all()) != 0 {
		t.Fatal("Ticket wurde angelegt")
	}
}

func TestTicketUsesVerifiedEmail(t *testing.T) {
	e := newEnv(t)
	sess := e.session("10.0.0.1")
	token := e.verified(sess, "  Ich@Example.DE ", "10.0.0.1")
	r := e.submit(sess, token, "10.0.0.1")
	if r.Status != 201 || r.Body["ticket_number"] != "10001" {
		t.Fatalf("unerwartet: %d %s", r.Status, r.Raw)
	}
	created := e.tickets.all()
	if len(created) != 1 || created[0].Email != "ich@example.de" {
		t.Fatalf("falsche Adresse im Ticket: %+v", created)
	}
}

func TestVerificationTokenIsSingleUse(t *testing.T) {
	e := newEnv(t)
	sess := e.session("10.0.0.1")
	token := e.verified(sess, "ich@example.de", "10.0.0.1")
	if r := e.submit(sess, token, "10.0.0.1"); r.Status != 201 {
		t.Fatalf("erstes Absenden: %d %s", r.Status, r.Raw)
	}
	mustErr(t, e.submit(sess, token, "10.0.0.1"), 403, "verification_required")
	if len(e.tickets.all()) != 1 {
		t.Fatalf("erwartet genau ein Ticket, vorhanden: %d", len(e.tickets.all()))
	}
}

func TestVerificationTokenBoundToSession(t *testing.T) {
	e := newEnv(t)
	sessA := e.session("10.0.0.1")
	sessB := e.session("10.0.0.2")
	token := e.verified(sessA, "ich@example.de", "10.0.0.1")
	mustErr(t, e.submit(sessB, token, "10.0.0.2"), 403, "verification_required")
	if r := e.submit(sessA, token, "10.0.0.1"); r.Status != 201 {
		t.Fatalf("legitime Session: %d %s", r.Status, r.Raw)
	}
}

func TestVerificationTokenExpires(t *testing.T) {
	e := newEnv(t)
	sess := e.session("10.0.0.1")
	token := e.verified(sess, "ich@example.de", "10.0.0.1")
	e.clock.Advance(30*time.Minute + time.Second)
	mustErr(t, e.submit(sess, token, "10.0.0.1"), 403, "verification_required")
}

func TestNewVerificationInvalidatesOldToken(t *testing.T) {
	e := newEnv(t)
	sess := e.session("10.0.0.1")
	old := e.verified(sess, "ich@example.de", "10.0.0.1")
	e.clock.Advance(2 * time.Minute)
	fresh := e.verified(sess, "ich@example.de", "10.0.0.1")
	mustErr(t, e.submit(sess, old, "10.0.0.1"), 403, "verification_required")
	if r := e.submit(sess, fresh, "10.0.0.1"); r.Status != 201 {
		t.Fatalf("neues Token: %d %s", r.Status, r.Raw)
	}
}

func TestWrongCodeIsRejected(t *testing.T) {
	e := newEnv(t)
	sess := e.session("10.0.0.1")
	e.requestCode(sess, "ich@example.de", "10.0.0.1")
	r := e.confirm(sess, wrongCode(e.mailer.last("ich@example.de")), "10.0.0.1")
	mustErr(t, r, 400, "code_invalid")
	if r.Body["attempts_left"] != float64(4) {
		t.Fatalf("attempts_left: %v", r.Body["attempts_left"])
	}
}

func TestMalformedCodeIsRejected(t *testing.T) {
	e := newEnv(t)
	sess := e.session("10.0.0.1")
	e.requestCode(sess, "ich@example.de", "10.0.0.1")
	for _, c := range []string{"", "12345", "1234567", "abcdef", "12 456", "١٢٣٤٥٦"} {
		mustErr(t, e.confirm(sess, c, "10.0.0.1"), 400, "code_invalid")
	}
}

func TestExpiredCodeIsRejected(t *testing.T) {
	e := newEnv(t)
	sess := e.session("10.0.0.1")
	e.requestCode(sess, "ich@example.de", "10.0.0.1")
	code := e.mailer.last("ich@example.de")
	e.clock.Advance(10*time.Minute + time.Second)
	mustErr(t, e.confirm(sess, code, "10.0.0.1"), 400, "code_expired")
}

func TestCodeValidJustBeforeExpiry(t *testing.T) {
	e := newEnv(t)
	sess := e.session("10.0.0.1")
	e.requestCode(sess, "ich@example.de", "10.0.0.1")
	code := e.mailer.last("ich@example.de")
	e.clock.Advance(10*time.Minute - time.Second)
	if r := e.confirm(sess, code, "10.0.0.1"); r.Status != 200 {
		t.Fatalf("%d %s", r.Status, r.Raw)
	}
}

func TestReusedCodeIsRejected(t *testing.T) {
	e := newEnv(t)
	sess := e.session("10.0.0.1")
	e.requestCode(sess, "ich@example.de", "10.0.0.1")
	code := e.mailer.last("ich@example.de")
	if r := e.confirm(sess, code, "10.0.0.1"); r.Status != 200 {
		t.Fatalf("%d %s", r.Status, r.Raw)
	}
	mustErr(t, e.confirm(sess, code, "10.0.0.1"), 400, "code_expired")
}

func TestCodeOfOtherEmailIsRejectedAcrossSessions(t *testing.T) {
	e := newEnv(t)
	sessA := e.session("10.0.0.1")
	sessB := e.session("10.0.0.2")
	e.requestCode(sessA, "a@example.de", "10.0.0.1")
	e.requestCode(sessB, "b@example.de", "10.0.0.2")
	codeA := e.mailer.last("a@example.de")
	if codeA == e.mailer.last("b@example.de") {
		t.Skip("zufällig identische Codes")
	}
	mustErr(t, e.confirm(sessB, codeA, "10.0.0.2"), 400, "code_invalid")
}

func TestCodeOfOtherEmailIsRejectedInSameSession(t *testing.T) {
	e := newEnv(t)
	sess := e.session("10.0.0.1")
	e.requestCode(sess, "a@example.de", "10.0.0.1")
	codeA := e.mailer.last("a@example.de")
	e.clock.Advance(61 * time.Second)
	e.requestCode(sess, "b@example.de", "10.0.0.1")
	if codeA == e.mailer.last("b@example.de") {
		t.Skip("zufällig identische Codes")
	}
	mustErr(t, e.confirm(sess, codeA, "10.0.0.1"), 400, "code_invalid")
}

func TestCodeFromOtherSessionIsRejected(t *testing.T) {
	e := newEnv(t)
	sessA := e.session("10.0.0.1")
	sessB := e.session("10.0.0.2")
	e.requestCode(sessA, "ich@example.de", "10.0.0.1")
	code := e.mailer.last("ich@example.de")
	mustErr(t, e.confirm(sessB, code, "10.0.0.2"), 400, "code_expired")
	e.clock.Advance(61 * time.Second)
	e.requestCode(sessB, "ich@example.de", "10.0.0.2")
	if code == e.mailer.last("ich@example.de") {
		t.Skip("zufällig identische Codes")
	}
	mustErr(t, e.confirm(sessB, code, "10.0.0.2"), 400, "code_invalid")
}

func TestNewCodeInvalidatesOldCode(t *testing.T) {
	e := newEnv(t)
	sess := e.session("10.0.0.1")
	e.requestCode(sess, "ich@example.de", "10.0.0.1")
	oldCode := e.mailer.last("ich@example.de")
	e.clock.Advance(61 * time.Second)
	e.requestCode(sess, "ich@example.de", "10.0.0.1")
	newCode := e.mailer.last("ich@example.de")
	if oldCode == newCode {
		t.Skip("zufällig identische Codes")
	}
	mustErr(t, e.confirm(sess, oldCode, "10.0.0.1"), 400, "code_invalid")
	if r := e.confirm(sess, newCode, "10.0.0.1"); r.Status != 200 {
		t.Fatalf("%d %s", r.Status, r.Raw)
	}
}

func TestCodeLockedAfterFiveFailures(t *testing.T) {
	e := newEnv(t)
	sess := e.session("10.0.0.1")
	e.requestCode(sess, "ich@example.de", "10.0.0.1")
	code := e.mailer.last("ich@example.de")
	bad := wrongCode(code)
	for i := 0; i < 4; i++ {
		mustErr(t, e.confirm(sess, bad, "10.0.0.1"), 400, "code_invalid")
	}
	mustErr(t, e.confirm(sess, bad, "10.0.0.1"), 400, "code_locked")
	mustErr(t, e.confirm(sess, code, "10.0.0.1"), 400, "code_expired")

	e.clock.Advance(61 * time.Second)
	e.requestCode(sess, "ich@example.de", "10.0.0.1")
	if r := e.confirm(sess, e.mailer.last("ich@example.de"), "10.0.0.1"); r.Status != 200 {
		t.Fatalf("neuer Code nach Sperre: %d %s", r.Status, r.Raw)
	}
}

func TestFailuresAreNotResetByOtherIPs(t *testing.T) {
	e := newEnv(t)
	sess := e.session("10.0.0.1")
	e.requestCode(sess, "ich@example.de", "10.0.0.1")
	code := e.mailer.last("ich@example.de")
	bad := wrongCode(code)
	for i := 0; i < 5; i++ {
		e.confirm(sess, bad, fmt.Sprintf("10.9.0.%d", i))
	}
	mustErr(t, e.confirm(sess, code, "10.0.0.1"), 400, "code_expired")
}

func TestCodeFormatAndDistribution(t *testing.T) {
	e := newEnv(t)
	re := regexp.MustCompile(`^[0-9]{6}$`)
	seen := map[byte]int{}
	for i := 0; i < 3000; i++ {
		c, err := e.svc.generateCode()
		if err != nil || !re.MatchString(c) {
			t.Fatalf("ungültiger Code %q (%v)", c, err)
		}
		seen[c[0]]++
	}
	for d := byte('0'); d <= '9'; d++ {
		if seen[d] < 150 || seen[d] > 450 {
			t.Fatalf("auffällige Verteilung der ersten Ziffer: %v", seen)
		}
	}
}

func TestCodeKeepsLeadingZeros(t *testing.T) {
	e := newEnv(t)
	e.svc.rand = bytes.NewReader(make([]byte, 64))
	c, err := e.svc.generateCode()
	if err != nil || c != "000000" {
		t.Fatalf("Code %q (%v)", c, err)
	}
}

func TestCodeIsNeverExposedOrStoredInPlaintext(t *testing.T) {
	e := newEnv(t)
	sess := e.session("10.0.0.1")
	r := e.requestCode(sess, "ich@example.de", "10.0.0.1")
	code := e.mailer.last("ich@example.de")
	if contains(r.Raw, code) {
		t.Fatal("Code in der Antwort")
	}
	for _, rec := range e.svc.store.Codes() {
		if contains(string(rec.Hash), code) || len(rec.Hash) != 32 {
			t.Fatal("Code nicht gehasht gespeichert")
		}
	}
	c := e.confirm(sess, wrongCode(code), "10.0.0.1")
	if contains(c.Raw, code) {
		t.Fatal("Code in der Fehlerantwort")
	}
	e.confirm(sess, code, "10.0.0.1")
	if contains(e.logs.String(), code) || contains(e.logs.String(), "ich@example.de") {
		t.Fatalf("Code oder Adresse im Log: %s", e.logs.String())
	}
}

func TestResponseDoesNotRevealAddress(t *testing.T) {
	e := newEnv(t)
	sess := e.session("10.0.0.1")
	a := e.requestCode(sess, "bekannt@example.de", "10.0.0.1")
	b := e.requestCode(sess, "unbekannt@example.org", "10.0.0.1")
	if a.Status != b.Status || a.Raw != b.Raw {
		t.Fatalf("Antworten unterscheiden sich: %q vs %q", a.Raw, b.Raw)
	}
}

func TestInvalidEmailsAreRejected(t *testing.T) {
	e := newEnv(t)
	sess := e.session("10.0.0.1")
	for _, bad := range []string{
		"",
		"kein-at.de",
		"a@b",
		"a@@b.de",
		"a b@example.de",
		"a@example.de\r\nBcc: x@y.de",
		"a@example.de\nBcc: x@y.de",
		"a@example.de,b@example.de",
		"<a@example.de>",
		"\"a\"@example.de",
		"a@exa mple.de",
		"a@-example.de",
		"a@example..de",
		".a@example.de",
		strings.Repeat("a", 65) + "@example.de",
		"a@" + strings.Repeat("b", 250) + ".de",
	} {
		mustErr(t, e.requestCode(sess, bad, "10.0.0.1"), 400, "email_invalid")
	}
	if e.mailer.count() != 0 {
		t.Fatal("Mail für ungültige Adresse versendet")
	}
}

func TestNormalizeEmail(t *testing.T) {
	got, ok := NormalizeEmail("  Max.Muster+tag@Example.DE\t")
	if !ok || got != "max.muster+tag@example.de" {
		t.Fatalf("%q %v", got, ok)
	}
}

func TestRequestNeedsValidSession(t *testing.T) {
	e := newEnv(t)
	mustErr(t, e.requestCode("", "ich@example.de", "10.0.0.1"), 401, "session_invalid")
	mustErr(t, e.requestCode("gibt-es-nicht", "ich@example.de", "10.0.0.1"), 401, "session_invalid")
	mustErr(t, e.confirm("gibt-es-nicht", "123456", "10.0.0.1"), 401, "session_invalid")
	if e.mailer.count() != 0 {
		t.Fatal("Mail ohne Session versendet")
	}
}

func TestSessionExpires(t *testing.T) {
	e := newEnv(t)
	sess := e.session("10.0.0.1")
	e.clock.Advance(2*time.Hour + time.Second)
	mustErr(t, e.requestCode(sess, "ich@example.de", "10.0.0.1"), 401, "session_invalid")
}

func TestExpiredEntriesArePurged(t *testing.T) {
	e := newEnv(t)
	sess := e.session("10.0.0.1")
	e.verified(sess, "ich@example.de", "10.0.0.1")
	e.session("10.0.0.2")
	e.requestCode(e.session("10.0.0.3"), "zweite@example.de", "10.0.0.3")
	e.clock.Advance(3 * time.Hour)
	e.svc.Purge()
	s, c, tk := e.svc.store.Counts()
	if s != 0 || c != 0 || tk != 0 {
		t.Fatalf("Reste nach Purge: sessions=%d codes=%d tokens=%d", s, c, tk)
	}
	if n := e.svc.limits.Size(); n != 0 {
		t.Fatalf("Limiter-Reste nach Purge: %d", n)
	}
}

func TestRateLimitEmailCooldown(t *testing.T) {
	e := newEnv(t)
	sess := e.session("10.0.0.1")
	if r := e.requestCode(sess, "ich@example.de", "10.0.0.1"); r.Status != 202 {
		t.Fatalf("%d", r.Status)
	}
	r := e.requestCode(sess, "ich@example.de", "10.0.0.1")
	mustErr(t, r, 429, "rate_limited")
	if r.Header.Get("Retry-After") == "" {
		t.Fatal("Retry-After fehlt")
	}
	other := e.session("10.0.0.2")
	mustErr(t, e.requestCode(other, " ICH@example.de", "10.0.0.2"), 429, "rate_limited")
	if e.mailer.count() != 1 {
		t.Fatalf("Mails: %d", e.mailer.count())
	}
	e.clock.Advance(61 * time.Second)
	if r := e.requestCode(sess, "ich@example.de", "10.0.0.1"); r.Status != 202 {
		t.Fatalf("nach Cooldown: %d %s", r.Status, r.Raw)
	}
}

func TestRateLimitEmailPerHour(t *testing.T) {
	e := newEnv(t)
	sess := e.session("10.0.0.1")
	for i := 0; i < 5; i++ {
		if r := e.requestCode(sess, "ich@example.de", "10.0.0.1"); r.Status != 202 {
			t.Fatalf("Mail %d: %d %s", i+1, r.Status, r.Raw)
		}
		e.clock.Advance(61 * time.Second)
	}
	mustErr(t, e.requestCode(sess, "ich@example.de", "10.0.0.1"), 429, "rate_limited")
	e.clock.Advance(time.Hour)
	if r := e.requestCode(sess, "ich@example.de", "10.0.0.1"); r.Status != 202 {
		t.Fatalf("nach einer Stunde: %d %s", r.Status, r.Raw)
	}
}

func TestRateLimitMailPerIP(t *testing.T) {
	e := newEnv(t, func(c *config.Config) { c.MailPerIPHour = 3 })
	sess := e.session("10.0.0.1")
	for i := 0; i < 3; i++ {
		addr := fmt.Sprintf("u%d@example.de", i)
		if r := e.requestCode(sess, addr, "10.0.0.1"); r.Status != 202 {
			t.Fatalf("%d: %d %s", i, r.Status, r.Raw)
		}
	}
	mustErr(t, e.requestCode(sess, "u9@example.de", "10.0.0.1"), 429, "rate_limited")
	other := e.session("10.0.0.2")
	if r := e.requestCode(other, "u9@example.de", "10.0.0.2"); r.Status != 202 {
		t.Fatalf("andere IP: %d %s", r.Status, r.Raw)
	}
}

func TestRateLimitConfirmPerIP(t *testing.T) {
	e := newEnv(t, func(c *config.Config) { c.ConfirmPerIP = 3 })
	for i := 0; i < 3; i++ {
		sess := e.session(fmt.Sprintf("10.1.0.%d", i))
		mustErr(t, e.confirm(sess, "123456", "10.0.0.1"), 400, "code_expired")
	}
	sess := e.session("10.1.0.9")
	mustErr(t, e.confirm(sess, "123456", "10.0.0.1"), 429, "rate_limited")
	e.clock.Advance(10*time.Minute + time.Second)
	mustErr(t, e.confirm(sess, "123456", "10.0.0.1"), 400, "code_expired")
}

func TestRateLimitSessionPerIP(t *testing.T) {
	e := newEnv(t, func(c *config.Config) { c.SessionPerIPHour = 2 })
	e.session("10.0.0.1")
	e.session("10.0.0.1")
	mustErr(t, e.do("/v1/session", "", "10.0.0.1", nil), 429, "rate_limited")
}

func TestRateLimitTicketPerIP(t *testing.T) {
	e := newEnv(t, func(c *config.Config) { c.TicketPerIPHour = 2 })
	sess := e.session("10.0.0.1")
	mustErr(t, e.submit(sess, "x", "10.0.0.1"), 403, "verification_required")
	mustErr(t, e.submit(sess, "x", "10.0.0.1"), 403, "verification_required")
	mustErr(t, e.submit(sess, "x", "10.0.0.1"), 429, "rate_limited")
}

func TestSessionCapacityIsBounded(t *testing.T) {
	e := newEnv(t, func(c *config.Config) { c.MaxSessions = 2 })
	e.session("10.0.0.1")
	e.session("10.0.0.2")
	mustErr(t, e.do("/v1/session", "", "10.0.0.3", nil), 503, "unavailable")
}

func TestTicketFailureConsumesToken(t *testing.T) {
	e := newEnv(t)
	sess := e.session("10.0.0.1")
	token := e.verified(sess, "ich@example.de", "10.0.0.1")
	e.tickets.err = errTicket
	mustErr(t, e.submit(sess, token, "10.0.0.1"), 502, "ticket_failed")
	e.tickets.err = nil
	mustErr(t, e.submit(sess, token, "10.0.0.1"), 403, "verification_required")
}

func TestInvalidTicketContentDoesNotConsumeToken(t *testing.T) {
	e := newEnv(t)
	sess := e.session("10.0.0.1")
	token := e.verified(sess, "ich@example.de", "10.0.0.1")
	r := e.do("/v1/tickets", sess, "10.0.0.1", map[string]string{"verification_token": token, "subject": "", "message": "x"})
	mustErr(t, r, 400, "ticket_invalid")
	r = e.do("/v1/tickets", sess, "10.0.0.1", map[string]string{"verification_token": token, "subject": strings.Repeat("a", 201), "message": "x"})
	mustErr(t, r, 400, "ticket_invalid")
	if r := e.submit(sess, token, "10.0.0.1"); r.Status != 201 {
		t.Fatalf("%d %s", r.Status, r.Raw)
	}
}

func TestSubjectLineBreaksAreStripped(t *testing.T) {
	e := newEnv(t)
	sess := e.session("10.0.0.1")
	token := e.verified(sess, "ich@example.de", "10.0.0.1")
	r := e.do("/v1/tickets", sess, "10.0.0.1", map[string]string{
		"verification_token": token, "name": "Max\r\nMuster", "subject": "Hallo\r\nBcc: x", "message": "Zeile1\r\nZeile2",
	})
	if r.Status != 201 {
		t.Fatalf("%d %s", r.Status, r.Raw)
	}
	got := e.tickets.all()[0]
	if strings.ContainsAny(got.Subject, "\r\n") || strings.ContainsAny(got.Name, "\r\n") || strings.Contains(got.Message, "\r") {
		t.Fatalf("Steuerzeichen nicht entfernt: %+v", got)
	}
}

func TestConcurrentTokenUseCreatesOneTicket(t *testing.T) {
	e := newEnv(t)
	sess := e.session("10.0.0.1")
	token := e.verified(sess, "ich@example.de", "10.0.0.1")
	results := make(chan int, 20)
	for i := 0; i < 20; i++ {
		go func() { results <- e.submit(sess, token, "10.0.0.1").Status }()
	}
	created := 0
	for i := 0; i < 20; i++ {
		if <-results == 201 {
			created++
		}
	}
	if created != 1 || len(e.tickets.all()) != 1 {
		t.Fatalf("Tickets: %d", created)
	}
}

func TestOriginHandling(t *testing.T) {
	e := newEnv(t)
	r := e.doWith("/v1/session", "", "10.0.0.1", nil, map[string]string{"Origin": "https://evil.example"})
	mustErr(t, r, 403, "origin_not_allowed")

	r = e.doWith("/v1/session", "", "10.0.0.1", nil, map[string]string{"Origin": testOrigin})
	if r.Status != 200 || r.Header.Get("Access-Control-Allow-Origin") != testOrigin {
		t.Fatalf("%d %v", r.Status, r.Header)
	}
	if r.Header.Get("Access-Control-Allow-Credentials") != "" {
		t.Fatal("Credentials dürfen nicht erlaubt sein")
	}

	req := httptest.NewRequest(http.MethodOptions, "/v1/tickets", nil)
	req.Header.Set("Origin", testOrigin)
	req.Header.Set("Access-Control-Request-Method", "POST")
	rec := httptest.NewRecorder()
	e.h.ServeHTTP(rec, req)
	if rec.Code != 204 || !strings.Contains(rec.Header().Get("Access-Control-Allow-Headers"), "Authorization") {
		t.Fatalf("Preflight: %d %v", rec.Code, rec.Header())
	}

	req = httptest.NewRequest(http.MethodOptions, "/v1/tickets", nil)
	req.Header.Set("Origin", "https://evil.example")
	rec = httptest.NewRecorder()
	e.h.ServeHTTP(rec, req)
	if rec.Code != 403 {
		t.Fatalf("Preflight fremder Origin: %d", rec.Code)
	}
}

func TestContentTypeAndBodyLimits(t *testing.T) {
	e := newEnv(t)
	req := httptest.NewRequest(http.MethodPost, "/v1/session", strings.NewReader("a=b"))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	rec := httptest.NewRecorder()
	e.h.ServeHTTP(rec, req)
	if rec.Code != 415 {
		t.Fatalf("Content-Type: %d", rec.Code)
	}

	sess := e.session("10.0.0.1")
	big, _ := json.Marshal(map[string]string{"email": strings.Repeat("a", 40000)})
	req = httptest.NewRequest(http.MethodPost, "/v1/verify/request", bytes.NewReader(big))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+sess)
	rec = httptest.NewRecorder()
	e.h.ServeHTTP(rec, req)
	if rec.Code != 400 {
		t.Fatalf("zu großer Body: %d", rec.Code)
	}
}

func TestResponsesAreNotCacheable(t *testing.T) {
	e := newEnv(t)
	r := e.do("/v1/session", "", "10.0.0.1", nil)
	if r.Header.Get("Cache-Control") != "no-store" {
		t.Fatal("Cache-Control fehlt")
	}
}
