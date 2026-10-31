package zammad

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"ticket-gate/internal/config"
)

func TestCreateSendsVerifiedCustomer(t *testing.T) {
	var got map[string]any
	var auth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth = r.Header.Get("Authorization")
		_ = json.NewDecoder(r.Body).Decode(&got)
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"id":7,"number":"10007"}`))
	}))
	defer srv.Close()

	c := New(config.Zammad{URL: srv.URL, Token: "geheim", Group: "Users", Tag: "HomePage"})
	number, err := c.Create(context.Background(), Ticket{Email: "ich@example.de", Name: "Max", Subject: "Hallo", Message: "Text"})
	if err != nil || number != "10007" {
		t.Fatalf("%q %v", number, err)
	}
	if auth != "Token token=geheim" || got["customer_id"] != "guess:ich@example.de" || got["group"] != "Users" || got["tags"] != "HomePage" {
		t.Fatalf("Request: %v %v", auth, got)
	}
}

func TestCreateFailsOnErrorStatus(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer srv.Close()
	c := New(config.Zammad{URL: srv.URL, Token: "x", Group: "Users"})
	if _, err := c.Create(context.Background(), Ticket{Email: "a@example.de", Subject: "s", Message: "m"}); err == nil {
		t.Fatal("Fehlerstatus nicht gemeldet")
	}
}
