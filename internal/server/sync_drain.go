package server

import (
	"context"
	"net/http"
	"os"
	"strings"
	"time"

	"partyparty/internal/activate"
	"partyparty/internal/broadcast"
	"partyparty/internal/publish"
	postsync "partyparty/internal/sync"
)

const (
	syncDrainFirstDelay      = 15 * time.Second
	syncDrainBacklogInterval = 45 * time.Second
	syncDrainIdleInterval    = 5 * time.Minute
	syncDrainWatchInterval   = 2 * time.Second
	syncDrainAttemptTimeout  = 20 * time.Minute
)

var (
	syncDrainCreds = func() publish.Creds {
		id, secret := activate.InstallCreds()
		return publish.Creds{ID: id, Secret: secret, InstallSlug: activate.InstallSlug()}
	}
	syncDrainBacklog = postsync.PendingBacklog
	syncDrainSync    = postsync.SyncPostsWithOptions
	syncDrainOnline  = defaultSyncDrainOnline
	syncDrainIdle    = func(b *broadcast.Broadcaster) bool {
		if b == nil {
			return true
		}
		return b.Status().State == "idle"
	}
)

// StartSyncDrain starts the automatic after-event mirror drain. It is safe to
// call multiple times; calls coalesce into one background loop.
func (s *Srv) StartSyncDrain(ctx context.Context) {
	if s == nil || s.Events == nil {
		return
	}
	s.syncDrainOnce.Do(func() {
		go s.syncDrainLoop(ctx)
		go s.syncDrainBroadcastWatcher(ctx)
	})
	s.triggerSyncDrain()
}

func (s *srv) triggerSyncDrain() {
	if s == nil || s.syncDrainKick == nil {
		return
	}
	select {
	case s.syncDrainKick <- struct{}{}:
	default:
	}
}

func (s *srv) syncDrainLoop(ctx context.Context) {
	timer := time.NewTimer(syncDrainFirstDelay)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-s.syncDrainKick:
		case <-timer.C:
		}
		backlog, _ := s.runSyncDrainOnce(ctx, "loop")
		next := syncDrainIdleInterval
		if !backlog.Empty() {
			next = syncDrainBacklogInterval
		}
		timer.Reset(next)
	}
}

func (s *srv) syncDrainBroadcastWatcher(ctx context.Context) {
	tick := time.NewTicker(syncDrainWatchInterval)
	defer tick.Stop()
	wasActive := false
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
		st := ""
		if s.Broadcaster != nil {
			st = s.Broadcaster.Status().State
		}
		active := st == "live" || st == "starting" || st == "stopping"
		if wasActive && !active && st == "idle" {
			s.triggerSyncDrain()
		}
		wasActive = active
	}
}

func (s *srv) runSyncDrainOnce(ctx context.Context, _ string) (postsync.Backlog, bool) {
	dir, creds, slug, base, ok := s.syncDrainTarget()
	if !ok {
		return postsync.Backlog{}, false
	}
	backlog, err := syncDrainBacklog(dir, creds, slug)
	if err != nil {
		s.diagf("sync: backlog check failed: %v", err)
		return postsync.Backlog{}, false
	}
	if backlog.Empty() {
		return backlog, false
	}
	if !syncDrainIdle(s.Broadcaster) {
		s.diagf("sync: %d posts / %d media pending (live)", backlog.PostsPending, backlog.MediaPending)
		return backlog, false
	}
	if !syncDrainOnline(ctx, base) {
		s.diagf("sync: %d posts / %d media pending (offline)", backlog.PostsPending, backlog.MediaPending)
		return backlog, false
	}
	if !s.beginSyncDrainRun() {
		return backlog, false
	}
	defer s.endSyncDrainRun()

	cctx, cancel := context.WithTimeout(ctx, syncDrainAttemptTimeout)
	defer cancel()
	stopWatch := make(chan struct{})
	go func() {
		tick := time.NewTicker(time.Second)
		defer tick.Stop()
		defer close(stopWatch)
		for {
			select {
			case <-cctx.Done():
				return
			case <-tick.C:
				if !syncDrainIdle(s.Broadcaster) {
					cancel()
					return
				}
			}
		}
	}()
	res, err := syncDrainSync(cctx, dir, creds, slug, base, postsync.Options{})
	cancel()
	<-stopWatch
	if err != nil {
		s.diagf("sync: drain failed: %v", err)
		return backlog, true
	}
	if res.Offline {
		s.diagf("sync: %d posts / %d media pending (offline: %s)", backlog.PostsPending, backlog.MediaPending, res.LastError)
		return backlog, true
	}
	s.diagf("sync: drained %d posts / %d media to cloud (skipped %d posts / %d media, missing %d)", res.PostsPushed, res.MediaPushed, res.PostsSkipped, res.MediaSkipped, res.MediaMissing)
	if remaining, rerr := syncDrainBacklog(dir, creds, slug); rerr == nil {
		backlog = remaining
		if remaining.Empty() {
			s.diagf("sync: mirror complete for %s", slug)
		} else {
			s.diagf("sync: %d posts / %d media pending", remaining.PostsPending, remaining.MediaPending)
		}
	}
	return backlog, true
}

func (s *srv) syncDrainTarget() (dir string, creds publish.Creds, slug, base string, ok bool) {
	if s.Events == nil {
		return "", publish.Creds{}, "", "", false
	}
	creds = syncDrainCreds()
	if creds.ID == "" || creds.Secret == "" {
		return "", publish.Creds{}, "", "", false
	}
	slug = publish.SlugForEvent(s.Events.Slug(), creds.InstallSlug)
	if strings.TrimSpace(slug) == "" {
		return "", publish.Creds{}, "", "", false
	}
	base = os.Getenv("PARTYPARTY_BROKER")
	if base == "" {
		base = "https://party.ramine.net"
	}
	return s.Events.Dir(), creds, slug, strings.TrimRight(base, "/"), true
}

func (s *srv) beginSyncDrainRun() bool {
	s.syncDrainMu.Lock()
	defer s.syncDrainMu.Unlock()
	if s.syncDrainRunning {
		return false
	}
	s.syncDrainRunning = true
	return true
}

func (s *srv) endSyncDrainRun() {
	s.syncDrainMu.Lock()
	s.syncDrainRunning = false
	s.syncDrainMu.Unlock()
}

func (s *srv) diagf(format string, args ...any) {
	if s.Diag != nil {
		s.Diag.Printf(format, args...)
	}
}

func defaultSyncDrainOnline(ctx context.Context, base string) bool {
	if base == "" {
		base = "https://party.ramine.net"
	}
	cctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(cctx, http.MethodHead, strings.TrimRight(base, "/")+"/", nil)
	if err != nil {
		return false
	}
	resp, err := (&http.Client{Timeout: 3 * time.Second}).Do(req)
	if err != nil {
		return false
	}
	resp.Body.Close()
	return true
}
