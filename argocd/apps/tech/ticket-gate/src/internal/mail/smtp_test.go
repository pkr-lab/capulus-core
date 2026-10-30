package mail

import (
	"bufio"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"math/big"
	"net"
	"strings"
	"sync"
	"testing"
	"time"

	"ticket-gate/internal/config"
)

type fakeServer struct {
	mu       sync.Mutex
	rcpts    []string
	mailFrom string
	data     string
	authLine string
}

func selfSigned(t *testing.T) (tls.Certificate, *x509.CertPool) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: "mail.test"},
		DNSNames:     []string{"mail.test"},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	pool := x509.NewCertPool()
	pool.AddCert(cert)
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}, pool
}

func (f *fakeServer) serve(conn net.Conn) {
	defer conn.Close()
	r := bufio.NewReader(conn)
	write := func(s string) { _, _ = conn.Write([]byte(s + "\r\n")) }
	write("220 mail.test ESMTP")
	inData := false
	var data strings.Builder
	for {
		line, err := r.ReadString('\n')
		if err != nil {
			return
		}
		line = strings.TrimRight(line, "\r\n")
		if inData {
			if line == "." {
				inData = false
				f.mu.Lock()
				f.data = data.String()
				f.mu.Unlock()
				write("250 queued")
				continue
			}
			data.WriteString(line + "\r\n")
			continue
		}
		upper := strings.ToUpper(line)
		switch {
		case strings.HasPrefix(upper, "EHLO"):
			_, _ = conn.Write([]byte("250-mail.test\r\n250 AUTH PLAIN\r\n"))
		case strings.HasPrefix(upper, "AUTH PLAIN"):
			f.mu.Lock()
			f.authLine = line
			f.mu.Unlock()
			write("235 ok")
		case strings.HasPrefix(upper, "MAIL FROM:"):
			f.mu.Lock()
			f.mailFrom = line
			f.mu.Unlock()
			write("250 ok")
		case strings.HasPrefix(upper, "RCPT TO:"):
			f.mu.Lock()
			f.rcpts = append(f.rcpts, line)
			f.mu.Unlock()
			write("250 ok")
		case upper == "DATA":
			inData = true
			write("354 go")
		case upper == "QUIT":
			write("221 bye")
			return
		default:
			write("250 ok")
		}
	}
}

func TestSendCodeOverImplicitTLS(t *testing.T) {
	cert, pool := selfSigned(t)
	ln, err := tls.Listen("tcp", "127.0.0.1:0", &tls.Config{Certificates: []tls.Certificate{cert}})
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	srv := &fakeServer{}
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go srv.serve(c)
		}
	}()
	_, port, _ := net.SplitHostPort(ln.Addr().String())

	m := NewSMTP(config.SMTP{
		Host: "mail.test", Port: port, Security: "tls",
		Username: "info@edv-kretzer.de", Password: "geheim", From: "info@edv-kretzer.de", FromName: "EDV-Kretzer",
	}, time.Now)
	m.tlsConfig = &tls.Config{RootCAs: pool}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	m.dialHost = "127.0.0.1"
	if err := m.SendCode(ctx, "ich@example.de", "042137", 10*time.Minute); err != nil {
		t.Fatal(err)
	}

	srv.mu.Lock()
	defer srv.mu.Unlock()
	if len(srv.rcpts) != 1 || !strings.Contains(srv.rcpts[0], "<ich@example.de>") {
		t.Fatalf("Empfänger: %v", srv.rcpts)
	}
	if !strings.Contains(srv.mailFrom, "<info@edv-kretzer.de>") {
		t.Fatalf("Absender: %q", srv.mailFrom)
	}
	raw := strings.TrimSpace(strings.TrimPrefix(srv.authLine, "AUTH PLAIN "))
	dec, _ := base64.StdEncoding.DecodeString(raw)
	if string(dec) != "\x00info@edv-kretzer.de\x00geheim" {
		t.Fatalf("Auth: %q", dec)
	}
	_, body, _ := strings.Cut(srv.data, "\r\n\r\n")
	plain, err := base64.StdEncoding.DecodeString(strings.ReplaceAll(strings.TrimSpace(body), "\r\n", ""))
	if err != nil || !strings.Contains(string(plain), "042137") || !strings.Contains(string(plain), "10 Minuten") {
		t.Fatalf("Body: %q (%v)", plain, err)
	}
}

func TestSendCodeRejectsUntrustedCertificate(t *testing.T) {
	cert, _ := selfSigned(t)
	ln, err := tls.Listen("tcp", "127.0.0.1:0", &tls.Config{Certificates: []tls.Certificate{cert}})
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		c, err := ln.Accept()
		if err == nil {
			(&fakeServer{}).serve(c)
		}
	}()
	_, port, _ := net.SplitHostPort(ln.Addr().String())
	m := NewSMTP(config.SMTP{Host: "mail.test", Port: port, Security: "tls", Username: "u", Password: "p", From: "info@edv-kretzer.de", FromName: "x"}, time.Now)
	m.dialHost = "127.0.0.1"
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := m.SendCode(ctx, "ich@example.de", "123456", time.Minute); err == nil {
		t.Fatal("nicht vertrauenswürdiges Zertifikat akzeptiert")
	}
}
