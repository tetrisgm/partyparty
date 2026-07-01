// Command pp-port80 is a minimal privileged LaunchDaemon (installed via
// SMAppService, runs as root) whose ONLY job is to redirect inbound TCP :80 to
// the unprivileged partyparty server on :8000 via a scoped pf anchor.
//
// Security posture: it takes NO input (the rule is compiled in — no args, no
// IPC, no injection surface) and is NOT network-facing (it runs pfctl and idles).
// The LAN-facing web server stays unprivileged on :8000; only the in-kernel
// redirect is privileged. On stop (SIGTERM from launchd unregister) it flushes
// only its own anchor and releases only its own pf enable-reference.
package main

import (
	"log"
	"os"
	"os/exec"
	"os/signal"
	"regexp"
	"strings"
	"syscall"
)

// Scoped sub-anchor under the "com.apple/*" wildcard that /etc/pf.conf already
// evaluates — so the rule takes effect without ever editing the system ruleset.
const anchor = "com.apple/net.ramine.partyparty"

const rule = "rdr pass inet proto tcp from any to any port 80 -> 127.0.0.1 port 8000\n"

const pfctl = "/sbin/pfctl"

func main() {
	log.SetPrefix("pp-port80: ")
	token := loadRule()

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGTERM, syscall.SIGINT)
	<-sig
	teardown(token)
}

// loadRule installs the rdr rule into our anchor and reference-count-enables pf,
// returning the enable token to release later. Never uses bare -e / -f pf.conf
// (which would clobber Internet Sharing / VPNs / other pf users).
func loadRule() string {
	c := exec.Command(pfctl, "-a", anchor, "-f", "-")
	c.Stdin = strings.NewReader(rule)
	if out, err := c.CombinedOutput(); err != nil {
		log.Printf("load anchor failed: %v: %s", err, out)
	}
	out, err := exec.Command(pfctl, "-E").CombinedOutput()
	if err != nil {
		log.Printf("pf enable failed: %v: %s", err, out)
	}
	if m := regexp.MustCompile(`Token\s*:\s*(\d+)`).FindStringSubmatch(string(out)); len(m) == 2 {
		return m[1]
	}
	return ""
}

func teardown(token string) {
	if out, err := exec.Command(pfctl, "-a", anchor, "-F", "all").CombinedOutput(); err != nil {
		log.Printf("flush anchor failed: %v: %s", err, out)
	}
	if token != "" {
		if out, err := exec.Command(pfctl, "-X", token).CombinedOutput(); err != nil {
			log.Printf("pf disable-ref failed: %v: %s", err, out)
		}
	}
}
