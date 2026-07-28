package stats

import (
	"sort"
	"sync"
	"time"
)

// Listeners counts active listeners and gauges health from heartbeats sent by
// the player page (works the same whether media is served by us or MediaMTX).
type client struct {
	firstSeen time.Time // for stable roster ordering
	lastSeen  time.Time
	lastStall time.Time
	lat       float64 // last reported latency behind live, ms
	hasLat    bool
	paused    bool
	platform  string // "native" (iOS Safari) or "hls" (Android/desktop)

	// Controller debug telemetry: playback rate and buffered seconds ahead.
	rate float64
	bufS float64

	// Party identity is guest-chosen. Device/IP stay separate and are exposed
	// only to the DJ's details view.
	ip     string
	device string // friendly device label derived from the User-Agent
	name   string
	emoji  string
}

type Listeners struct {
	window  time.Duration
	mu      sync.Mutex
	clients map[string]*client
	ever    map[string]struct{}
}

func New(window time.Duration) *Listeners {
	return &Listeners{
		window:  window,
		clients: make(map[string]*client),
		ever:    make(map[string]struct{}),
	}
}

// Heartbeat records that a client (keyed by a stable per-device id, or IP when
// absent) is actively playing. stalled=true means its player reported a
// buffer/stall since the last beat; latMs (when hasLat) is its measured latency
// behind live; platform is "native" or "hls".
func (l *Listeners) Heartbeat(key string, stalled, paused bool, latMs float64, hasLat bool, platform string) {
	if key == "" {
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	c := l.clients[key]
	if c == nil {
		c = &client{firstSeen: now}
		l.clients[key] = c
		l.ever[key] = struct{}{}
	}
	c.lastSeen = now
	c.paused = paused
	if stalled {
		c.lastStall = now
	}
	// Authoritative each beat: a device that stops reporting a valid latency
	// (reconnect, getStartDate going Invalid) drops out of the spread instead of
	// freezing a stale value — so the metric tells the truth during trouble.
	c.hasLat = hasLat
	if hasLat {
		c.lat = latMs
	}
	if platform != "" {
		c.platform = platform
	}
}

// Debug records the controller telemetry a guest reports with each heartbeat.
func (l *Listeners) Debug(key string, rate, bufS float64) {
	if key == "" {
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if c := l.clients[key]; c != nil {
		c.rate = rate
		c.bufS = bufS
	}
}

// Meta records network/device information for the DJ-only details view.
func (l *Listeners) Meta(key, ip, device string) {
	if key == "" {
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if c := l.clients[key]; c != nil {
		if ip != "" {
			c.ip = ip
		}
		if device != "" {
			c.device = device
		}
	}
}

// Identity records the guest-selected display name and emoji.
func (l *Listeners) Identity(key, name, emoji string) {
	if key == "" {
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if c := l.clients[key]; c != nil {
		c.name = name
		c.emoji = emoji
	}
}

func (l *Listeners) TotalUnique() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.ever)
}

// Active returns the number of listeners that have heartbeated within the
// active window, pruning expired clients the same way Health does.
func (l *Listeners) Active() int {
	now := time.Now()
	l.mu.Lock()
	defer l.mu.Unlock()
	active := 0
	for ip, c := range l.clients {
		if now.Sub(c.lastSeen) > l.window {
			delete(l.clients, ip)
			continue
		}
		active++
	}
	return active
}

type Health struct {
	Status     string  `json:"status"` // good | strain | congested | idle
	Listeners  int     `json:"listeners"`
	Struggling int     `json:"struggling"`
	Mbps       float64 `json:"mbps"`
	Suggestion string  `json:"suggestion,omitempty"`
}

func (l *Listeners) Health(live bool, bitrateKbps int) Health {
	now := time.Now()
	l.mu.Lock()
	defer l.mu.Unlock()

	active, struggling := 0, 0
	for ip, c := range l.clients {
		if now.Sub(c.lastSeen) > l.window {
			delete(l.clients, ip)
			continue
		}
		active++
		if !c.lastStall.IsZero() && now.Sub(c.lastStall) < 12*time.Second {
			struggling++
		}
	}

	h := Health{Listeners: active, Struggling: struggling}
	h.Mbps = float64(bitrateKbps*active) / 1000.0
	switch {
	case !live || active == 0:
		h.Status = "idle"
	case struggling == 0:
		h.Status = "good"
	case struggling*2 < active:
		h.Status = "strain"
	default:
		h.Status = "congested"
	}
	return h
}

// LatencyStat summarizes the inter-listener latency spread from heartbeats —
// the 10/10 metric: how close together the dancers hear the music.
type LatencyStat struct {
	Count    int     `json:"count"`
	MinMs    float64 `json:"minMs"`
	MedMs    float64 `json:"medMs"`
	MaxMs    float64 `json:"maxMs"`
	SpreadMs float64 `json:"spreadMs"`
}

// LatencySpread returns min/median/max/spread over active listeners that have
// reported a latency measurement.
func (l *Listeners) LatencySpread() LatencyStat {
	now := time.Now()
	l.mu.Lock()
	defer l.mu.Unlock()
	var v []float64
	for _, c := range l.clients {
		if now.Sub(c.lastSeen) > l.window || !c.hasLat {
			continue
		}
		v = append(v, c.lat)
	}
	if len(v) == 0 {
		return LatencyStat{}
	}
	sort.Float64s(v)
	med := v[len(v)/2]
	if len(v)%2 == 0 {
		med = (v[len(v)/2-1] + v[len(v)/2]) / 2
	}
	return LatencyStat{Count: len(v), MinMs: v[0], MedMs: med, MaxMs: v[len(v)-1], SpreadMs: v[len(v)-1] - v[0]}
}

// Listener is one active listener for the DJ's roster.
type Listener struct {
	ID         string  `json:"-"`
	Platform   string  `json:"platform"` // "native" | "hls"
	Name       string  `json:"name,omitempty"`
	Emoji      string  `json:"emoji,omitempty"`
	Device     string  `json:"device,omitempty"`
	IP         string  `json:"ip,omitempty"`
	LatencyMs  float64 `json:"latencyMs"`
	HasLatency bool    `json:"hasLatency"`
	Rate       float64 `json:"rate,omitempty"`
	BufS       float64 `json:"bufS,omitempty"`
	Stalled    bool    `json:"stalled"`
	Paused     bool    `json:"paused"`
}

// Roster returns the currently-active listeners, stable-ordered by join time.
func (l *Listeners) Roster() []Listener {
	now := time.Now()
	l.mu.Lock()
	defer l.mu.Unlock()
	type keyedClient struct {
		key string
		c   *client
	}
	active := make([]keyedClient, 0, len(l.clients))
	for key, c := range l.clients {
		if now.Sub(c.lastSeen) <= l.window {
			active = append(active, keyedClient{key: key, c: c})
		}
	}
	sort.Slice(active, func(i, j int) bool { return active[i].c.firstSeen.Before(active[j].c.firstSeen) })
	out := make([]Listener, 0, len(active))
	for _, activeClient := range active {
		key, c := activeClient.key, activeClient.c
		out = append(out, Listener{
			ID:         key,
			Platform:   c.platform,
			Name:       c.name,
			Emoji:      c.emoji,
			Device:     c.device,
			IP:         c.ip,
			LatencyMs:  c.lat,
			HasLatency: c.hasLat,
			Rate:       c.rate,
			BufS:       c.bufS,
			Stalled:    !c.lastStall.IsZero() && now.Sub(c.lastStall) < 12*time.Second,
			Paused:     c.paused,
		})
	}
	return out
}
