// Package peers discovers PartyParty servers on the local network.
package peers

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/grandcat/zeroconf"
)

const service = "_partyparty._tcp"

// Peer is a directly reachable PartyParty DJ on this LAN.
type Peer struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	RoomURL   string `json:"roomUrl"`
	StreamURL string `json:"streamUrl,omitempty"`
	Live      bool   `json:"live"`
	Ready     bool   `json:"ready"`
}

type candidate struct {
	id      string
	roomURL string
	seen    time.Time
}

// Directory advertises this Mac and maintains a verified list of other Macs.
type Directory struct {
	selfID string
	server *zeroconf.Server
	client *http.Client

	mu         sync.RWMutex
	candidates map[string]candidate
	peers      map[string]Peer
}

// New starts Bonjour advertisement, browsing, and HTTPS reachability probes.
func New(ctx context.Context, selfID, host string, port int) (*Directory, error) {
	if selfID == "" || host == "" || port <= 0 {
		return nil, fmt.Errorf("invalid peer identity")
	}
	d := &Directory{
		selfID:     selfID,
		client:     &http.Client{Timeout: 1500 * time.Millisecond},
		candidates: make(map[string]candidate),
		peers:      make(map[string]Peer),
	}
	txt := []string{"id=" + selfID, "host=" + host, "port=" + strconv.Itoa(port)}
	server, err := zeroconf.Register("partyparty-"+selfID, service, "local.", port, txt, nil)
	if err != nil {
		return nil, err
	}
	d.server = server

	entries := make(chan *zeroconf.ServiceEntry)
	resolver, err := zeroconf.NewResolver(nil)
	if err != nil {
		server.Shutdown()
		return nil, err
	}
	go d.consume(ctx, entries)
	go func() {
		if err := resolver.Browse(ctx, service, "local.", entries); err != nil {
			return
		}
	}()
	go d.probeLoop(ctx)
	return d, nil
}

func (d *Directory) consume(ctx context.Context, entries <-chan *zeroconf.ServiceEntry) {
	for {
		select {
		case <-ctx.Done():
			return
		case entry, ok := <-entries:
			if !ok {
				return
			}
			values := txtValues(entry.Text)
			id, host := values["id"], values["host"]
			if id == "" || id == d.selfID || host == "" {
				continue
			}
			port := entry.Port
			if p, err := strconv.Atoi(values["port"]); err == nil && p > 0 {
				port = p
			}
			d.mu.Lock()
			d.candidates[id] = candidate{
				id:      id,
				roomURL: fmt.Sprintf("https://%s:%d", host, port),
				seen:    time.Now(),
			}
			d.mu.Unlock()
		}
	}
}

func (d *Directory) probeLoop(ctx context.Context) {
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	d.probe(ctx)
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			d.probe(ctx)
		}
	}
}

func (d *Directory) probe(ctx context.Context) {
	d.mu.RLock()
	candidates := make([]candidate, 0, len(d.candidates))
	for _, c := range d.candidates {
		candidates = append(candidates, c)
	}
	d.mu.RUnlock()

	now := time.Now()
	var wg sync.WaitGroup
	for _, c := range candidates {
		c := c
		wg.Add(1)
		go func() {
			defer wg.Done()
			req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.roomURL+"/api/peer", nil)
			if err != nil {
				return
			}
			resp, err := d.client.Do(req)
			if err != nil {
				d.removePeer(c.id)
				return
			}
			defer resp.Body.Close()
			if resp.StatusCode != http.StatusOK {
				d.removePeer(c.id)
				return
			}
			var peer Peer
			if json.NewDecoder(resp.Body).Decode(&peer) != nil || peer.ID != c.id {
				d.removePeer(c.id)
				return
			}
			peer.RoomURL = c.roomURL
			d.mu.Lock()
			d.peers[c.id] = peer
			d.mu.Unlock()
		}()
	}
	wg.Wait()

	d.mu.Lock()
	for id, c := range d.candidates {
		if now.Sub(c.seen) > 2*time.Minute {
			delete(d.candidates, id)
			delete(d.peers, id)
		}
	}
	d.mu.Unlock()
}

func (d *Directory) removePeer(id string) {
	d.mu.Lock()
	delete(d.peers, id)
	d.mu.Unlock()
}

// Peers returns the currently reachable peer snapshot.
func (d *Directory) Peers() []Peer {
	d.mu.RLock()
	defer d.mu.RUnlock()
	out := make([]Peer, 0, len(d.peers))
	for _, peer := range d.peers {
		out = append(out, peer)
	}
	return out
}

// Close stops the Bonjour advertisement.
func (d *Directory) Close() {
	if d != nil && d.server != nil {
		d.server.Shutdown()
	}
}

func txtValues(txt []string) map[string]string {
	out := make(map[string]string, len(txt))
	for _, field := range txt {
		key, value, ok := strings.Cut(field, "=")
		if ok {
			out[key] = value
		}
	}
	return out
}
