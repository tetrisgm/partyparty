package event

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strings"
	"time"
)

// The wall and the event page are one timeline, and this is the seam between
// them. Two things have to be true for that to survive a venue's bad Wi-Fi:
// the same local post must always produce the same id in the cloud, so a retry
// is a retry rather than a second photo, and a post arriving back from the
// cloud must never become a duplicate of one already here.

// CloudPostID maps a local post onto the 32-hex id the platform stores. It is
// derived rather than random precisely so it can be recomputed: a Mac that
// pushes, loses its connection before it hears back, and pushes again produces
// the identical id both times.
func CloudPostID(localID string, ts int64) string {
	sum := sha256.Sum256([]byte("pp-cloud-post:" + localID))
	return fmt.Sprintf("%012x%s", ts&0xffffffffffff, hex.EncodeToString(sum[:])[:20])
}

// MergeRemotePost takes a post written on the web and puts it on this party's
// wall. It reports false when the post is already here, so a sync that repeats
// itself costs nothing.
//
// Posts carrying media are NOT merged: their files live in the cloud and this
// Mac cannot serve them to a guest on the LAN. They are on the event page,
// which is where they can actually be seen - the wall shows what the room can
// reach, and pretending otherwise would put broken pictures on a projector.
func (s *Store) MergeRemotePost(id, author, text string, tsMs int64) (bool, error) {
	id = strings.TrimSpace(id)
	text = strings.TrimSpace(text)
	if id == "" || text == "" {
		return false, nil
	}
	if len(text) > 2000 {
		text = text[:2000]
	}
	now := time.Now().UnixMilli()
	if tsMs <= 0 {
		tsMs = now
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if _, exists := s.byID[id]; exists {
		return false, nil
	}
	post := &Post{
		ID:     id,
		TS:     tsMs,
		Author: clip(author, 40),
		Text:   text,
		State:  StateApproved,
	}
	// TS belongs to the remote post and remains its display timestamp. Act is a
	// local arrival-order token: allowing an untrusted remote clock to choose it
	// can push this store (and every Mac merging its feed) arbitrarily far into
	// the future.
	post.Act = s.nextActivityLocked(now)
	if err := s.appendLine(line{Op: "post", Post: post, TS: post.Act}); err != nil {
		return false, err
	}
	s.posts = append(s.posts, post)
	s.byID[post.ID] = post
	s.changed()
	return true, nil
}

// OutgoingPosts is what this party has that the cloud may not: posts written
// here, with their cloud ids already computed. Posts that came FROM the cloud
// are skipped - their ids are already 32 hex, and sending them back would ask
// the platform to store what it gave us.
func (s *Store) OutgoingPosts(limit int) []CloudPost {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]CloudPost, 0, limit)
	for i := len(s.posts) - 1; i >= 0 && len(out) < limit; i-- {
		post := s.posts[i]
		if post == nil || post.Deleted || len(post.ID) != 16 {
			continue
		}
		body := post.Text
		if body == "" && len(post.Media) > 0 {
			// A photo with no words still belongs on the timeline; the file
			// itself follows when media upload lands.
			body = "(photo)"
		}
		if body == "" {
			continue
		}
		out = append(out, CloudPost{
			ID:        CloudPostID(post.ID, post.TS),
			Author:    post.Author,
			Body:      body,
			CreatedMs: post.TS,
		})
	}
	// Oldest first, so the timeline reads in the order it happened.
	for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
		out[i], out[j] = out[j], out[i]
	}
	return out
}

// CloudPost is one item in the shape the platform stores. It mirrors
// cloudsync.Post; this package does not import that one, so the store stays
// free of any knowledge about how it reaches the cloud.
type CloudPost struct {
	ID        string `json:"id"`
	Author    string `json:"author"`
	Body      string `json:"body"`
	CreatedMs int64  `json:"createdMs"`
}
