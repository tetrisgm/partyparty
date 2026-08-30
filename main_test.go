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

func TestHumanizeActivationDoesNotReviveRemovedAccounts(t *testing.T) {
	got := humanizeActivation("account link required: link this Mac")
	want := "the PartyParty setup service needs to refresh this Mac's installation - retrying automatically"
	if got != want {
		t.Fatalf("humanizeActivation = %q, want %q", got, want)
	}
}
