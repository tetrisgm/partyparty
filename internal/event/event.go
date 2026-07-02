// Package event is the party's social layer: a per-event feed of posts
// (text + photos/videos) plus the media files themselves and the set
// recordings, all stored in a normal, user-visible folder the DJ can open in
// Finder and drag from (~/Music/partyparty/<date>). The Mac IS the event's
// server while the party runs; publishing the page online later just means
// syncing this folder — so everything a future publish needs (author claim
// tokens, optional contact info) is captured now, privately.
package event

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// Media is one uploaded file attached to a post.
type Media struct {
	ID   string `json:"id"`   // stored filename inside media/ (uuid + ext)
	Type string `json:"type"` // image | video | audio
	Name string `json:"name"` // original filename, sanitized (display only)
	Size int64  `json:"size"`
}

// Post is one feed entry. CID is the author's private client id — it never
// leaves the server in feed responses (it's the future "claim my posts"
// proof), only the pseudonym does.
type Post struct {
	ID      string  `json:"id"`
	TS      int64   `json:"ts"` // unix millis
	CID     string  `json:"-"`
	Author  string  `json:"author"`
	Emoji   string  `json:"emoji"`
	Text    string  `json:"text"`
	Media   []Media `json:"media,omitempty"`
	DJ      bool    `json:"dj,omitempty"`
	Deleted bool    `json:"-"`
}

// line is the on-disk journal record: a post or a tombstone.
type line struct {
	Op   string `json:"op"` // "post" | "delete"
	ID   string `json:"id,omitempty"`
	CID  string `json:"cid,omitempty"`
	Post *Post  `json:"post,omitempty"`
}

// Guest is the private per-guest record (guests.json, DJ-only). It captures
// everything the future published page needs to let this person CLAIM their
// posts: the pseudonym they used, a claim-token HASH (the raw token exists
// only in the guest's own hands, as a capability URL), and optional contact.
type Guest struct {
	Pseudonym string `json:"pseudonym"`
	Emoji     string `json:"emoji"`
	Contact   string `json:"contact,omitempty"`
	TokenHash string `json:"tokenHash"` // sha256(raw claim token), hex
	Created   int64  `json:"createdAt"` // unix millis
}

// Meta is the event's public identity (meta.json) — what the welcome card
// shows: "<Host> is hosting <Title>". DJ-editable from the console.
type Meta struct {
	Title string `json:"title"`
	Host  string `json:"host"`
}

// Store manages the current event directory. Safe for concurrent use.
type Store struct {
	mu      sync.Mutex
	baseDir string
	dir     string
	meta    Meta
	posts   []*Post
	byID    map[string]*Post
	guests  map[string]*Guest // cid -> guest — PRIVATE, never in feed responses
}

// Open finds today's most recent event under baseDir (or creates one), so an
// app restart mid-party lands back in the same feed.
func Open(baseDir string) (*Store, error) {
	if err := os.MkdirAll(baseDir, 0o755); err != nil {
		return nil, err
	}
	date := time.Now().Format("2006-01-02")
	dir := ""
	entries, _ := os.ReadDir(baseDir)
	for _, e := range entries { // ReadDir sorts by name → the last date match wins
		if e.IsDir() && strings.HasPrefix(e.Name(), date) {
			dir = filepath.Join(baseDir, e.Name())
		}
	}
	if dir == "" {
		dir = filepath.Join(baseDir, date)
	}
	s := &Store{baseDir: baseDir}
	if err := s.use(dir); err != nil {
		return nil, err
	}
	return s, nil
}

// use switches the store to dir, creating the layout and replaying the journal.
func (s *Store) use(dir string) error {
	for _, sub := range []string{"", "media", "recordings"} {
		if err := os.MkdirAll(filepath.Join(dir, sub), 0o755); err != nil {
			return err
		}
	}
	posts, byID := []*Post{}, map[string]*Post{}
	if data, err := os.ReadFile(filepath.Join(dir, "posts.jsonl")); err == nil {
		for _, raw := range strings.Split(string(data), "\n") {
			if strings.TrimSpace(raw) == "" {
				continue
			}
			var l line
			if json.Unmarshal([]byte(raw), &l) != nil {
				continue // never let one corrupt line kill the feed
			}
			switch {
			case l.Op == "post" && l.Post != nil:
				p := *l.Post
				p.CID = l.CID
				posts = append(posts, &p)
				byID[p.ID] = &p
			case l.Op == "delete":
				if p, ok := byID[l.ID]; ok {
					p.Deleted = true
				}
			}
		}
	}
	guests := map[string]*Guest{}
	if data, err := os.ReadFile(filepath.Join(dir, "guests.json")); err == nil {
		_ = json.Unmarshal(data, &guests)
	}
	meta := Meta{Title: "party " + filepath.Base(dir), Host: "the DJ"}
	if data, err := os.ReadFile(filepath.Join(dir, "meta.json")); err == nil {
		_ = json.Unmarshal(data, &meta)
	}
	s.mu.Lock()
	s.dir, s.posts, s.byID, s.guests, s.meta = dir, posts, byID, guests, meta
	s.mu.Unlock()
	return nil
}

// Meta returns the event's public identity.
func (s *Store) Meta() Meta {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.meta
}

// SetMeta updates title/host (empty field = keep current) and persists.
func (s *Store) SetMeta(title, host string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if t := clip(strings.TrimSpace(title), 80); t != "" {
		s.meta.Title = t
	}
	if h := clip(strings.TrimSpace(host), 40); h != "" {
		s.meta.Host = h
	}
	data, err := json.MarshalIndent(s.meta, "", " ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(s.dir, "meta.json"), data, 0o644)
}

// Fresh abandons the current feed and starts a new event directory (the old
// one stays on disk untouched — nothing is ever destroyed).
func (s *Store) Fresh() error {
	s.mu.Lock()
	base := s.baseDir
	s.mu.Unlock()
	date := time.Now().Format("2006-01-02")
	dir := filepath.Join(base, date)
	for n := 2; ; n++ {
		if _, err := os.Stat(dir); errors.Is(err, os.ErrNotExist) {
			break
		}
		dir = filepath.Join(base, fmt.Sprintf("%s (%d)", date, n))
	}
	return s.use(dir)
}

// Dir returns the current event directory (for "Open media folder" etc.).
func (s *Store) Dir() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.dir
}

// RecordingPath returns a fresh timestamped recording target for a set.
func (s *Store) RecordingPath() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return filepath.Join(s.dir, "recordings", "set-"+time.Now().Format("20060102-150405")+".aac")
}

// MediaFiles lists every stored media file (for the everything-zip).
func (s *Store) MediaFiles() []string {
	s.mu.Lock()
	dir := filepath.Join(s.dir, "media")
	s.mu.Unlock()
	entries, _ := os.ReadDir(dir)
	var files []string
	for _, e := range entries {
		if !e.IsDir() && !strings.HasPrefix(e.Name(), ".") {
			files = append(files, filepath.Join(dir, e.Name()))
		}
	}
	return files
}

func newID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// mediaExt whitelists upload types and classifies them for the feed.
var mediaExt = map[string]string{
	".jpg": "image", ".jpeg": "image", ".png": "image", ".gif": "image",
	".heic": "image", ".heif": "image", ".webp": "image",
	".mp4": "video", ".mov": "video", ".m4v": "video", ".webm": "video",
	".mp3": "audio", ".m4a": "audio", ".aac": "audio", ".wav": "audio",
}

// MaxUpload caps one file (full-quality phone video is the point, so be
// generous — this is a LAN).
const MaxUpload = 2 << 30 // 2 GiB

// SaveMedia streams one uploaded file to the media dir and returns its entry.
func (s *Store) SaveMedia(origName string, r io.Reader) (Media, error) {
	ext := strings.ToLower(filepath.Ext(origName))
	typ, ok := mediaExt[ext]
	if !ok {
		return Media{}, fmt.Errorf("file type %q not supported (photos, videos, audio)", ext)
	}
	id := newID() + ext
	s.mu.Lock()
	dst := filepath.Join(s.dir, "media", id)
	s.mu.Unlock()
	f, err := os.OpenFile(dst, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
	if err != nil {
		return Media{}, err
	}
	n, err := io.Copy(f, io.LimitReader(r, MaxUpload+1))
	f.Close()
	if err != nil || n > MaxUpload {
		os.Remove(dst)
		if n > MaxUpload {
			return Media{}, fmt.Errorf("file too large (max 2 GB)")
		}
		return Media{}, err
	}
	name := filepath.Base(origName)
	if len(name) > 120 {
		name = name[len(name)-120:]
	}
	return Media{ID: id, Type: typ, Name: name, Size: n}, nil
}

// MediaPath resolves a media id to its file, refusing path escapes.
func (s *Store) MediaPath(id string) (string, bool) {
	if id == "" || id != filepath.Base(id) || strings.HasPrefix(id, ".") {
		return "", false
	}
	s.mu.Lock()
	p := filepath.Join(s.dir, "media", id)
	s.mu.Unlock()
	if st, err := os.Stat(p); err != nil || st.IsDir() {
		return "", false
	}
	return p, true
}

// AddPost validates, journals, and returns the stored post (plus a one-time
// raw claim token when this is the guest's first post). Media entries are
// re-verified against files actually present in this event's media dir.
func (s *Store) AddPost(cid, author, emoji, text string, media []Media, dj bool) (*Post, string, error) {
	text = strings.TrimSpace(text)
	if len(text) > 2000 {
		text = text[:2000]
	}
	if text == "" && len(media) == 0 {
		return nil, "", errors.New("empty post")
	}
	if len(media) > 12 {
		media = media[:12]
	}
	verified := make([]Media, 0, len(media))
	for _, m := range media {
		p, ok := s.MediaPath(m.ID)
		if !ok {
			continue
		}
		st, err := os.Stat(p)
		if err != nil {
			continue
		}
		typ := mediaExt[strings.ToLower(filepath.Ext(m.ID))]
		name := filepath.Base(m.Name)
		if len(name) > 120 {
			name = name[len(name)-120:]
		}
		verified = append(verified, Media{ID: m.ID, Type: typ, Name: name, Size: st.Size()})
	}
	p := &Post{
		ID: newID(), TS: time.Now().UnixMilli(), CID: cid,
		Author: clip(author, 40), Emoji: clip(emoji, 8), Text: text,
		Media: verified, DJ: dj,
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.appendLine(line{Op: "post", CID: cid, Post: p}); err != nil {
		return nil, "", err
	}
	s.posts = append(s.posts, p)
	s.byID[p.ID] = p
	// First post from this cid: mint the guest record + claim token. The RAW
	// token is returned exactly once (the client turns it into a keepsake
	// claim link); only its hash persists here.
	claimToken := ""
	if !dj && cid != "" {
		if g, ok := s.guests[cid]; !ok || g.TokenHash == "" {
			raw := make([]byte, 16)
			_, _ = rand.Read(raw)
			claimToken = base64.RawURLEncoding.EncodeToString(raw)
			sum := sha256.Sum256([]byte(claimToken))
			s.guests[cid] = &Guest{
				Pseudonym: p.Author, Emoji: p.Emoji,
				TokenHash: hex.EncodeToString(sum[:]),
				Created:   p.TS,
			}
			_ = s.saveGuestsLocked()
		} else if g.Pseudonym != p.Author || g.Emoji != p.Emoji {
			g.Pseudonym, g.Emoji = p.Author, p.Emoji // follow renames
			_ = s.saveGuestsLocked()
		}
	}
	return p, claimToken, nil
}

// Delete tombstones a post (DJ moderation). Media files stay on disk — the
// folder is the DJ's archive; the feed just stops showing the post.
func (s *Store) Delete(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	p, ok := s.byID[id]
	if !ok || p.Deleted {
		return errors.New("no such post")
	}
	if err := s.appendLine(line{Op: "delete", ID: id}); err != nil {
		return err
	}
	p.Deleted = true
	return nil
}

// SetContact stores a guest's optional private contact (email/phone) — the
// claim-link fallback for guests who saved nothing; never exposed in the feed.
func (s *Store) SetContact(cid, contact string) error {
	contact = clip(strings.TrimSpace(contact), 120)
	if cid == "" {
		return errors.New("missing cid")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	g, ok := s.guests[cid]
	if !ok {
		g = &Guest{Created: time.Now().UnixMilli()}
		s.guests[cid] = g
	}
	g.Contact = contact
	return s.saveGuestsLocked()
}

func (s *Store) saveGuestsLocked() error {
	data, err := json.MarshalIndent(s.guests, "", " ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(s.dir, "guests.json"), data, 0o600)
}

// Feed returns visible posts newer than sinceTS (0 = all), oldest first,
// plus counts for the console.
func (s *Store) Feed(sinceTS int64) (posts []Post, total int, mediaCount int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, p := range s.posts {
		if p.Deleted {
			continue
		}
		total++
		mediaCount += len(p.Media)
		if p.TS > sinceTS {
			posts = append(posts, *p)
		}
	}
	sort.Slice(posts, func(i, j int) bool { return posts[i].TS < posts[j].TS })
	return posts, total, mediaCount
}

func (s *Store) appendLine(l line) error {
	data, err := json.Marshal(l)
	if err != nil {
		return err
	}
	f, err := os.OpenFile(filepath.Join(s.dir, "posts.jsonl"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = f.Write(append(data, '\n'))
	return err
}

func clip(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}
