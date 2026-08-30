package main

import (
	"net/http"
	"testing"
	"time"
)

func TestPartyHTTPServerBoundsIdleClients(t *testing.T) {
	handler := http.HandlerFunc(func(http.ResponseWriter, *http.Request) {})
	server := partyHTTPServer(handler)
	if server.Handler == nil {
		t.Fatal("server lost its handler")
	}
	if server.ReadHeaderTimeout != 10*time.Second {
		t.Fatalf("read header timeout = %s", server.ReadHeaderTimeout)
	}
	if server.IdleTimeout != 120*time.Second {
		t.Fatalf("idle timeout = %s", server.IdleTimeout)
	}
	if server.WriteTimeout != 0 {
		t.Fatalf("write timeout = %s; long polls and media responses must remain unbounded", server.WriteTimeout)
	}
}
