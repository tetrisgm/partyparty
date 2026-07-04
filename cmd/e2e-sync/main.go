package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"strings"
	"time"

	"partyparty/internal/event"
	"partyparty/internal/publish"
	postsync "partyparty/internal/sync"
)

const (
	postText    = "E2E_SYNC_POST_TEXT local-first bytes landed"
	commentText = "E2E_SYNC_COMMENT_TEXT comment landed"
	mediaName   = "e2e-pixel.png"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "e2e-sync: %v\n", err)
		os.Exit(1)
	}
}

func run() error {
	eventDir := flag.String("event-dir", env("E2E_EVENT_DIR", ""), "temporary event base directory; the helper creates one event folder inside it")
	baseURL := flag.String("base-url", env("E2E_BASE_URL", ""), "local worker base URL, for example http://127.0.0.1:8787")
	id := flag.String("id", env("E2E_INSTALL_ID", ""), "test install id")
	secret := flag.String("secret", env("E2E_INSTALL_SECRET", ""), "test install secret")
	installSlug := flag.String("install-slug", env("E2E_INSTALL_SLUG", ""), "test install broker slug")
	slug := flag.String("slug", env("E2E_EVENT_SLUG", ""), "test event slug")
	flag.Parse()

	if strings.TrimSpace(*eventDir) == "" {
		return errors.New("missing -event-dir")
	}
	if strings.TrimSpace(*baseURL) == "" {
		return errors.New("missing -base-url")
	}
	if strings.TrimSpace(*id) == "" || strings.TrimSpace(*secret) == "" || strings.TrimSpace(*installSlug) == "" {
		return errors.New("missing test credentials")
	}
	if strings.TrimSpace(*slug) == "" {
		return errors.New("missing -slug")
	}

	ev, err := event.Open(*eventDir)
	if err != nil {
		return fmt.Errorf("open event store: %w", err)
	}
	if err := ev.SetMeta("E2E Sync Harness", "Local Test DJ", "now"); err != nil {
		return fmt.Errorf("set event meta: %w", err)
	}
	if _, err := ev.SetSlug(*slug); err != nil {
		return fmt.Errorf("set event slug: %w", err)
	}

	mediaBytes, err := base64.StdEncoding.DecodeString("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=")
	if err != nil {
		return err
	}
	m, err := ev.SaveMedia(mediaName, bytes.NewReader(mediaBytes))
	if err != nil {
		return fmt.Errorf("save media through event store: %w", err)
	}
	p, _, err := ev.AddPost("e2e-cid-post", "E2E Guest", "✨", postText, []event.Media{m}, false)
	if err != nil {
		return fmt.Errorf("add post through event store: %w", err)
	}
	if _, err := ev.AddComment(p.ID, "e2e-cid-comment", "E2E Friend", "💬", commentText, false); err != nil {
		return fmt.Errorf("add comment through event store: %w", err)
	}

	creds := publish.Creds{ID: *id, Secret: *secret, InstallSlug: *installSlug}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	actualEventDir := ev.Dir()
	first, err := postsync.SyncPosts(ctx, actualEventDir, creds, *slug, *baseURL)
	if err != nil {
		return fmt.Errorf("first SyncPosts: %w", err)
	}
	if err := assertFirstResult(first); err != nil {
		return err
	}

	second, err := postsync.SyncPosts(ctx, actualEventDir, creds, *slug, *baseURL)
	if err != nil {
		return fmt.Errorf("second SyncPosts: %w", err)
	}
	if err := assertNoopResult(second); err != nil {
		return err
	}

	out := struct {
		EventDir string          `json:"eventDir"`
		PostID   string          `json:"postId"`
		MediaID  string          `json:"mediaId"`
		First    postsync.Result `json:"first"`
		Second   postsync.Result `json:"second"`
	}{
		EventDir: actualEventDir,
		PostID:   p.ID,
		MediaID:  m.ID,
		First:    first,
		Second:   second,
	}
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	return enc.Encode(out)
}

func assertFirstResult(res postsync.Result) error {
	if res.Offline {
		return fmt.Errorf("first SyncPosts went offline: %s", res.LastError)
	}
	if res.PostsTotal != 1 || res.PostsPushed != 1 {
		return fmt.Errorf("first SyncPosts did not push exactly one post: %+v", res)
	}
	if res.MediaTotal != 1 || res.MediaPushed != 1 {
		return fmt.Errorf("first SyncPosts did not push exactly one media item: %+v", res)
	}
	if res.MediaMissing != 0 || res.MediaDeferred != 0 {
		return fmt.Errorf("first SyncPosts left media unresolved: %+v", res)
	}
	return nil
}

func assertNoopResult(res postsync.Result) error {
	if res.Offline {
		return fmt.Errorf("second SyncPosts went offline: %s", res.LastError)
	}
	if res.PostsTotal != 1 || res.MediaTotal != 1 {
		return fmt.Errorf("second SyncPosts saw unexpected totals: %+v", res)
	}
	if res.PostsPushed != 0 || res.MediaPushed != 0 {
		return fmt.Errorf("second SyncPosts was not a no-op: %+v", res)
	}
	if res.PostsSkipped != 1 || res.MediaSkipped != 1 {
		return fmt.Errorf("second SyncPosts did not skip the acked post/media: %+v", res)
	}
	return nil
}

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
