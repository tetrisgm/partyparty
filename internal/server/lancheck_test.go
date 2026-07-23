package server

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
)

// The critical safety property: the self-checks use NORMAL certificate
// validation and fail closed. An httptest TLS server presents a self-signed cert
// for a different name, so both probes must reject it — proving we never smuggled
// in InsecureSkipVerify (which would make a stale IP owned by a stranger's device
// look "reachable").
func TestLanChecksFailClosedOnUntrustedCert(t *testing.T) {
	ts := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer ts.Close()

	host, portStr, err := net.SplitHostPort(ts.Listener.Addr().String())
	if err != nil {
		t.Fatalf("split addr: %v", err)
	}
	port, _ := strconv.Atoi(portStr)
	const machineHost = "seth-live.party.partyparty.party"

	if res := directListenerTLS(context.Background(), host, port, machineHost); res.OK {
		t.Error("directListenerTLS accepted a self-signed/mismatched cert — must fail closed")
	}
	if res := guestPathTLS(context.Background(), machineHost, port); res.OK {
		t.Error("guestPathTLS accepted an unresolvable/untrusted host — must fail closed")
	}
}

// Bad inputs are rejected without a dial.
func TestLanChecksRejectEmptyInputs(t *testing.T) {
	if directListenerTLS(context.Background(), "", 0, "").OK {
		t.Error("directListenerTLS(empty) = OK, want failure")
	}
	if guestPathTLS(context.Background(), "", 0).OK {
		t.Error("guestPathTLS(empty) = OK, want failure")
	}
}
