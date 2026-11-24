package gate

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"fmt"
	"io"
	"log/slog"
	"math/big"
	"net/http"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"ticket-gate/internal/config"
	"ticket-gate/internal/limiter"
	"ticket-gate/internal/mail"
	"ticket-gate/internal/store"
	"ticket-gate/internal/zammad"
)

var codePattern = regexp.MustCompile(`^[0-9]{6}$`)

const (
	maxLimiterKeys = 200000
	backendTimeout = 20 * time.Second
)

type Service struct {
	cfg     config.Config
	store   *store.Store
	limits  *limiter.Limiter
	mailer  mail.Mailer
	tickets zammad.Ticketer
	now     func() time.Time
	rand    io.Reader
	logger  *slog.Logger
	spawn   func(func())

	retryDelay time.Duration
}

type Deps struct {
	Config  config.Config
	Mailer  mail.Mailer
	Tickets zammad.Ticketer
	Now     func() time.Time
	Rand    io.Reader
	Logger  *slog.Logger
	Spawn   func(func())
}

func NewService(d Deps) *Service {
	if d.Now == nil {
		d.Now = time.Now
	}
	if d.Rand == nil {
		d.Rand = rand.Reader
	}
	if d.Spawn == nil {
		d.Spawn = func(f func()) { go f() }
	}
	if d.Logger == nil {
		d.Logger = slog.New(slog.NewJSONHandler(io.Discard, nil))
	}
	return &Service{
		cfg:     d.Config,
		store:   store.New(d.Now, d.Config.MaxSessions),
		limits:  limiter.New(d.Now, maxLimiterKeys),
		mailer:  d.Mailer,
		tickets: d.Tickets,
		now:     d.Now,
		rand:    d.Rand,
		logger:  d.Logger,
		spawn:   d.Spawn,

		retryDelay: 2 * time.Second,
	}
}

type Error struct {
	Status     int
	Code       string
	RetryAfter time.Duration
	Left       int
}

func (e *Error) Error() string { return e.Code }

func newErr(status int, code string) *Error { return &Error{Status: status, Code: code} }

func (s *Service) mac(parts ...string) []byte {
	h := hmac.New(sha256.New, s.cfg.HMACSecret)
	var n [4]byte
	for _, p := range parts {
		binary.BigEndian.PutUint32(n[:], uint32(len(p)))
		h.Write(n[:])
		h.Write([]byte(p))
	}
	return h.Sum(nil)
}

func (s *Service) macString(parts ...string) string {
	return base64.RawURLEncoding.EncodeToString(s.mac(parts...))
}

func (s *Service) randomToken() (string, error) {
	b := make([]byte, 32)
	if _, err := io.ReadFull(s.rand, b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

func (s *Service) generateCode() (string, error) {
	n, err := rand.Int(s.rand, big.NewInt(1000000))
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("%06d", n.Int64()), nil
}

func (s *Service) sessionKey(token string) string {
	return s.macString("session", token)
}

func rateErr(retry time.Duration) *Error {
	e := newErr(http.StatusTooManyRequests, "rate_limited")
	e.RetryAfter = retry
	return e
}

func (s *Service) NewSession(ip string) (string, time.Duration, error) {
	if ok, retry := s.limits.Take(limiter.Rule{Key: "session-ip:" + ip, Limit: s.cfg.SessionPerIPHour, Window: time.Hour}); !ok {
		return "", 0, rateErr(retry)
	}
	token, err := s.randomToken()
	if err != nil {
		return "", 0, newErr(http.StatusInternalServerError, "internal")
	}
	if err := s.store.CreateSession(s.sessionKey(token), s.cfg.SessionTTL); err != nil {
		return "", 0, newErr(http.StatusServiceUnavailable, "unavailable")
	}
	return token, s.cfg.SessionTTL, nil
}

func (s *Service) authSession(token string) (string, *Error) {
	if token == "" {
		return "", newErr(http.StatusUnauthorized, "session_invalid")
	}
	key := s.sessionKey(token)
	if !s.store.SessionValid(key) {
		return "", newErr(http.StatusUnauthorized, "session_invalid")
	}
	return key, nil
}

func (s *Service) RequestCode(sessionToken, ip, rawEmail string) (time.Duration, *Error) {
	sess, serr := s.authSession(sessionToken)
	if serr != nil {
		return 0, serr
	}
	if ok, retry := s.limits.Take(limiter.Rule{Key: "mail-ip-hour:" + ip, Limit: s.cfg.MailPerIPHour, Window: time.Hour}); !ok {
		return 0, rateErr(retry)
	}
	email, ok := NormalizeEmail(rawEmail)
	if !ok {
		return 0, newErr(http.StatusBadRequest, "email_invalid")
	}
	emailKey := s.macString("email", email)
	if ok, retry := s.limits.Take(
		limiter.Rule{Key: "mail-email-cooldown:" + emailKey, Limit: 1, Window: s.cfg.MailCooldown},
		limiter.Rule{Key: "mail-email-hour:" + emailKey, Limit: s.cfg.MailPerEmailHour, Window: time.Hour},
	); !ok {
		return 0, rateErr(retry)
	}

	code, err := s.generateCode()
	if err != nil {
		return 0, newErr(http.StatusInternalServerError, "internal")
	}
	s.store.PutCode(sess, store.CodeRecord{
		Email:     email,
		Hash:      s.mac("code", sess, email, code),
		ExpiresAt: s.now().Add(s.cfg.CodeTTL),
	})

	ttl := s.cfg.CodeTTL
	s.spawn(func() {
		ctx, cancel := context.WithTimeout(context.Background(), backendTimeout)
		defer cancel()
		if err := s.mailer.SendCode(ctx, email, code, ttl); err != nil {
			s.logger.Error("code mail failed", "error", err.Error())
		}
	})
	return s.cfg.MailCooldown, nil
}

type Verified struct {
	Token     string
	Email     string
	ExpiresIn time.Duration
}

func (s *Service) ConfirmCode(sessionToken, ip, code string) (Verified, *Error) {
	sess, serr := s.authSession(sessionToken)
	if serr != nil {
		return Verified{}, serr
	}
	if ok, retry := s.limits.Take(limiter.Rule{Key: "confirm-ip:" + ip, Limit: s.cfg.ConfirmPerIP, Window: s.cfg.ConfirmWindow}); !ok {
		return Verified{}, rateErr(retry)
	}
	code = strings.TrimSpace(code)
	if !codePattern.MatchString(code) {
		return Verified{}, newErr(http.StatusBadRequest, "code_invalid")
	}

	res := s.store.Attempt(sess, s.cfg.MaxAttempts, func(rec store.CodeRecord) bool {
		expected := s.mac("code", sess, rec.Email, code)
		return hmac.Equal(expected, rec.Hash)
	})
	switch res.Status {
	case store.AttemptOK:
	case store.AttemptInvalid:
		e := newErr(http.StatusBadRequest, "code_invalid")
		e.Left = res.AttemptsLeft
		return Verified{}, e
	case store.AttemptLocked:
		return Verified{}, newErr(http.StatusBadRequest, "code_locked")
	default:
		return Verified{}, newErr(http.StatusBadRequest, "code_expired")
	}

	token, err := s.randomToken()
	if err != nil {
		return Verified{}, newErr(http.StatusInternalServerError, "internal")
	}
	s.store.PutToken(s.macString("token", token), store.TokenRecord{
		SessionID: sess,
		Email:     res.Email,
		ExpiresAt: s.now().Add(s.cfg.TokenTTL),
	})
	return Verified{Token: token, Email: res.Email, ExpiresIn: s.cfg.TokenTTL}, nil
}

type TicketInput struct {
	VerificationToken string
	Name              string
	Subject           string
	Message           string
}

const (
	maxName    = 100
	maxSubject = 200
	maxMessage = 10000
)

func cleanLine(s string) string {
	s = strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return ' '
		}
		return r
	}, s)
	return strings.TrimSpace(s)
}

func cleanText(s string) string {
	s = strings.ReplaceAll(s, "\r\n", "\n")
	s = strings.ReplaceAll(s, "\r", "\n")
	s = strings.Map(func(r rune) rune {
		if r == '\n' || r == '\t' {
			return r
		}
		if r < 0x20 || r == 0x7f {
			return -1
		}
		return r
	}, s)
	return strings.TrimSpace(s)
}

func (s *Service) CreateTicket(sessionToken, ip string, in TicketInput) (string, *Error) {
	sess, serr := s.authSession(sessionToken)
	if serr != nil {
		return "", serr
	}
	if ok, retry := s.limits.Take(limiter.Rule{Key: "ticket-ip:" + ip, Limit: s.cfg.TicketPerIPHour, Window: time.Hour}); !ok {
		return "", rateErr(retry)
	}

	if in.VerificationToken == "" {
		return "", newErr(http.StatusForbidden, "verification_required")
	}

	name := cleanLine(in.Name)
	subject := cleanLine(in.Subject)
	message := cleanText(in.Message)
	if subject == "" || message == "" ||
		utf8.RuneCountInString(name) > maxName ||
		utf8.RuneCountInString(subject) > maxSubject ||
		utf8.RuneCountInString(message) > maxMessage {
		return "", newErr(http.StatusBadRequest, "ticket_invalid")
	}

	rec, ok := s.store.ConsumeToken(s.macString("token", in.VerificationToken), sess)
	if !ok {
		return "", newErr(http.StatusForbidden, "verification_required")
	}

	ctx, cancel := context.WithTimeout(context.Background(), backendTimeout)
	defer cancel()
	number, err := s.tickets.Create(ctx, zammad.Ticket{Email: rec.Email, Name: name, Subject: subject, Message: message})
	if err != nil {
		s.logger.Error("ticket creation failed", "error", err.Error())
		return "", newErr(http.StatusBadGateway, "ticket_failed")
	}
	return number, nil
}

type RelayInput struct {
	Token   string
	To      string
	Subject string
	Text    string
	HTML    string
}

const (
	maxRelaySubject = 200
	maxRelayText    = 10000
	maxRelayHTML    = 20000
	relayAttempts   = 2
)

func (s *Service) tokenMatches(given string) bool {
	if len(s.cfg.RelayToken) == 0 || given == "" {
		return false
	}
	return hmac.Equal(s.mac("relay-token", given), s.mac("relay-token", string(s.cfg.RelayToken)))
}

func (s *Service) Relay(in RelayInput) *Error {
	if len(s.cfg.RelayToken) == 0 {
		return newErr(http.StatusNotFound, "not_found")
	}
	if !s.tokenMatches(in.Token) {
		return newErr(http.StatusUnauthorized, "token_invalid")
	}
	to, ok := NormalizeEmail(in.To)
	subject := cleanLine(in.Subject)
	text := cleanText(in.Text)
	html := cleanText(in.HTML)
	if !ok || subject == "" || text == "" ||
		utf8.RuneCountInString(subject) > maxRelaySubject ||
		utf8.RuneCountInString(text) > maxRelayText ||
		utf8.RuneCountInString(html) > maxRelayHTML {
		return newErr(http.StatusBadRequest, "mail_invalid")
	}
	if ok, retry := s.limits.Take(limiter.Rule{Key: "relay-hour", Limit: s.cfg.RelayPerHour, Window: time.Hour}); !ok {
		return rateErr(retry)
	}
	if ok, retry := s.limits.Take(limiter.Rule{Key: "relay-rcpt:" + s.macString("email", to), Limit: s.cfg.RelayPerRcptHour, Window: time.Hour}); !ok {
		return rateErr(retry)
	}
	msg := mail.Message{To: to, Subject: subject, Text: text, HTML: html}
	s.spawn(func() {
		for attempt := 1; attempt <= relayAttempts; attempt++ {
			ctx, cancel := context.WithTimeout(context.Background(), backendTimeout)
			err := s.mailer.Send(ctx, msg)
			cancel()
			if err == nil {
				return
			}
			s.logger.Error("relay mail failed", "attempt", attempt, "error", err.Error())
			if attempt < relayAttempts {
				time.Sleep(s.retryDelay)
			}
		}
	})
	return nil
}

func (s *Service) Purge() {
	s.store.Purge()
	s.limits.Purge()
}
