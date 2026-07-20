// Command pp-port443 is a minimal privileged LaunchDaemon (installed via
// SMAppService, runs as root) whose ONLY job is the clean-links redirect:
// forward TCP 443 arriving at this Mac's own LAN addresses to the partyparty
// guest listener on 8443, so guest URLs need no port. Binding 443 directly
// needs root; the app deliberately stays an unprivileged user process, so the
// in-kernel redirect is the entire privileged surface.
//
// Security posture (mirrors pp-port80): it takes NO input — the rule shape is
// compiled in, with only the Mac's OWN interface addresses interpolated — and
// it is not network-facing (it runs pfctl and idles). Rules are scoped per
// interface to traffic addressed TO this Mac, so nothing else's 443 traffic is
// ever touched. lo0 rules cover locally-originated connections to the Mac's own
// LAN address (macOS routes those via loopback), which is what lets the app
// self-verify the redirect before advertising portless URLs. On stop it flushes
// only its own anchor and releases only its own pf enable-reference.
//
// This daemon is OPTIONAL: if the user never approves the background item, the
// app simply keeps advertising :8443. Approving it is a pure upgrade.
package main

import (
	"fmt"
	"log"
	"net"
	"os"
	"os/exec"
	"os/signal"
	"regexp"
	"sort"
	"strings"
	"syscall"
	"time"
)

// Scoped sub-anchor under the "com.apple/*" wildcard that /etc/pf.conf already
// evaluates — distinct from pp-port80's anchor so the two daemons never clobber
// each other's rules.
const anchor = "com.apple/net.ramine.partyparty.443"

const pfctl = "/sbin/pfctl"

func main() {
	log.SetPrefix("pp-port443: ")

	token := ""
	lastRule := ""
	apply := func() {
		rule := buildRule()
		if rule == lastRule {
			return
		}
		if rule == "" {
			log.Printf("pf: no active LAN interfaces; flushing anchor")
			run(pfctl, "-a", anchor, "-F", "all")
			lastRule = ""
			return
		}
		c := exec.Command(pfctl, "-a", anchor, "-f", "-")
		c.Stdin = strings.NewReader(rule)
		if out, err := c.CombinedOutput(); err != nil {
			log.Printf("pf load failed: %v: %s", err, out)
			return
		}
		log.Printf("pf: 443 -> 8443 active:\n%s", strings.TrimSpace(rule))
		lastRule = rule
		if token == "" {
			out, err := run(pfctl, "-E")
			if err != nil {
				log.Printf("pf enable failed: %v: %s", err, out)
			} else if m := regexp.MustCompile(`Token\s*:\s*(\d+)`).FindStringSubmatch(out); len(m) == 2 {
				token = m[1]
			}
		}
	}

	apply()
	tick := time.NewTicker(10 * time.Second) // venue networks change; follow them
	defer tick.Stop()
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGTERM, syscall.SIGINT)
	for {
		select {
		case <-tick.C:
			apply()
		case <-sig:
			run(pfctl, "-a", anchor, "-F", "all")
			if token != "" {
				run(pfctl, "-X", token)
			}
			return
		}
	}
}

// buildRule emits one rdr per active private-IPv4 LAN interface, scoped to
// traffic addressed to that interface's own addresses, plus lo0 rules per LAN
// address so the Mac's own self-test takes the same path guests do.
func buildRule() string {
	ifaces, err := net.Interfaces()
	if err != nil {
		return ""
	}
	var rules []string
	var loRules []string
	for _, in := range ifaces {
		if in.Flags&net.FlagUp == 0 || in.Flags&net.FlagLoopback != 0 {
			continue
		}
		if !strings.HasPrefix(in.Name, "en") && !strings.HasPrefix(in.Name, "bridge") {
			continue
		}
		addrs, err := in.Addrs()
		if err != nil {
			continue
		}
		hasLan := false
		for _, a := range addrs {
			ipn, ok := a.(*net.IPNet)
			if !ok {
				continue
			}
			ip4 := ipn.IP.To4()
			if ip4 == nil || !ip4.IsPrivate() {
				continue
			}
			hasLan = true
			loRules = append(loRules, fmt.Sprintf(
				"rdr pass on lo0 inet proto tcp from any to %s port 443 -> 127.0.0.1 port 8443", ip4))
		}
		if hasLan {
			rules = append(rules, fmt.Sprintf(
				"rdr pass on %s inet proto tcp from any to (%s) port 443 -> 127.0.0.1 port 8443", in.Name, in.Name))
		}
	}
	if len(rules) == 0 {
		return ""
	}
	sort.Strings(rules)
	sort.Strings(loRules)
	return strings.Join(append(rules, loRules...), "\n") + "\n"
}

func run(name string, args ...string) (string, error) {
	out, err := exec.Command(name, args...).CombinedOutput()
	return string(out), err
}
