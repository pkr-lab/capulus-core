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

func TestBuildRelayMessageMultipart(t *testing.T) {
	now := time.Date(2026, 10, 30, 12, 0, 0, 0, time.UTC)
	msg, err := BuildRelayMessage("info@edv-kretzer.de", "Plaudi", Message{To: "ich@example.de", Subject: "Dein Plaudi-Code: 123456", Text: "Code 123456", HTML: "<p>Code 123456</p>"}, now, "abc")
	if err != nil {
		t.Fatal(err)
	}
	s := string(msg)
	for _, want := range []string{
		"From: Plaudi <info@edv-kretzer.de>\r\n",
		"To: <ich@example.de>\r\n",
		"Content-Type: multipart/alternative; boundary=\"=_abc\"\r\n",
		"--=_abc\r\nContent-Type: text/plain; charset=utf-8\r\n",
		"--=_abc\r\nContent-Type: text/html; charset=utf-8\r\n",
		"--=_abc--\r\n",
	} {
		if !strings.Contains(s, want) {
			t.Fatalf("fehlt: %q in\n%s", want, s)
		}
	}
	if strings.Contains(s, "Code 123456") {
		t.Fatal("Inhalt muss base64-kodiert sein")
	}
}

func TestBuildRelayMessagePlainWithoutHTML(t *testing.T) {
	msg, err := BuildRelayMessage("info@edv-kretzer.de", "Plaudi", Message{To: "ich@example.de", Subject: "x", Text: "nur Text"}, time.Now(), "abc")
	if err != nil {
		t.Fatal(err)
	}
	if s := string(msg); strings.Contains(s, "multipart") || !strings.Contains(s, "Content-Type: text/plain; charset=utf-8\r\n") {
		t.Fatalf("unerwarteter Aufbau:\n%s", s)
	}
}

func TestBuildRelayMessageRejectsHeaderInjection(t *testing.T) {
	now := time.Now()
	bad := []Message{
		{To: "a@example.de\r\nBcc: x@y.de", Subject: "x", Text: "y"},
		{To: "a@example.de", Subject: "x\r\nBcc: x@y.de", Text: "y"},
	}
	for _, m := range bad {
		if _, err := BuildRelayMessage("info@edv-kretzer.de", "Plaudi", m, now, "id"); err == nil {
			t.Fatalf("Injection nicht erkannt: %+v", m)
		}
	}
	if _, err := BuildRelayMessage("info@edv-kretzer.de", "Plaudi\r\nBcc: x", Message{To: "a@example.de", Subject: "x", Text: "y"}, now, "id"); err == nil {
		t.Fatal("Injection im Absendernamen nicht erkannt")
	}
}
