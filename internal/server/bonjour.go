package server

import (
	"context"
	"fmt"
	"net"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"
)

// Bonjour discovery: Apple devices advertise their FRIENDLY name (the one in
// Settings → About → Name, e.g. "Ramine's iPhone" — not the DHCP hostname
// "iphone") over _companion-link._tcp. We browse it, resolve each instance to
// its .local host and then to a LAN IP, and build an IP → friendly-name map the
// roster can use. macOS-only (built-in `dns-sd`, no dependency); best-effort,
// refreshed periodically, and it only ever IMPROVES a name — reverse-DNS and
// the UA label remain the fallbacks.

// StartDiscovery kicks off periodic Bonjour sweeps in the background.
func (s *Srv) StartDiscovery() {
	if _, err := exec.LookPath("dns-sd"); err != nil {
		return // not macOS / unavailable — reverse-DNS + UA label still work
	}
	go func() {
		for {
			s.discoverOnce()
			time.Sleep(45 * time.Second)
		}
	}()
}

func (s *srv) discoverOnce() {
	names := browseInstances("_companion-link._tcp", 3*time.Second)
	if os.Getenv("PP_BONJOUR_DEBUG") == "1" {
		fmt.Fprintf(os.Stderr, "bonjour: browse found %d: %q\n", len(names), names)
	}
	var wg sync.WaitGroup
	for _, name := range names {
		wg.Add(1)
		go func(name string) { // resolve all devices concurrently — a sweep is ~4s, not N×4s
			defer wg.Done()
			host := resolveInstanceHost(name, "_companion-link._tcp", 3*time.Second)
			if host == "" {
				return
			}
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			ips, _ := net.DefaultResolver.LookupHost(ctx, host) // macOS resolves .local via mDNS
			cancel()
			if os.Getenv("PP_BONJOUR_DEBUG") == "1" {
				fmt.Fprintf(os.Stderr, "bonjour: %q -> %s -> %v\n", name, host, ips)
			}
			for _, ip := range ips {
				s.bonjour.Store(ip, name)
			}
		}(name)
	}
	wg.Wait()
}

// browseInstances returns the friendly instance names advertised for svc.
func browseInstances(svc string, d time.Duration) []string {
	ctx, cancel := context.WithTimeout(context.Background(), d)
	defer cancel()
	out, _ := exec.CommandContext(ctx, "dns-sd", "-B", svc, "local.").Output()
	seen := map[string]bool{}
	var names []string
	for _, line := range strings.Split(string(out), "\n") {
		// "<ts> Add <flags> <if> local. <svc>  <Instance Name>"
		if !strings.Contains(line, " Add ") {
			continue
		}
		i := strings.Index(line, svc)
		if i < 0 {
			continue
		}
		// After the service-type column dns-sd prints the instance; trim the
		// leading domain-dot/space ("._companion-link._tcp. <domain> Name").
		name := strings.TrimLeft(strings.TrimSpace(line[i+len(svc):]), ". ")
		if name != "" && !seen[name] {
			seen[name] = true
			names = append(names, name)
		}
	}
	return names
}

// resolveInstanceHost resolves an instance to its .local target host.
func resolveInstanceHost(name, svc string, d time.Duration) string {
	ctx, cancel := context.WithTimeout(context.Background(), d)
	defer cancel()
	out, _ := exec.CommandContext(ctx, "dns-sd", "-L", name, svc, "local.").Output()
	const marker = "can be reached at "
	for _, line := range strings.Split(string(out), "\n") {
		if i := strings.Index(line, marker); i >= 0 {
			fields := strings.Fields(strings.TrimSpace(line[i+len(marker):]))
			if len(fields) == 0 {
				continue // dns-sd killed mid-line at the timeout — truncated output
			}
			host := fields[0] // "iPad-Mini.local.:49294"
			if c := strings.LastIndex(host, ":"); c >= 0 {
				host = host[:c]
			}
			return strings.TrimSuffix(host, ".")
		}
	}
	return ""
}
