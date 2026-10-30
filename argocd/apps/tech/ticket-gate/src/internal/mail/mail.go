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

type Mailer interface {
	SendCode(ctx context.Context, to, code string, ttl time.Duration) error
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

	encodedBody := base64.StdEncoding.EncodeToString([]byte(body))
	var wrapped strings.Builder
	for len(encodedBody) > 76 {
		wrapped.WriteString(encodedBody[:76])
		wrapped.WriteString("\r\n")
		encodedBody = encodedBody[76:]
	}
	wrapped.WriteString(encodedBody)
	wrapped.WriteString("\r\n")

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
	msg.WriteString(wrapped.String())
	return []byte(msg.String()), nil
}

func (s *SMTP) SendCode(ctx context.Context, to, code string, ttl time.Duration) error {
	idBytes := make([]byte, 12)
	if _, err := rand.Read(idBytes); err != nil {
		return err
	}
	msg, err := BuildMessage(s.cfg.From, s.cfg.FromName, to, code, ttl, s.now(), hex.EncodeToString(idBytes))
	if err != nil {
		return err
	}

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
