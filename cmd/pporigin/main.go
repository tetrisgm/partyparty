// Command pporigin is the relay origin: it accepts a DJ Mac's pushed LL-HLS and
// serves it to guests.
//
// It is deliberately a plain HTTP service with no database and no disk state, so
// it runs behind an ordinary reverse proxy beside other services rather than
// needing a box of its own. Everything it holds is one party's live window, in
// memory, dropped when the party goes quiet.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"

	"partyparty/internal/origin"
)

func main() {
	addr := flag.String("addr", ":8080", "listen address (TLS is terminated by the reverse proxy in front)")
	baseDomain := flag.String("base-domain", "", "serve each room at <token>.<base-domain>; empty uses /r/<token>/ paths")
	roomsFile := flag.String("rooms", "", "JSON file of {\"room\":\"publish-token\"}; reloaded on SIGHUP")
	certFile := flag.String("cert", "", "TLS certificate chain; enables HTTPS when set")
	keyFile := flag.String("key", "", "TLS private key")
	flag.Parse()

	rooms := newRoomTokens(*roomsFile)
	if err := rooms.load(); err != nil {
		log.Fatalf("origin: cannot read rooms file: %v", err)
	}

	store := origin.NewStore()
	handler := origin.NewHandler(origin.Config{
		Tokens:     rooms.lookup,
		BaseDomain: *baseDomain,
		Logf:       log.Printf,
	}, store)

	stop := make(chan struct{})
	go origin.Sweeper(store, 30*time.Second, log.Printf, stop)

	server := &http.Server{
		Addr:    *addr,
		Handler: handler,
		// Generous read/write bounds: a blocking playlist reload is SUPPOSED to
		// sit open, so a tight write timeout would break low-latency playback.
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	// Reload credentials without dropping a live party.
	hup := make(chan os.Signal, 1)
	signal.Notify(hup, syscall.SIGHUP)
	go func() {
		for range hup {
			if err := rooms.load(); err != nil {
				log.Printf("origin: rooms reload failed, keeping previous: %v", err)
				continue
			}
			log.Printf("origin: rooms reloaded")
		}
	}()

	shutdown := make(chan os.Signal, 1)
	signal.Notify(shutdown, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-shutdown
		close(stop)
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = server.Shutdown(ctx)
	}()

	if *certFile != "" && *keyFile != "" {
		keeper, err := newCertKeeper(*certFile, *keyFile)
		if err != nil {
			log.Fatalf("origin: cannot load certificate: %v", err)
		}
		server.TLSConfig = tlsConfig(keeper)
		log.Printf("origin: listening on %s (https)", *addr)
		if err := server.ListenAndServeTLS("", ""); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("origin: %v", err)
		}
		return
	}

	log.Printf("origin: listening on %s (http; put TLS in front)", *addr)
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatalf("origin: %v", err)
	}
}

// roomTokens maps a room to the credential its Mac publishes with. A reload
// swaps the whole map under a write lock, so a live party is never served a
// half-updated credential set.
type roomTokens struct {
	path string

	mu      sync.RWMutex
	current map[string]string
}

func newRoomTokens(path string) *roomTokens {
	return &roomTokens{path: path, current: map[string]string{}}
}

func (r *roomTokens) load() error {
	next := map[string]string{}
	if strings.TrimSpace(r.path) != "" {
		data, err := os.ReadFile(r.path)
		if err != nil {
			return err
		}
		if err := json.Unmarshal(data, &next); err != nil {
			return err
		}
	}
	// No rooms file means nobody may publish. Failing closed is correct: an
	// origin that accepted anonymous publishes would let anyone hijack a party.
	r.mu.Lock()
	r.current = next
	r.mu.Unlock()
	return nil
}

func (r *roomTokens) lookup(room string) (string, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	token, ok := r.current[room]
	return token, ok
}
