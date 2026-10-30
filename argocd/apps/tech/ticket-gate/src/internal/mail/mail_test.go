package mail

import (
	"strings"
	"testing"
	"time"
)

func TestBuildMessage(t *testing.T) {
	now := time.Date(2026, 10, 30, 12, 0, 0, 0, time.UTC)
	msg, err := BuildMessage("info@edv-kretzer.de", "EDV-Kretzer", "ich@example.de", "042137", 10*time.Minute, now, "abc")
	if err != nil {
		t.Fatal(err)
	}
	s := string(msg)
	for _, want := range []string{
		"From: EDV-Kretzer <info@edv-kretzer.de>\r\n",
		"To: <ich@example.de>\r\n",
		"Subject: =?utf-8?q?Ihr_Best=C3=A4tigungscode?=\r\n",
		"Content-Transfer-Encoding: base64\r\n",
		"Message-ID: <abc@edv-kretzer.de>\r\n",
	} {
		if !strings.Contains(s, want) {
			t.Fatalf("Header fehlt: %q in\n%s", want, s)
		}
	}
	head, _, _ := strings.Cut(s, "\r\n\r\n")
	if strings.Count(head, "\r\n") != 8 {
		t.Fatalf("unerwartete Header-Zeilen:\n%s", head)
	}
}

func TestBuildMessageRejectsHeaderInjection(t *testing.T) {
	now := time.Now()
	for _, to := range []string{"a@example.de\r\nBcc: x@y.de", "a@example.de\nBcc: x@y.de", "a@example.de\x00"} {
		if _, err := BuildMessage("info@edv-kretzer.de", "EDV", to, "123456", time.Minute, now, "id"); err == nil {
			t.Fatalf("Injection nicht erkannt: %q", to)
		}
	}
	if _, err := BuildMessage("info@edv-kretzer.de", "EDV\r\nBcc: x", "a@example.de", "123456", time.Minute, now, "id"); err == nil {
		t.Fatal("Injection im Absendernamen nicht erkannt")
	}
}
