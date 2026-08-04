package server

import (
	"context"
	"net"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/grandcat/zeroconf"
)

// Client (AP) isolation is a property of the path BETWEEN devices, so one
// endpoint cannot prove it alone. Reading the neighbour table is not an
// option: macOS strips the link-layer rows from `arp -an` and `netstat -rnl`
// for a sandboxed process (verified in the shipped app - zero rows, no error).
//
// What the sandbox CAN do is Bonjour, which the app already uses for multi-DJ
// discovery. That yields three honest observations, made before any guest
// scans:
//
//	open    - another device on this network advertised a service AND its
//	          advertised TCP port answered us. Peer unicast works.
//	suspect - devices advertise (their multicast reaches us) but none of
//	          their advertised ports answer. Multicast leaks, unicast is
//	          blocked: the isolation signature.
//	quiet   - nothing but ourselves is visible. An empty network and a fully
//	          isolated one look identical from here (verified on a real
//	          isolated network: a phone present in ARP advertised nothing we
//	          could see), so quiet says nothing and the UI stays silent.
//
// The first guest scan remains the guaranteed detector; this only buys the DJ
// an earlier warning on networks that leak multicast.
const (
	isolationOpen    = "open"
	isolationSuspect = "suspect"
	isolationQuiet   = "quiet"

	isolationTTL         = 2 * time.Minute
	isolationBrowseTime  = 2200 * time.Millisecond
	isolationDialTimeout = 300 * time.Millisecond
)

// Common service types real venues actually have: TVs, speakers, printers,
// other computers - plus other PartyParty Macs.
var isolationServiceTypes = []string{
	"_partyparty._tcp",
	"_airplay._tcp", "_raop._tcp", "_googlecast._tcp", "_sonos._tcp",
	"_spotify-connect._tcp", "_ipp._tcp", "_printer._tcp",
	"_ssh._tcp", "_sftp-ssh._tcp", "_smb._tcp", "_rfb._tcp",
	"_http._tcp", "_hap._tcp", "_companion-link._tcp",
}

type isolationVerdict struct {
	State     string `json:"state"`
	Seen      int    `json:"seen"`      // devices visible that are not us and not the gateway
	Reachable int    `json:"reachable"` // of those, how many answered on an advertised port
	CheckedAt int64  `json:"checkedAtMs,omitempty"`
}

type isolationProbe struct {
	mu      sync.Mutex
	last    isolationVerdict
	at      time.Time
	running bool
}

// snapshot returns the cached verdict immediately and refreshes it in the
// background when stale. /api/status is polled; it must never wait on a
// multicast browse.
func (p *isolationProbe) snapshot() *isolationVerdict {
	p.mu.Lock()
	defer p.mu.Unlock()
	if time.Since(p.at) >= isolationTTL && !p.running {
		p.running = true
		go p.refresh()
	}
	if p.last.State == "" {
		return nil // first browse still in flight; say nothing rather than guess
	}
	v := p.last
	return &v
}

func (p *isolationProbe) refresh() {
	v := probeIsolationOnce()
	p.mu.Lock()
	p.last, p.at, p.running = v, time.Now(), false
	p.mu.Unlock()
}

func probeIsolationOnce() isolationVerdict {
	v := isolationVerdict{State: isolationQuiet, CheckedAt: time.Now().UnixMilli()}
	self := localIPSet()
	gw := defaultGateway()

	type candidate struct{ ip, port string }
	byIP := map[string]candidate{}

	ctx, cancel := context.WithTimeout(context.Background(), isolationBrowseTime)
	defer cancel()
	var mu sync.Mutex
	var wg sync.WaitGroup
	for _, service := range isolationServiceTypes {
		resolver, err := zeroconf.NewResolver(nil)
		if err != nil {
			continue
		}
		entries := make(chan *zeroconf.ServiceEntry, 16)
		wg.Add(1)
		go func() {
			defer wg.Done()
			for e := range entries {
				for _, ip := range e.AddrIPv4 {
					s := ip.String()
					if self[s] || s == gw {
						continue
					}
					mu.Lock()
					if _, ok := byIP[s]; !ok && e.Port > 0 {
						byIP[s] = candidate{ip: s, port: strconv.Itoa(e.Port)}
					}
					mu.Unlock()
				}
			}
		}()
		_ = resolver.Browse(ctx, service, "local.", entries)
	}
	<-ctx.Done()
	wg.Wait()

	v.Seen = len(byIP)
	if v.Seen == 0 {
		return v
	}
	// Something else is on this network and talking. Now the question is
	// whether we can talk BACK - dial only the port each device advertised.
	// A refused connection still proves the packet arrived.
	for _, c := range byIP {
		d := net.Dialer{Timeout: isolationDialTimeout}
		conn, err := d.Dial("tcp", net.JoinHostPort(c.ip, c.port))
		if err == nil {
			_ = conn.Close()
			v.Reachable++
			continue
		}
		if strings.Contains(err.Error(), "refused") {
			v.Reachable++
		}
	}
	if v.Reachable > 0 {
		v.State = isolationOpen
	} else {
		v.State = isolationSuspect
	}
	return v
}

func localIPSet() map[string]bool {
	out := map[string]bool{}
	ifaces, err := net.Interfaces()
	if err != nil {
		return out
	}
	for _, ifi := range ifaces {
		addrs, err := ifi.Addrs()
		if err != nil {
			continue
		}
		for _, a := range addrs {
			if ipnet, ok := a.(*net.IPNet); ok {
				out[ipnet.IP.String()] = true
			}
		}
	}
	return out
}

func defaultGateway() string {
	out, err := exec.Command("route", "-n", "get", "default").Output()
	if err != nil {
		return ""
	}
	for _, line := range strings.Split(string(out), "\n") {
		if strings.Contains(line, "gateway:") {
			return strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(line), "gateway:"))
		}
	}
	return ""
}
