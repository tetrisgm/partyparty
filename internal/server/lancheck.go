package server

import (
	"context"
	"crypto/tls"
	"fmt"
	"net"
	"net/http"
	"time"
)

// lanCheckResult is one LAN self-probe outcome. These probes are PREDICTIVE
// evidence for LAN readiness (a real guest connection is the only proof); they
// feed the console's honest "LAN room ready" vs "this Wi-Fi sends guests to the
// cloud" reporting (execution-plan §5). They must never run in the release gate
// because they depend on live network/TLS behavior.
type lanCheckResult struct {
	OK    bool   `json:"ok"`
	Error string `json:"error,omitempty"`
}

// directListenerTLS dials the current LAN IP + guest port and completes a TLS
// handshake presenting SNI for the machine hostname, with NORMAL certificate
// validation (never InsecureSkipVerify). Success proves the listener, its
// certificate, the port, and the hostname all line up — INDEPENDENT of DNS. A
// failure here means the Mac itself isn't serving a valid cert on that port
// (bad cert / wrong port / local firewall), not a resolver problem.
func directListenerTLS(ctx context.Context, ip string, port int, hostname string) lanCheckResult {
	if ip == "" || port <= 0 || hostname == "" {
		return lanCheckResult{Error: "missing ip/port/hostname"}
	}
	d := &tls.Dialer{
		NetDialer: &net.Dialer{Timeout: 3 * time.Second},
		Config:    &tls.Config{ServerName: hostname}, // normal validation, no skip
	}
	conn, err := d.DialContext(ctx, "tcp", net.JoinHostPort(ip, fmt.Sprintf("%d", port)))
	if err != nil {
		return lanCheckResult{Error: err.Error()}
	}
	_ = conn.Close()
	return lanCheckResult{OK: true}
}

// guestPathTLS requests the machine hostname's /api/lan-health over HTTPS using
// the SYSTEM resolver and NORMAL certificate validation — the exact path a guest
// phone takes on this network. Success proves this network's resolver reaches
// the listener. If directListenerTLS passes but this fails, the network's DNS is
// the blocker (the record is right, the listener is right, but this resolver
// isn't returning the LAN address to clients).
func guestPathTLS(ctx context.Context, hostname string, port int) lanCheckResult {
	if hostname == "" || port <= 0 {
		return lanCheckResult{Error: "missing hostname/port"}
	}
	url := fmt.Sprintf("https://%s:%d/api/lan-health", hostname, port)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return lanCheckResult{Error: err.Error()}
	}
	// Default transport = normal TLS validation via the system resolver.
	client := &http.Client{Timeout: 4 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return lanCheckResult{Error: err.Error()}
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return lanCheckResult{Error: fmt.Sprintf("status %d", resp.StatusCode)}
	}
	return lanCheckResult{OK: true}
}
