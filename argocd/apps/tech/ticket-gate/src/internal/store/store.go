package store

import (
	"errors"
	"sync"
	"time"
)

var ErrFull = errors.New("store full")

type CodeRecord struct {
	Email     string
	Hash      []byte
	ExpiresAt time.Time
	Attempts  int
}

type TokenRecord struct {
	SessionID string
	Email     string
	ExpiresAt time.Time
}

type AttemptStatus int

const (
	AttemptOK AttemptStatus = iota
	AttemptNoCode
	AttemptExpired
	AttemptInvalid
	AttemptLocked
)

type AttemptResult struct {
	Status       AttemptStatus
	Email        string
	AttemptsLeft int
}

type Store struct {
	mu          sync.Mutex
	now         func() time.Time
	maxSessions int
	sessions    map[string]time.Time
	codes       map[string]CodeRecord
	tokens      map[string]TokenRecord
	tokenBySess map[string]string
}

func New(now func() time.Time, maxSessions int) *Store {
	return &Store{
		now:         now,
		maxSessions: maxSessions,
		sessions:    make(map[string]time.Time),
		codes:       make(map[string]CodeRecord),
		tokens:      make(map[string]TokenRecord),
		tokenBySess: make(map[string]string),
	}
}

func (s *Store) CreateSession(id string, ttl time.Duration) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.sessions) >= s.maxSessions {
		return ErrFull
	}
	s.sessions[id] = s.now().Add(ttl)
	return nil
}

func (s *Store) SessionValid(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	exp, ok := s.sessions[id]
	if !ok {
		return false
	}
	if !s.now().Before(exp) {
		s.dropSession(id)
		return false
	}
	return true
}

func (s *Store) PutCode(sessionID string, rec CodeRecord) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.codes[sessionID] = rec
}

func (s *Store) Attempt(sessionID string, maxAttempts int, verify func(CodeRecord) bool) AttemptResult {
	s.mu.Lock()
	defer s.mu.Unlock()
	rec, ok := s.codes[sessionID]
	if !ok {
		return AttemptResult{Status: AttemptNoCode}
	}
	if !s.now().Before(rec.ExpiresAt) {
		delete(s.codes, sessionID)
		return AttemptResult{Status: AttemptExpired}
	}
	rec.Attempts++
	if verify(rec) {
		delete(s.codes, sessionID)
		return AttemptResult{Status: AttemptOK, Email: rec.Email}
	}
	if rec.Attempts >= maxAttempts {
		delete(s.codes, sessionID)
		return AttemptResult{Status: AttemptLocked}
	}
	s.codes[sessionID] = rec
	return AttemptResult{Status: AttemptInvalid, AttemptsLeft: maxAttempts - rec.Attempts}
}

func (s *Store) PutToken(hash string, rec TokenRecord) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if old, ok := s.tokenBySess[rec.SessionID]; ok {
		delete(s.tokens, old)
	}
	s.tokens[hash] = rec
	s.tokenBySess[rec.SessionID] = hash
}

func (s *Store) ConsumeToken(hash, sessionID string) (TokenRecord, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	rec, ok := s.tokens[hash]
	if !ok {
		return TokenRecord{}, false
	}
	if !s.now().Before(rec.ExpiresAt) {
		s.dropToken(hash, rec)
		return TokenRecord{}, false
	}
	if rec.SessionID != sessionID {
		return TokenRecord{}, false
	}
	s.dropToken(hash, rec)
	return rec, true
}

func (s *Store) Purge() {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	for id, exp := range s.sessions {
		if !now.Before(exp) {
			s.dropSession(id)
		}
	}
	for id, rec := range s.codes {
		if !now.Before(rec.ExpiresAt) {
			delete(s.codes, id)
		}
	}
	for h, rec := range s.tokens {
		if !now.Before(rec.ExpiresAt) {
			s.dropToken(h, rec)
		}
	}
}

func (s *Store) Counts() (sessions, codes, tokens int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.sessions), len(s.codes), len(s.tokens)
}

func (s *Store) Codes() []CodeRecord {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]CodeRecord, 0, len(s.codes))
	for _, rec := range s.codes {
		out = append(out, rec)
	}
	return out
}

func (s *Store) dropSession(id string) {
	delete(s.sessions, id)
	delete(s.codes, id)
	if h, ok := s.tokenBySess[id]; ok {
		delete(s.tokens, h)
		delete(s.tokenBySess, id)
	}
}

func (s *Store) dropToken(hash string, rec TokenRecord) {
	delete(s.tokens, hash)
	if s.tokenBySess[rec.SessionID] == hash {
		delete(s.tokenBySess, rec.SessionID)
	}
}
