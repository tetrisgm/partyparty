package server

import (
	"context"
	"testing"

	"partyparty/internal/broadcast"
	"partyparty/internal/event"
	"partyparty/internal/publish"
	postsync "partyparty/internal/sync"
)

func TestSyncDrainGating(t *testing.T) {
	cases := []struct {
		name       string
		backlog    postsync.Backlog
		idle       bool
		wantRun    bool
		wantOnline bool
	}{
		{
			name:    "does not run while live",
			backlog: postsync.Backlog{MediaPending: 1},
			idle:    false,
		},
		{
			name:    "runs when idle with backlog",
			backlog: postsync.Backlog{PostsPending: 1, MediaPending: 2},
			idle:    true,
			wantRun: true, wantOnline: true,
		},
		{
			name: "no-op when queue empty",
			idle: true,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ev, err := event.Open(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			if _, err := ev.SetSlug("party-slug"); err != nil {
				t.Fatal(err)
			}
			s := &srv{Deps: Deps{Events: ev}}

			oldCreds, oldBacklog, oldSync, oldOnline, oldIdle := syncDrainCreds, syncDrainBacklog, syncDrainSync, syncDrainOnline, syncDrainIdle
			t.Cleanup(func() {
				syncDrainCreds, syncDrainBacklog, syncDrainSync, syncDrainOnline, syncDrainIdle = oldCreds, oldBacklog, oldSync, oldOnline, oldIdle
			})

			backlogCalls := 0
			onlineCalls := 0
			syncCalls := 0
			syncDrainCreds = func() publish.Creds {
				return publish.Creds{ID: "install-id", Secret: "secret", InstallSlug: "fader91"}
			}
			syncDrainBacklog = func(dir string, creds publish.Creds, slug string) (postsync.Backlog, error) {
				backlogCalls++
				if slug != "party-slug" {
					t.Fatalf("slug = %q, want party-slug", slug)
				}
				if syncCalls > 0 {
					return postsync.Backlog{}, nil
				}
				return tc.backlog, nil
			}
			syncDrainOnline = func(context.Context, string) bool {
				onlineCalls++
				return true
			}
			syncDrainIdle = func(*broadcast.Broadcaster) bool {
				return tc.idle
			}
			syncDrainSync = func(context.Context, string, publish.Creds, string, string, postsync.Options) (postsync.Result, error) {
				syncCalls++
				return postsync.Result{PostsPushed: tc.backlog.PostsPending, MediaPushed: tc.backlog.MediaPending}, nil
			}

			_, ran := s.runSyncDrainOnce(context.Background(), "test")
			if ran != tc.wantRun {
				t.Fatalf("ran = %v, want %v", ran, tc.wantRun)
			}
			if got := syncCalls; got != boolInt(tc.wantRun) {
				t.Fatalf("sync calls = %d, want %d", got, boolInt(tc.wantRun))
			}
			if got := onlineCalls; (got > 0) != tc.wantOnline {
				t.Fatalf("online calls = %d, want called=%v", got, tc.wantOnline)
			}
			if backlogCalls == 0 {
				t.Fatal("backlog was not checked")
			}
		})
	}
}

func boolInt(v bool) int {
	if v {
		return 1
	}
	return 0
}
