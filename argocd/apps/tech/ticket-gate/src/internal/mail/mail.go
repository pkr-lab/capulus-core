package mail

import (
	"context"
	"crypto/rand"
	"crypto/tls"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"mime"
	"net"
	"net/smtp"
	"strings"
	"time"

	"ticket-gate/internal/config"
)

const base64LineLength = 76

type Mailer interface {
	SendCode(ctx context.Context, to, code string, ttl time.Duration) error
	Send(ctx context.Context, m Message) error
}

type Message struct {
	To      string
	Subject string
	Text    string
	HTML    string
}

type SMTP struct {
	cfg       config.SMTP
	now       func() time.Time
	tlsConfig *tls.Config
	dialHost  string
}

func NewSMTP(cfg config.SMTP, now func() time.Time) *SMTP {
	return &SMTP{cfg: cfg, now: now}
}

func hasLineBreak(s string) bool {
	return strings.ContainsAny(s, "\r\n\x00")
}

func BuildMessage(from, fromName, to, code string, ttl time.Duration, now time.Time, messageID string) ([]byte, error) {
	for _, v := range []string{from, fromName, to, code, messageID} {
		if hasLineBreak(v) {
			return nil, errors.New("unzulaessige Zeichen im Header")
		}
	}
	minutes := int(ttl.Round(time.Minute) / time.Minute)
	body := fmt.Sprintf("Ihr Bestätigungscode lautet:\r\n\r\n%s\r\n\r\n"+
		"Der Code ist %d Minuten gültig und kann nur einmal verwendet werden.\r\n\r\n"+
		"Wenn Sie keinen Code angefordert haben, ignorieren Sie diese E-Mail bitte. Es ist nichts weiter zu tun.\r\n",
		code, minutes)

	fromDomain := from[strings.LastIndex(from, "@")+1:]
	var msg strings.Builder
	msg.WriteString("From: " + mime.QEncoding.Encode("utf-8", fromName) + " <" + from + ">\r\n")
	msg.WriteString("To: <" + to + ">\r\n")
	msg.WriteString("Subject: " + mime.QEncoding.Encode("utf-8", "Ihr Bestätigungscode") + "\r\n")
	msg.WriteString("Date: " + now.Format(time.RFC1123Z) + "\r\n")
	msg.WriteString("Message-ID: <" + messageID + "@" + fromDomain + ">\r\n")
	msg.WriteString("MIME-Version: 1.0\r\n")
	msg.WriteString("Content-Type: text/plain; charset=utf-8\r\n")
	msg.WriteString("Content-Transfer-Encoding: base64\r\n")
	msg.WriteString("Auto-Submitted: auto-generated\r\n")
	msg.WriteString("\r\n")
	msg.WriteString(wrapBase64(body))
	return []byte(msg.String()), nil
}

func wrapBase64(body string) string {
	encoded := base64.StdEncoding.EncodeToString([]byte(body))
	var wrapped strings.Builder
	for len(encoded) > base64LineLength {
		wrapped.WriteString(encoded[:base64LineLength])
		wrapped.WriteString("\r\n")
		encoded = encoded[base64LineLength:]
	}
	wrapped.WriteString(encoded)
	wrapped.WriteString("\r\n")
	return wrapped.String()
}

func BuildRelayMessage(from, fromName string, m Message, now time.Time, messageID string) ([]byte, error) {
	for _, v := range []string{from, fromName, m.To, m.Subject, messageID} {
		if hasLineBreak(v) {
			return nil, errors.New("unzulaessige Zeichen im Header")
		}
	}
	fromDomain := from[strings.LastIndex(from, "@")+1:]
	boundary := "=_" + messageID
	var msg strings.Builder
	msg.WriteString("From: " + mime.QEncoding.Encode("utf-8", fromName) + " <" + from + ">\r\n")
	msg.WriteString("To: <" + m.To + ">\r\n")
	msg.WriteString("Subject: " + mime.QEncoding.Encode("utf-8", m.Subject) + "\r\n")
	msg.WriteString("Date: " + now.Format(time.RFC1123Z) + "\r\n")
	msg.WriteString("Message-ID: <" + messageID + "@" + fromDomain + ">\r\n")
	msg.WriteString("MIME-Version: 1.0\r\n")
	msg.WriteString("Auto-Submitted: auto-generated\r\n")
	if m.HTML == "" {
		msg.WriteString("Content-Type: text/plain; charset=utf-8\r\n")
		msg.WriteString("Content-Transfer-Encoding: base64\r\n")
		msg.WriteString("\r\n")
		msg.WriteString(wrapBase64(m.Text))
		return []byte(msg.String()), nil
	}
	msg.WriteString("Content-Type: multipart/alternative; boundary=\"" + boundary + "\"\r\n")
	msg.WriteString("\r\n")
	for _, part := range []struct{ kind, body string }{{"text/plain", m.Text}, {"text/html", m.HTML}} {
		msg.WriteString("--" + boundary + "\r\n")
		msg.WriteString("Content-Type: " + part.kind + "; charset=utf-8\r\n")
		msg.WriteString("Content-Transfer-Encoding: base64\r\n")
		msg.WriteString("\r\n")
		msg.WriteString(wrapBase64(part.body))
	}
	msg.WriteString("--" + boundary + "--\r\n")
	return []byte(msg.String()), nil
}

func newMessageID() (string, error) {
	idBytes := make([]byte, 12)
	if _, err := rand.Read(idBytes); err != nil {
		return "", err
	}
	return hex.EncodeToString(idBytes), nil
}

func (s *SMTP) SendCode(ctx context.Context, to, code string, ttl time.Duration) error {
	id, err := newMessageID()
	if err != nil {
		return err
	}
	msg, err := BuildMessage(s.cfg.From, s.cfg.FromName, to, code, ttl, s.now(), id)
	if err != nil {
		return err
	}
	return s.deliver(ctx, to, msg)
}

func (s *SMTP) Send(ctx context.Context, m Message) error {
	id, err := newMessageID()
	if err != nil {
		return err
	}
	msg, err := BuildRelayMessage(s.cfg.From, s.cfg.RelayFromName, m, s.now(), id)
	if err != nil {
		return err
	}
	return s.deliver(ctx, m.To, msg)
}

func (s *SMTP) deliver(ctx context.Context, to string, msg []byte) error {

	dialHost := s.cfg.Host
	if s.dialHost != "" {
		dialHost = s.dialHost
	}
	addr := net.JoinHostPort(dialHost, s.cfg.Port)
	dialer := &net.Dialer{Timeout: 10 * time.Second}
	conn, err := dialer.DialContext(ctx, "tcp", addr)
	if err != nil {
		return err
	}
	if deadline, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(deadline)
	}
	tlsCfg := &tls.Config{ServerName: s.cfg.Host, MinVersion: tls.VersionTLS12}
	if s.tlsConfig != nil {
		tlsCfg = s.tlsConfig.Clone()
		tlsCfg.ServerName = s.cfg.Host
	}
	if s.cfg.Security == "tls" {
		conn = tls.Client(conn, tlsCfg)
	}

	client, err := smtp.NewClient(conn, s.cfg.Host)
	if err != nil {
		_ = conn.Close()
		return err
	}
	defer client.Close()

	if s.cfg.Security == "starttls" {
		if err := client.StartTLS(tlsCfg); err != nil {
			return err
		}
	}
	if err := client.Auth(smtp.PlainAuth("", s.cfg.Username, s.cfg.Password, s.cfg.Host)); err != nil {
		return err
	}
	if err := client.Mail(s.cfg.From); err != nil {
		return err
	}
	if err := client.Rcpt(to); err != nil {
		return err
	}
	w, err := client.Data()
	if err != nil {
		return err
	}
	if _, err := w.Write(msg); err != nil {
		return err
	}
	if err := w.Close(); err != nil {
		return err
	}
	return client.Quit()
}
