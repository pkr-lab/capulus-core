package limiter

import (
	"testing"
	"time"
)

func TestTakeIsAllOrNothing(t *testing.T) {
	now := time.Unix(1000, 0)
	l := New(func() time.Time { return now }, 100)
	a := Rule{Key: "a", Limit: 1, Window: time.Minute}
	b := Rule{Key: "b", Limit: 5, Window: time.Hour}
	if ok, _ := l.Take(a, b); !ok {
		t.Fatal("erste Anfrage abgelehnt")
	}
	if ok, retry := l.Take(a, b); ok || retry <= 0 {
		t.Fatalf("zweite Anfrage erlaubt (%v)", retry)
	}
	for i := 0; i < 4; i++ {
		now = now.Add(61 * time.Second)
		if ok, _ := l.Take(a, b); !ok {
			t.Fatalf("Anfrage %d abgelehnt", i+2)
		}
	}
	now = now.Add(61 * time.Second)
	if ok, _ := l.Take(a, b); ok {
		t.Fatal("Stundenlimit nicht erreicht")
	}
}

func TestKeyCapacity(t *testing.T) {
	l := New(time.Now, 2)
	l.Take(Rule{Key: "1", Limit: 1, Window: time.Hour})
	l.Take(Rule{Key: "2", Limit: 1, Window: time.Hour})
	if ok, _ := l.Take(Rule{Key: "3", Limit: 1, Window: time.Hour}); ok {
		t.Fatal("Kapazität nicht begrenzt")
	}
}
