// Package peers discovers PartyParty servers on the local network.
package peers

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/grandcat/zeroconf"
	"partyparty/internal/event"
)

const service = "_partyparty._tcp"

const (
	browseInterval = 5 * time.Second
	browseDuration = 1200 * time.Millisecond
	peerGrace      = 12 * time.Second
)

// Peer is a directly reachable PartyParty DJ on this LAN.
type Peer struct {
	ID            string              `json:"id"`
	Name          string              `json:"name"`
	Bio           string              `json:"bio,omitempty"`
	Avatar        string              `json:"avatar,omitempty"`
	RoomURL       string              `json:"roomUrl"`
	StreamURL     string              `json:"streamUrl,omitempty"`
	Live          bool                `json:"live"`
	Ready         bool                `json:"ready"`
	Generation    int64               `json:"generation,omitempty"`
	LatencyTarget float64             `json:"latencyTarget,omitempty"`
	NowPlaying    *event.CurrentTrack `json:"nowPlaying,omitempty"`
	Links         []event.Link        `json:"links,omitempty"`

	// The party this DJ is in. A Mac going live on a LAN where one is already
	// happening joins it rather than starting a rival: guests scanned one code
	// and believe they are in one place, so the room, the wall and the link
	// are the party's, not the Mac's.
	PartyID    string `json:"partyId,omitempty"`
	PartyName  string `json:"partyName,omitempty"`
	PartyCover string `json:"partyCover,omitempty"`
	PartyJoin  string `json:"partyJoin,omitempty"` // the link every member hands out

	Room *Room `json:"room,omitempty"`
}

// Room is the compact public social snapshot shared between Macs at one venue.
// Audio and media remain served by their owning Mac.
type Room struct {
	Roster []Guest      `json:"roster"`
	Posts  []event.Post `json:"posts"`
	IDs    []string     `json:"ids"`
	Cursor int64        `json:"cursor"`
}

type Guest struct {
	ID     string `json:"id,omitempty"`
	Name   string `json:"name"`
	Emoji  string `json:"emoji"`
	Paused bool   `json:"paused,omitempty"`
	DJID   string `json:"djId,omitempty"`
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
	cancel context.CancelFunc
	client *http.Client

	mu         sync.RWMutex
	candidates map[string]candidate
	peers      map[string]Peer
	peerSeen   map[string]time.Time
	wake       chan struct{}
	revision   uint64
}

// New starts Bonjour advertisement, browsing, and HTTPS reachability probes.
func New(ctx context.Context, selfID, host string, port int) (*Directory, error) {
	if selfID == "" || host == "" || port <= 0 {
		return nil, fmt.Errorf("invalid peer identity")
	}
	ctx, cancel := context.WithCancel(ctx)
	d := &Directory{
		selfID:     selfID,
		cancel:     cancel,
		client:     &http.Client{Timeout: 1500 * time.Millisecond},
		candidates: make(map[string]candidate),
		peers:      make(map[string]Peer),
		peerSeen:   make(map[string]time.Time),
		wake:       make(chan struct{}),
		revision:   newDirectoryRevision(),
	}
	txt := []string{"id=" + selfID, "host=" + host, "port=" + strconv.Itoa(port)}
	server, err := zeroconf.Register("partyparty-"+selfID, service, "local.", port, txt, nil)
	if err != nil {
		cancel()
		return nil, err
	}
	d.server = server

	go d.browseLoop(ctx)
	go d.probeLoop(ctx)
	return d, nil
}

func (d *Directory) browseLoop(ctx context.Context) {
	ticker := time.NewTicker(browseInterval)
	defer ticker.Stop()
	d.browseOnce(ctx)
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			d.browseOnce(ctx)
		}
	}
}

// browseOnce uses macOS DNS-SD, which shares the system Bonjour cache and
// handles interface changes more reliably than a private multicast socket.
func (d *Directory) browseOnce(ctx context.Context) {
	if ctx.Err() != nil {
		return
	}
	services, err := browseServices(int(browseDuration / time.Millisecond))
	if err != nil {
		log.Printf("peer discovery: Bonjour browse failed: %v", err)
		return
	}
	for _, found := range services {
		d.acceptCandidate(found)
	}
}

func (d *Directory) acceptCandidate(found discoveredService) bool {
	id, host, port := found.id, found.host, found.port
	if id == "" || id == d.selfID || host == "" {
		return false
	}
	if port <= 0 {
		return false
	}
	roomURL := fmt.Sprintf("https://%s:%d", host, port)
	d.mu.Lock()
	previous, existed := d.candidates[id]
	d.candidates[id] = candidate{id: id, roomURL: roomURL, seen: time.Now()}
	d.mu.Unlock()
	if !existed || previous.roomURL != roomURL {
		log.Printf("peer discovery: found %s at %s", id, roomURL)
	}
	return true
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
			d.mu.RLock()
			previous := d.peers[c.id]
			d.mu.RUnlock()
			since := int64(0)
			if previous.Room != nil {
				since = previous.Room.Cursor
			}
			req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.roomURL+"/api/peer?since="+strconv.FormatInt(since, 10), nil)
			if err != nil {
				return
			}
			resp, err := d.client.Do(req)
			if err != nil {
				d.markPeerUnavailable(c.id, err.Error())
				return
			}
			defer resp.Body.Close()
			if resp.StatusCode != http.StatusOK {
				d.markPeerUnavailable(c.id, resp.Status)
				return
			}
			var peer Peer
			if json.NewDecoder(resp.Body).Decode(&peer) != nil || peer.ID != c.id {
				d.markPeerUnavailable(c.id, "invalid identity")
				return
			}
			peer.RoomURL = c.roomURL
			if since > 0 && previous.Room != nil && peer.Room != nil {
				peer.Room.Posts = mergePosts(previous.Room.Posts, peer.Room.Posts, peer.Room.IDs)
			}
			d.mu.Lock()
			visibleChanged := !peerVisibleEqual(d.peers[c.id], peer)
			d.peers[c.id] = peer
			if d.peerSeen == nil {
				d.peerSeen = make(map[string]time.Time)
			}
			d.peerSeen[c.id] = time.Now()
			if visibleChanged {
				d.changedLocked()
			}
			d.mu.Unlock()
			if previous.ID == "" {
				log.Printf("peer discovery: connected to %s (%s)", peer.ID, peer.Name)
			}
		}()
	}
	wg.Wait()

	d.mu.Lock()
	for id, c := range d.candidates {
		if now.Sub(c.seen) > 2*time.Minute {
			delete(d.candidates, id)
			_, visible := d.peers[id]
			delete(d.peers, id)
			delete(d.peerSeen, id)
			if visible {
				d.changedLocked()
			}
		}
	}
	d.mu.Unlock()
}

// peerVisibleEqual excludes the accumulated post bodies. A peer response's
// room cursor and ID set already identify visible feed changes, while comparing
// every retained post on every two-second health probe makes steady-state
// discovery cost grow with the whole night's history.
func peerVisibleEqual(a, b Peer) bool {
	if a.Room != nil {
		room := *a.Room
		room.Posts = nil
		a.Room = &room
	}
	if b.Room != nil {
		room := *b.Room
		room.Posts = nil
		b.Room = &room
	}
	return reflect.DeepEqual(a, b)
}

func mergePosts(previous, changed []event.Post, currentIDs []string) []event.Post {
	keep := make(map[string]bool, len(currentIDs))
	for _, id := range currentIDs {
		keep[id] = true
	}
	posts := make(map[string]event.Post, len(previous)+len(changed))
	for _, post := range previous {
		if keep[post.ID] {
			posts[post.ID] = post
		}
	}
	for _, post := range changed {
		posts[post.ID] = post
	}
	out := make([]event.Post, 0, len(posts))
	for _, post := range posts {
		out = append(out, post)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].TS == out[j].TS {
			return out[i].ID < out[j].ID
		}
		return out[i].TS < out[j].TS
	})
	return out
}

func (d *Directory) markPeerUnavailable(id, reason string) {
	d.mu.Lock()
	lastSeen := d.peerSeen[id]
	peer := d.peers[id]
	if peer.ID != "" && !lastSeen.IsZero() && time.Since(lastSeen) >= peerGrace {
		delete(d.peers, id)
		delete(d.peerSeen, id)
		d.changedLocked()
		log.Printf("peer discovery: lost %s: %s", id, reason)
	}
	d.mu.Unlock()
}

// Watch atomically returns the next-change notification and current directory
// revision. Only changes to the public peer snapshot advance it; successful
// identical health probes merely refresh peerSeen and do not wake feed polls.
func (d *Directory) Watch() (<-chan struct{}, uint64) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.ensureWatchLocked()
	return d.wake, d.revision
}

func (d *Directory) changedLocked() {
	d.ensureWatchLocked()
	d.revision++
	close(d.wake)
	d.wake = make(chan struct{})
}

func (d *Directory) ensureWatchLocked() {
	if d.wake == nil {
		d.wake = make(chan struct{})
	}
	if d.revision == 0 {
		d.revision = newDirectoryRevision()
	}
}

func newDirectoryRevision() uint64 {
	return uint64(time.Now().UnixNano()) | 1
}

// Peers returns the currently reachable peer snapshot.
func (d *Directory) Peers() []Peer {
	d.mu.RLock()
	defer d.mu.RUnlock()
	out := make([]Peer, 0, len(d.peers))
	for _, peer := range d.peers {
		out = append(out, clonePeer(peer))
	}
	return out
}

// Peer returns one currently reachable peer.
func (d *Directory) Peer(id string) (Peer, bool) {
	d.mu.RLock()
	defer d.mu.RUnlock()
	peer, ok := d.peers[id]
	if !ok {
		return Peer{}, false
	}
	return clonePeer(peer), true
}

func clonePeer(peer Peer) Peer {
	out := peer
	if peer.NowPlaying != nil {
		nowPlaying := *peer.NowPlaying
		out.NowPlaying = &nowPlaying
	}
	out.Links = append([]event.Link(nil), peer.Links...)
	if peer.Room == nil {
		return out
	}

	room := *peer.Room
	room.Roster = append([]Guest(nil), peer.Room.Roster...)
	room.IDs = append([]string(nil), peer.Room.IDs...)
	room.Posts = make([]event.Post, len(peer.Room.Posts))
	for i, post := range peer.Room.Posts {
		room.Posts[i] = post
		room.Posts[i].Media = append([]event.Media(nil), post.Media...)
		room.Posts[i].Comments = append([]event.Comment(nil), post.Comments...)
		if post.Reactions != nil {
			room.Posts[i].Reactions = make(map[string]int, len(post.Reactions))
			for reaction, count := range post.Reactions {
				room.Posts[i].Reactions[reaction] = count
			}
		}
	}
	out.Room = &room
	return out
}

// Close stops the Bonjour advertisement.
func (d *Directory) Close() {
	if d != nil {
		if d.cancel != nil {
			d.cancel()
		}
		if d.server != nil {
			d.server.Shutdown()
		}
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
