package contribute

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"
)

// The room API plane's Mac side.
//
// Audio is only part of a relayed party. Guests also read status, read the feed,
// and post. Proxying each of those back to the laptop is the placement mistake
// this whole redesign removes, so instead the Mac PUBLISHES room state to the
// origin and DRAINS one digest from it.
//
// The exchange is what makes attendance free for the Mac: 500 guests polling
// status cost one publish rather than 500 requests, and 500 heartbeats arrive as
// a single digest. The Mac's inbound rate is set by how often it drains, not by
// how many people came.

var errNoOrigin = errors.New("no relay origin yet")

const (
	// planeInterval is one publish-and-drain cycle. Guests poll status every few
	// seconds, so a snapshot at this cadence is never meaningfully stale, and it
	// bounds how long a guest's post waits before the Mac sees it.
	planeInterval = time.Second

	maxDigestBytes = 4 << 20
)

// PlaneHooks connects the plane to the room the Mac is actually running.
type PlaneHooks struct {
	// Snapshots returns the room state to publish, keyed by the endpoint a guest
	// reads (for example "status" and "feed"). Called every cycle.
	Snapshots func() map[string]json.RawMessage

	// DelaySec is the room's declared schedule, published alongside so the origin
	// can report deviation. Telemetry only; nothing feeds it back.
	DelaySec func() float64

	// ApplyWrite receives one guest action that arrived at the origin. Errors are
	// the caller's business; a write that cannot be applied is dropped rather
	// than retried forever, because a live party cares about now.
	ApplyWrite func(path string, body json.RawMessage)

	// Presence reports the aggregated listener count and spread, so the DJ
	// console can show a relayed room honestly.
	Presence func(Presence)
}

type GuestPresence struct {
	ID     string `json:"id"`
	Name   string `json:"name,omitempty"`
	Emoji  string `json:"emoji,omitempty"`
	DJID   string `json:"djId,omitempty"`
	Paused bool   `json:"paused,omitempty"`
}

type Presence struct {
	Listeners int
	SpreadMs  float64
	Roster    []GuestPresence
}

// digest mirrors roomplane.Digest without importing it, so the origin's wire
// format is the contract rather than a shared struct that invites coupling.
type digest struct {
	Listeners int             `json:"listeners"`
	SpreadMs  float64         `json:"spreadMs"`
	Roster    []GuestPresence `json:"roster,omitempty"`
	Writes    []struct {
		Path string          `json:"path"`
		Body json.RawMessage `json:"body"`
	} `json:"writes"`
}

// RunPlane publishes room state and drains guest activity until ctx ends. It
// only does anything while contribution is enabled, so a direct or local party
// never talks to the origin at all.
func (m *Manager) RunPlane(ctx context.Context, hooks PlaneHooks) {
	if hooks.Snapshots == nil {
		return
	}
	for {
		if ctx.Err() != nil {
			return
		}
		if m.isEnabled() {
			m.planeCycle(ctx, hooks)
		}
		if !m.wait(ctx, planeInterval) {
			return
		}
	}
}

func (m *Manager) planeCycle(ctx context.Context, hooks PlaneHooks) {
	delay := 0.0
	if hooks.DelaySec != nil {
		delay = hooks.DelaySec()
	}
	for kind, body := range hooks.Snapshots() {
		if len(body) == 0 || !json.Valid(body) {
			continue
		}
		if err := m.publishSnapshot(ctx, kind, body, delay); err != nil {
			// A failed publish is not fatal: the next cycle republishes, and
			// guests keep reading the previous snapshot meanwhile.
			return
		}
	}

	d, err := m.drain(ctx)
	if err != nil {
		return
	}
	if hooks.Presence != nil {
		hooks.Presence(Presence{
			Listeners: d.Listeners,
			SpreadMs:  d.SpreadMs,
			Roster:    d.Roster,
		})
	}
	if hooks.ApplyWrite != nil {
		for _, w := range d.Writes {
			hooks.ApplyWrite(w.Path, w.Body)
		}
	}
}

func (m *Manager) publishSnapshot(ctx context.Context, kind string, body json.RawMessage, delaySec float64) error {
	base, token := m.cfg.target()
	if base == "" {
		return errNoOrigin
	}
	target, err := joinURL(base, "__pp/plane/"+kind)
	if err != nil {
		return err
	}
	if delaySec > 0 {
		target += fmt.Sprintf("?delaySec=%.3f", delaySec)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, target, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := m.originClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4<<10))
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return fmt.Errorf("publish %s: status %d", kind, resp.StatusCode)
	}
	return nil
}

func (m *Manager) drain(ctx context.Context) (digest, error) {
	var out digest
	base, token := m.cfg.target()
	if base == "" {
		return out, errNoOrigin
	}
	target, err := joinURL(base, "__pp/drain")
	if err != nil {
		return out, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, target, nil)
	if err != nil {
		return out, err
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := m.originClient.Do(req)
	if err != nil {
		return out, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return out, fmt.Errorf("drain: status %d", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxDigestBytes))
	if err != nil {
		return out, err
	}
	if err := json.Unmarshal(body, &out); err != nil {
		return out, err
	}
	return out, nil
}
