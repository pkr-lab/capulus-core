package main

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	leaderboardPageSize   = 10
	maxLeaderboardEntries = 100
)

const maxPointsPerLevel = 104*10 + 4*50 + 4*4*100

var nicknamePattern = regexp.MustCompile(`^[A-Z0-9]{1,16}-[0-9A-F]{4}$`)

type leaderboardEntry struct {
	Nickname string    `json:"nickname"`
	Score    int       `json:"score"`
	Level    int       `json:"level"`
	Date     time.Time `json:"date"`
}

type leaderboardStore struct {
	mu      sync.Mutex
	entries []leaderboardEntry
}

func newLeaderboardStore() *leaderboardStore {
	return &leaderboardStore{}
}

func (s *leaderboardStore) add(e leaderboardEntry) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.entries = append(s.entries, e)
	sort.Slice(s.entries, func(i, j int) bool { return s.entries[i].Score > s.entries[j].Score })
	if len(s.entries) > maxLeaderboardEntries {
		s.entries = s.entries[:maxLeaderboardEntries]
	}
}

func (s *leaderboardStore) top(n int) []leaderboardEntry {
	s.mu.Lock()
	defer s.mu.Unlock()
	if n > len(s.entries) {
		n = len(s.entries)
	}
	out := make([]leaderboardEntry, n)
	copy(out, s.entries[:n])
	return out
}

type leaderboardSubmission struct {
	Nickname string `json:"nickname"`
	Score    int    `json:"score"`
	Level    int    `json:"level"`
}

func handleLeaderboard(logger *slog.Logger, store *leaderboardStore) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(store.top(leaderboardPageSize))

		case http.MethodPost:
			r.Body = http.MaxBytesReader(w, r.Body, 1024)
			var sub leaderboardSubmission
			if err := json.NewDecoder(r.Body).Decode(&sub); err != nil {
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			nickname := strings.ToUpper(strings.TrimSpace(sub.Nickname))
			if !nicknamePattern.MatchString(nickname) {
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			if sub.Level < 1 || sub.Level > 10 || sub.Score < 0 || sub.Score > sub.Level*maxPointsPerLevel {
				logger.Warn("leaderboard: rejected implausible score", "nickname", nickname, "score", sub.Score, "level", sub.Level)
				w.WriteHeader(http.StatusUnprocessableEntity)
				return
			}
			store.add(leaderboardEntry{Nickname: nickname, Score: sub.Score, Level: sub.Level, Date: time.Now().UTC()})
			w.WriteHeader(http.StatusNoContent)

		default:
			w.WriteHeader(http.StatusMethodNotAllowed)
		}
	}
}
