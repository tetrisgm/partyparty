package cloudsync

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"syscall"
	"testing"
)

// A host with no IPv6 route must still reach the platform. The failure this
// guards against looked like the backend being down: every call returning
// "connect: no route to host" with a v6 address in it, while the LAN party
// worked perfectly (2026-08-11).
func TestPlatformDialFallsBackWhenIPv6IsUnroutable(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer srv.Close()

	real := (&net.Dialer{}).DialContext
	var tried []string
	// Exactly what a v6-only answer produces on a host with no v6 route.
	fake := func(ctx context.Context, network, addr string) (net.Conn, error) {
		tried = append(tried, network)
		if network == "tcp" {
			return nil, &net.OpError{Op: "dial", Net: "tcp",
				Err: os.NewSyscallError("connect", syscall.EHOSTUNREACH)}
		}
		return real(ctx, network, addr)
	}

	tr := http.DefaultTransport.(*http.Transport).Clone()
	tr.DialContext = withIPv4Fallback(fake)
	resp, err := (&http.Client{Transport: tr}).Get(srv.URL + "/")
	if err != nil {
		t.Fatalf("the fallback did not save the request: %v", err)
	}
	defer resp.Body.Close()
	if strings.Join(tried, ",") != "tcp,tcp4" {
		t.Fatalf("expected a tcp attempt then a tcp4 retry; got %v", tried)
	}
}

// A dial that simply works must not be retried.
func TestPlatformDialDoesNotRetryWhenTheFirstAttemptWorks(t *testing.T) {
	var tried []string
	ok := func(ctx context.Context, network, addr string) (net.Conn, error) {
		tried = append(tried, network)
		return nil, nil
	}
	if _, err := withIPv4Fallback(ok)(context.Background(), "tcp", "x:1"); err != nil {
		t.Fatal(err)
	}
	if len(tried) != 1 {
		t.Fatalf("a working dial was retried: %v", tried)
	}
}

// Only routing failures are retried. A server that refuses the connection is
// answering, and hammering it again over a narrower network hides the truth.
func TestUnreachableOnlyMatchesRoutingFailures(t *testing.T) {
	host := &net.OpError{Err: os.NewSyscallError("connect", syscall.EHOSTUNREACH)}
	netun := &net.OpError{Err: os.NewSyscallError("connect", syscall.ENETUNREACH)}
	refused := &net.OpError{Err: os.NewSyscallError("connect", syscall.ECONNREFUSED)}
	if !unreachable(host) || !unreachable(netun) {
		t.Fatal("routing failures must be retryable")
	}
	if unreachable(refused) || unreachable(errors.New("plain")) {
		t.Fatal("a refusal or a plain error must not trigger the v4 retry")
	}
}
