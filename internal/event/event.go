// Package event is the party's social layer: a per-event feed of posts
// (text + photos/videos) plus the media files themselves and the set
// recordings, all stored in a normal, user-visible folder the DJ can open in
// Finder and drag from (~/Music/partyparty/<date>). The Mac IS the event's
// server while the party runs; publishing the page online later just means
// syncing this folder. Optional guest contact information remains private.
package event

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Media is one uploaded file attached to a post.
type Media struct {
	ID    string `json:"id"`   // stored filename inside media/ (uuid + ext)
	Type  string `json:"type"` // image | video | audio
	Name  string `json:"name"` // original filename, sanitized (display only)
	Size  int64  `json:"size"`
	Thumb string `json:"thumb,omitempty"` // /media/thumb/<id>, generated async
}

// Comment is one reply under a post. Same privacy rule as posts: CID stays
// server-side, the pseudonym travels.
type Comment struct {
	ID     string `json:"id"`
	TS     int64  `json:"ts"`
	CID    string `json:"-"`
	Author string `json:"author"`
	Emoji  string `json:"emoji"`
	Text   string `json:"text"`
	State  string `json:"state,omitempty"`
	DJ     bool   `json:"dj,omitempty"`
}

// Post is one feed entry. CID is the author's private client id; only the
// pseudonym leaves the server in feed responses. NoPublish marks posts the DJ excluded
// from the future ONLINE page (they stay visible at the party — exclusion
// is curation for later, removal is Delete).
type Post struct {
	ID  string `json:"id"`
	TS  int64  `json:"ts"`  // unix millis (creation)
	Act int64  `json:"act"` // last activity (creation/comment) — the feed cursor,
	// so a comment on an old post still reaches every client
	CID       string         `json:"-"`
	Author    string         `json:"author"`
	Emoji     string         `json:"emoji"`
	Text      string         `json:"text"`
	Media     []Media        `json:"media,omitempty"`
	DJ        bool           `json:"dj,omitempty"`
	State     string         `json:"state,omitempty"`
	Comments  []Comment      `json:"comments,omitempty"`
	Reactions map[string]int `json:"reactions,omitempty"`
	NoPublish bool           `json:"noPublish,omitempty"`
	Deleted   bool           `json:"-"`
}

// Request is one private guest song request for the DJ. CID stays server-side;
// requests are never included in the public/guest feed.
type Request struct {
	ID    string `json:"id"`
	CID   string `json:"-"`
	TS    int64  `json:"ts"`
	Text  string `json:"text"`
	Note  string `json:"note,omitempty"`
	Vibe  string `json:"vibe,omitempty"`
	State string `json:"state"`
}

// CurrentTrack is the DJ-shared "now playing" state. It is deliberately
// manual for the MVP; future integrations can feed the same store method.
type CurrentTrack struct {
	Title  string `json:"title"`
	Artist string `json:"artist,omitempty"`
	Note   string `json:"note,omitempty"`
	SetAt  int64  `json:"setAt"`
}

// line is the on-disk journal record: a post, comment, request, track update,
// tombstone, or flag.
type line struct {
	Op        string        `json:"op"` // "post" | "delete" | "comment" | "request" | "request-state" | ...
	ID        string        `json:"id,omitempty"`
	CommentID string        `json:"commentId,omitempty"`
	Reaction  string        `json:"reaction,omitempty"`
	CID       string        `json:"cid,omitempty"`
	Post      *Post         `json:"post,omitempty"`
	Comment   *Comment      `json:"comment,omitempty"`
	Request   *Request      `json:"request,omitempty"`
	Track     *CurrentTrack `json:"track,omitempty"`
	State     string        `json:"state,omitempty"`
	On        bool          `json:"on,omitempty"` // publish flag value
	MediaID   string        `json:"mediaId,omitempty"`
	Thumb     string        `json:"thumb,omitempty"`
	TS        int64         `json:"ts,omitempty"`
}

// Guest is the private per-guest record (guests.json, DJ-only). It captures
// the party identity chosen on the phone and an optional email subscription.
// TokenHash is retained only so events created by older versions still load.
type Guest struct {
	Pseudonym string `json:"pseudonym"`
	Emoji     string `json:"emoji"`
	Contact   string `json:"contact,omitempty"`
	TokenHash string `json:"tokenHash,omitempty"` // legacy keepsake claim hash
	Created   int64  `json:"createdAt"`           // unix millis
}

// Meta is the event's public identity (meta.json) — what the welcome card
// shows: "<Host> is hosting <Title>". DJ-editable from the console. Starts is
// a free-text invite line ("Saturday 9pm — rooftop") for the pre-event page.
type Meta struct {
	Title          string          `json:"title"`
	Host           string          `json:"host"`
	Starts         string          `json:"starts,omitempty"`
	Date           string          `json:"date,omitempty"`
	Time           string          `json:"time,omitempty"`
	Place          string          `json:"place,omitempty"`
	Cover          string          `json:"cover,omitempty"`
	Features       map[string]bool `json:"features,omitempty"`
	ModerationMode string          `json:"moderationMode,omitempty"`
	Links          []Link          `json:"links,omitempty"`
	// Slug is the DJ's chosen /e/<slug> for this event's ONLINE page. "" means
	// auto-derive one from the install at publish time. Charset-gated (see
	// SetSlug) to the Worker's EVENT_RE so a bad value can never reach the page.
	Slug string `json:"slug,omitempty"`
}

type Link struct {
	Label string `json:"label"`
	URL   string `json:"url"`
	Type  string `json:"type"`
}

const (
	StateApproved = "approved"
	StatePending  = "pending"
	StateHidden   = "hidden"

	RequestStateNew       = "new"
	RequestStateDone      = "done"
	RequestStateDismissed = "dismissed"
	RequestStateStarred   = "starred"

	ModerationPostModerate = "post_moderate"
	ModerationPreApprove   = "pre_approve"
)

var linkTypeLabels = map[string]string{
	"instagram":        "Instagram",
	"soundcloud":       "SoundCloud",
	"bandcamp":         "Bandcamp",
	"mixcloud":         "Mixcloud",
	"resident_advisor": "Resident Advisor",
	"venmo":            "Venmo",
	"cashapp":          "Cash App",
	"paypal":           "PayPal",
	"website":          "Website",
	"newsletter":       "Newsletter",
	"other":            "Link",
}

func isLegacyAutoTitle(title, dirName string) bool {
	return strings.TrimSpace(title) == "party "+strings.TrimSpace(dirName)
}

func normalizeState(state string) string {
	switch state {
	case StateHidden:
		return state
	default:
		return StateApproved
	}
}

func validState(state string) bool {
	return state == StateApproved || state == StatePending || state == StateHidden
}

func normalizeModerationMode(_ string) string {
	return ModerationPostModerate
}

func validModerationMode(mode string) bool {
	return mode == ModerationPostModerate || mode == ModerationPreApprove
}

func normalizeRequestState(state string) string {
	switch state {
	case RequestStateDone, RequestStateDismissed, RequestStateStarred:
		return state
	default:
		return RequestStateNew
	}
}

func validRequestState(state string) bool {
	return state == RequestStateNew || state == RequestStateDone || state == RequestStateDismissed || state == RequestStateStarred
}

func ValidRequestVibe(vibe string) bool {
	switch vibe {
	case "", "harder", "softer", "faster", "slower", "more_like_this":
		return true
	default:
		return false
	}
}

func initialState(_ string) string {
	return StateApproved
}

var postReactionTypes = map[string]bool{
	"❤️": true,
	"🔥":  true,
	"😂":  true,
	"🎉":  true,
	"🪩":  true,
}

const MaxCoverBytes int64 = 15 << 20

func validPostReaction(reaction string) bool {
	return postReactionTypes[reaction]
}

func normalizeCoverRef(ref string) string {
	ref = strings.TrimSpace(ref)
	if ref == "" || ref == "/event-cover" {
		return ref
	}
	if !strings.HasPrefix(ref, "/covers/") {
		return ""
	}
	name := strings.TrimPrefix(ref, "/covers/")
	if name == "" || name != filepath.Base(name) {
		return ""
	}
	switch strings.ToLower(filepath.Ext(name)) {
	case ".jpg", ".jpeg", ".png", ".webp", ".gif":
		return "/covers/" + name
	default:
		return ""
	}
}

var featureDefaults = map[string]bool{
	"uploads":      true,
	"videoUploads": true,
	"comments":     true,
	"reactions":    false,
	"requests":     false,
	"trackId":      true,
	"wallMode":     true,
}

// FeatureDefaults returns the canonical guest-feature switches and their
// backward-compatible defaults.
func FeatureDefaults() map[string]bool {
	return normalizeFeatures(nil)
}

func validFeature(name string) bool {
	_, ok := featureDefaults[name]
	return ok
}

func normalizeFeatures(in map[string]bool) map[string]bool {
	out := make(map[string]bool, len(featureDefaults))
	for k, v := range featureDefaults {
		out[k] = v
	}
	for k, v := range in {
		if validFeature(k) {
			out[k] = v
		}
	}
	return out
}

func validLinkType(typ string) bool {
	_, ok := linkTypeLabels[typ]
	return ok
}

func defaultLinkLabel(typ string) string {
	if label, ok := linkTypeLabels[typ]; ok {
		return label
	}
	return linkTypeLabels["other"]
}

func normalizeLinks(in []Link) ([]Link, error) {
	if len(in) > 20 {
		return nil, errors.New("too many links")
	}
	out := make([]Link, 0, len(in))
	for _, l := range in {
		typ := strings.ToLower(strings.TrimSpace(l.Type))
		if typ == "" {
			typ = "other"
		}
		if !validLinkType(typ) {
			return nil, errors.New("unknown link type")
		}
		rawURL := strings.TrimSpace(l.URL)
		if rawURL == "" {
			continue
		}
		if len(rawURL) > 2048 {
			return nil, errors.New("link URL is too long")
		}
		u, err := url.Parse(rawURL)
		if err != nil || u == nil || u.Host == "" {
			return nil, errors.New("link URL must be a full http or https URL")
		}
		scheme := strings.ToLower(u.Scheme)
		if scheme != "http" && scheme != "https" {
			return nil, errors.New("link URL must use http or https")
		}
		u.Scheme = scheme
		out = append(out, Link{Label: defaultLinkLabel(typ), URL: u.String(), Type: typ})
	}
	if out == nil {
		out = []Link{}
	}
	return out, nil
}

// Store manages the current event directory. Safe for concurrent use.
type Store struct {
	mu           sync.Mutex
	baseDir      string
	dir          string
	meta         Meta
	posts        []*Post
	byID         map[string]*Post
	requests     []*Request
	byReqID      map[string]*Request
	guests       map[string]*Guest // cid -> guest — PRIVATE, never in feed responses
	reactions    map[string]*reactionCounter
	currentTrack *CurrentTrack
	recentTracks []CurrentTrack
	trackAsks    []int64
	thumbQ       chan thumbJob
	thumbOnce    sync.Once

	// Long-poll wakeup: closed and replaced on every visible mutation, so
	// /api/feed?wait=1 can hold requests and answer the INSTANT something
	// happens — the wall feels realtime without a 1s hammering interval.
	notifyMu sync.Mutex
	notify   chan struct{}
}

type reactionCounter struct {
	Total int
	Hits  []int64 // unix millis, pruned to reactionWindow for live telemetry
}

const (
	reactionWindow         = 60 * time.Second
	reactionSpikeThreshold = 3
	trackHistoryLimit      = 15
	trackAskWindow         = 60 * time.Second
)

var reactionTypes = []string{"fire", "heart", "louder", "quieter", "rewind", "id", "more"}

// ReactionTypes returns the canonical reaction telemetry keys.
func ReactionTypes() []string {
	out := make([]string, len(reactionTypes))
	copy(out, reactionTypes)
	return out
}

// ValidReactionType reports whether kind is one of the supported anonymous
// reaction taps.
func ValidReactionType(kind string) bool {
	for _, t := range reactionTypes {
		if kind == t {
			return true
		}
	}
	return false
}

func newReactionCounters() map[string]*reactionCounter {
	out := make(map[string]*reactionCounter, len(reactionTypes))
	for _, t := range reactionTypes {
		out[t] = &reactionCounter{}
	}
	return out
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
	s := &Store{baseDir: baseDir, notify: make(chan struct{})}
	if err := s.use(dir); err != nil {
		return nil, err
	}
	return s, nil
}

// changed wakes every parked long-poll (close-and-replace broadcast).
func (s *Store) changed() {
	s.notifyMu.Lock()
	close(s.notify)
	s.notify = make(chan struct{})
	s.notifyMu.Unlock()
}

// Wait returns a channel that closes on the next visible mutation.
func (s *Store) Wait() <-chan struct{} {
	s.notifyMu.Lock()
	defer s.notifyMu.Unlock()
	return s.notify
}

// use switches the store to dir, creating the layout and replaying the journal.
func (s *Store) use(dir string) error {
	for _, sub := range []string{"", "media", filepath.Join("media", "thumbs"), "recordings", "recap"} {
		if err := os.MkdirAll(filepath.Join(dir, sub), 0o755); err != nil {
			return err
		}
	}
	posts, byID := []*Post{}, map[string]*Post{}
	requests, byReqID := []*Request{}, map[string]*Request{}
	var currentTrack *CurrentTrack
	recentTracks := []CurrentTrack{}
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
				p.State = normalizeState(p.State)
				for i := range p.Comments {
					p.Comments[i].State = normalizeState(p.Comments[i].State)
				}
				if p.Act < p.TS {
					p.Act = p.TS
				}
				posts = append(posts, &p)
				byID[p.ID] = &p
			case l.Op == "delete":
				if p, ok := byID[l.ID]; ok {
					p.Deleted = true
				}
			case l.Op == "comment" && l.Comment != nil:
				if p, ok := byID[l.ID]; ok {
					c := *l.Comment
					c.CID = l.CID
					c.State = normalizeState(c.State)
					p.Comments = append(p.Comments, c)
					if p.Act < c.TS {
						p.Act = c.TS
					}
				}
			case l.Op == "comment-delete":
				if p, ok := byID[l.ID]; ok {
					for i := range p.Comments {
						if p.Comments[i].ID == l.CommentID {
							p.Comments = append(p.Comments[:i], p.Comments[i+1:]...)
							break
						}
					}
					if p.Act < l.TS {
						p.Act = l.TS
					}
				}
			case l.Op == "post-reaction" && validPostReaction(l.Reaction):
				if p, ok := byID[l.ID]; ok {
					if p.Reactions == nil {
						p.Reactions = map[string]int{}
					}
					p.Reactions[l.Reaction]++
					if p.Act < l.TS {
						p.Act = l.TS
					}
				}
			case l.Op == "mod" && validState(l.State):
				if p, ok := byID[l.ID]; ok {
					if l.CommentID == "" {
						p.State = l.State
					} else {
						for i := range p.Comments {
							if p.Comments[i].ID == l.CommentID {
								p.Comments[i].State = l.State
								break
							}
						}
					}
					if p.Act < l.TS {
						p.Act = l.TS
					}
				}
			case l.Op == "request" && l.Request != nil:
				req := *l.Request
				req.CID = l.CID
				req.Text = clip(strings.TrimSpace(req.Text), 200)
				req.Note = clip(strings.TrimSpace(req.Note), 240)
				if !ValidRequestVibe(req.Vibe) {
					req.Vibe = ""
				}
				req.State = normalizeRequestState(req.State)
				if req.ID == "" {
					req.ID = l.ID
				}
				requests = append(requests, &req)
				byReqID[req.ID] = &req
			case l.Op == "request-state" && validRequestState(l.State):
				if req, ok := byReqID[l.ID]; ok {
					req.State = l.State
				}
			case l.Op == "track-current" && l.Track != nil:
				if currentTrack != nil && currentTrack.Title != "" {
					recentTracks = append([]CurrentTrack{*currentTrack}, recentTracks...)
					if len(recentTracks) > trackHistoryLimit {
						recentTracks = recentTracks[:trackHistoryLimit]
					}
				}
				tr := cleanTrack(*l.Track)
				if tr.Title != "" {
					currentTrack = &tr
				}
			case l.Op == "track-clear":
				if currentTrack != nil && currentTrack.Title != "" {
					recentTracks = append([]CurrentTrack{*currentTrack}, recentTracks...)
					if len(recentTracks) > trackHistoryLimit {
						recentTracks = recentTracks[:trackHistoryLimit]
					}
				}
				currentTrack = nil
			case l.Op == "publish":
				if p, ok := byID[l.ID]; ok {
					p.NoPublish = !l.On
				}
			case l.Op == "thumb":
				for _, p := range posts {
					for i := range p.Media {
						if p.Media[i].ID == l.MediaID {
							p.Media[i].Thumb = l.Thumb
							if p.Act < l.TS {
								p.Act = l.TS
							}
						}
					}
				}
			}
		}
	}
	guests := map[string]*Guest{}
	if data, err := os.ReadFile(filepath.Join(dir, "guests.json")); err == nil {
		_ = json.Unmarshal(data, &guests)
	}
	dirName := filepath.Base(dir)
	meta := Meta{Title: "partyparty", Host: "the DJ"}
	if data, err := os.ReadFile(filepath.Join(dir, "meta.json")); err == nil {
		_ = json.Unmarshal(data, &meta)
	}
	legacyAutoTitle := isLegacyAutoTitle(meta.Title, dirName)
	meta.Features = normalizeFeatures(meta.Features)
	meta.ModerationMode = normalizeModerationMode(meta.ModerationMode)
	meta.Links, _ = normalizeLinks(meta.Links)
	meta.Cover = normalizeCoverRef(meta.Cover)
	if legacyAutoTitle {
		meta.Title = "partyparty"
		if data, err := json.MarshalIndent(meta, "", " "); err == nil {
			_ = os.WriteFile(filepath.Join(dir, "meta.json"), data, 0o644)
		}
	}
	s.mu.Lock()
	s.dir, s.posts, s.byID, s.requests, s.byReqID, s.guests, s.meta, s.reactions = dir, posts, byID, requests, byReqID, guests, meta, newReactionCounters()
	s.currentTrack, s.recentTracks, s.trackAsks = currentTrack, recentTracks, nil
	s.mu.Unlock()
	s.changed()
	return nil
}

// Meta returns the event's public identity.
func (s *Store) Meta() Meta {
	s.mu.Lock()
	defer s.mu.Unlock()
	m := s.meta
	m.Features = normalizeFeatures(s.meta.Features)
	m.ModerationMode = normalizeModerationMode(s.meta.ModerationMode)
	m.Links = append([]Link(nil), s.meta.Links...)
	m.Cover = normalizeCoverRef(s.meta.Cover)
	return m
}

// SetMeta updates title/host/starts (empty field = keep current; starts may
// be cleared with the literal "-") and persists.
func (s *Store) SetMeta(title, host, starts string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if t := clip(strings.TrimSpace(title), 80); t != "" {
		s.meta.Title = t
	}
	if h := clip(strings.TrimSpace(host), 40); h != "" {
		s.meta.Host = h
	}
	if st := clip(strings.TrimSpace(starts), 80); st != "" {
		if st == "-" {
			st = ""
		}
		s.meta.Starts = st
	}
	if err := s.saveMetaLocked(); err != nil {
		return err
	}
	s.changed() // title/host edits reach parked long-polls too
	return nil
}

// SetSchedule stores structured event fields while Starts remains the compact,
// human-readable line used by older clients and published replay pages.
func (s *Store) SetSchedule(date, clock, place, starts string) error {
	date = strings.TrimSpace(date)
	clock = strings.TrimSpace(clock)
	place = clip(strings.TrimSpace(place), 120)
	starts = clip(strings.TrimSpace(starts), 160)
	if date != "" {
		if _, err := time.Parse("2006-01-02", date); err != nil {
			return errors.New("date must use YYYY-MM-DD")
		}
	}
	if clock != "" {
		if _, err := time.Parse("15:04", clock); err != nil {
			return errors.New("time must use HH:MM")
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.meta.Date = date
	s.meta.Time = clock
	s.meta.Place = place
	s.meta.Starts = starts
	if err := s.saveMetaLocked(); err != nil {
		return err
	}
	s.changed()
	return nil
}

// SetCover stores either a bundled /covers asset or the event-local cover.
func (s *Store) SetCover(ref string) error {
	normalized := normalizeCoverRef(ref)
	if strings.TrimSpace(ref) != "" && normalized == "" {
		return errors.New("unknown cover")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.meta.Cover = normalized
	if err := s.saveMetaLocked(); err != nil {
		return err
	}
	s.changed()
	return nil
}

// SaveCover preserves an uploaded image in the event folder so the same cover
// is available to LAN guests without internet access.
func (s *Store) SaveCover(origName string, r io.Reader) (string, error) {
	ext := strings.ToLower(filepath.Ext(filepath.Base(origName)))
	switch ext {
	case ".jpg", ".jpeg", ".png", ".webp", ".gif":
	default:
		return "", errors.New("cover must be a JPG, PNG, WebP, or GIF")
	}
	s.mu.Lock()
	dir := s.dir
	s.mu.Unlock()
	tmp, err := os.CreateTemp(dir, ".cover-upload-*")
	if err != nil {
		return "", err
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)
	n, err := io.Copy(tmp, io.LimitReader(r, MaxCoverBytes+1))
	if err != nil {
		tmp.Close()
		return "", err
	}
	if n > MaxCoverBytes {
		tmp.Close()
		return "", errors.New("cover image is too large")
	}
	if err := tmp.Close(); err != nil {
		return "", err
	}
	dst := filepath.Join(dir, "cover"+ext)
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.dir != dir {
		return "", errors.New("event changed while saving cover")
	}
	entries, _ := os.ReadDir(dir)
	for _, entry := range entries {
		if !entry.IsDir() && strings.HasPrefix(entry.Name(), "cover.") {
			_ = os.Remove(filepath.Join(dir, entry.Name()))
		}
	}
	if err := os.Rename(tmpPath, dst); err != nil {
		return "", err
	}
	s.meta.Cover = "/event-cover"
	if err := s.saveMetaLocked(); err != nil {
		return "", err
	}
	s.changed()
	return dst, nil
}

// CoverPath returns the event-local cover selected by Meta.Cover.
func (s *Store) CoverPath() (string, bool) {
	s.mu.Lock()
	if s.meta.Cover != "/event-cover" {
		s.mu.Unlock()
		return "", false
	}
	dir := s.dir
	s.mu.Unlock()
	entries, err := os.ReadDir(dir)
	if err != nil {
		return "", false
	}
	for _, entry := range entries {
		if !entry.IsDir() && strings.HasPrefix(entry.Name(), "cover.") {
			return filepath.Join(dir, entry.Name()), true
		}
	}
	return "", false
}

func (s *Store) saveMetaLocked() error {
	data, err := json.MarshalIndent(s.meta, "", " ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(s.dir, "meta.json"), data, 0o644)
}

// Slug returns the DJ's chosen online slug for this event ("" = auto at publish).
func (s *Store) Slug() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.meta.Slug
}

// SetSlug stores a DJ-chosen /e/<slug>, normalized to the Worker's EVENT_RE
// charset ([A-Za-z0-9_.-], 1-48). An empty/blank value clears it (revert to
// the auto-derived slug at publish). Returns the normalized slug actually
// stored. A value that normalizes to nothing usable is rejected.
func (s *Store) SetSlug(raw string) (string, error) {
	slug := NormalizeSlug(raw)
	if strings.TrimSpace(raw) != "" && slug == "" {
		return "", errors.New("slug must contain letters or numbers")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.meta.Slug = slug
	if err := s.saveMetaLocked(); err != nil {
		return "", err
	}
	s.changed()
	return slug, nil
}

// SetFeature updates one DJ-controlled guest feature switch and persists it.
func (s *Store) SetFeature(name string, on bool) error {
	if !validFeature(name) {
		return errors.New("unknown feature")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.meta.Features = normalizeFeatures(s.meta.Features)
	s.meta.Features[name] = on
	if err := s.saveMetaLocked(); err != nil {
		return err
	}
	s.changed()
	return nil
}

// SetLinks replaces this event's follow/tip links after server-side URL
// validation. Only absolute http(s) URLs are stored.
func (s *Store) SetLinks(links []Link) error {
	clean, err := normalizeLinks(links)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.meta.Links = clean
	if err := s.saveMetaLocked(); err != nil {
		return err
	}
	s.changed()
	return nil
}

// SetModerationMode preserves compatibility with older clients while keeping
// every event in post-moderation mode. DJs can still delete unwanted content.
func (s *Store) SetModerationMode(mode string) error {
	if !validModerationMode(mode) {
		return errors.New("unknown moderation mode")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.meta.ModerationMode = normalizeModerationMode(mode)
	if err := s.saveMetaLocked(); err != nil {
		return err
	}
	s.changed()
	return nil
}

// NormalizeSlug lowercases, keeps the Worker's EVENT_RE charset ([a-z0-9_.-])
// as-is, turns any run of UNSUPPORTED characters into a single hyphen, trims
// stray separators, and clips to 48 — yielding a value that always satisfies
// EVENT_RE, or "" when nothing usable remains. Kept in lockstep with the
// client-side normSlug() in web/dj.html so the preview matches what's stored.
func NormalizeSlug(raw string) string {
	raw = strings.ToLower(strings.TrimSpace(raw))
	var b strings.Builder
	lastDash := false
	for _, r := range raw {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '_' || r == '.' || r == '-' {
			b.WriteRune(r)
			lastDash = false
		} else if b.Len() > 0 && !lastDash {
			b.WriteByte('-') // a run of unsupported chars collapses to one hyphen
			lastDash = true
		}
	}
	out := strings.Trim(b.String(), "-._")
	if len(out) > 48 {
		out = strings.Trim(out[:48], "-._")
	}
	return out
}

// RecordingFiles lists this event's set recordings (recordings/set-*.aac) in
// PLAY order — the raw material a publish remuxes into one faststart .m4a.
func (s *Store) RecordingFiles() []string {
	s.mu.Lock()
	dir := filepath.Join(s.dir, "recordings")
	s.mu.Unlock()
	entries, _ := os.ReadDir(dir)
	var files []string
	for _, e := range entries {
		n := e.Name()
		if e.IsDir() || !strings.HasPrefix(n, "set-") || !strings.HasSuffix(n, ".aac") {
			continue
		}
		files = append(files, filepath.Join(dir, n))
	}
	// A plain lexical sort is WRONG: segment 1 is "set-<ts>.aac" and its
	// device-yank siblings are "set-<ts>-2.aac", "-3.aac". Because '-' (0x2D)
	// sorts before '.' (0x2E), the base segment would land LAST and the set
	// would play scrambled. Sort by (timestamp, segment#) instead — treating a
	// bare base file as segment 1. The timestamp itself contains a hyphen
	// (date-time), so parse structurally, not by the last '-'.
	sort.SliceStable(files, func(i, j int) bool {
		ti, si := recordingKey(filepath.Base(files[i]))
		tj, sj := recordingKey(filepath.Base(files[j]))
		if ti != tj {
			return ti < tj
		}
		return si < sj
	})
	return files
}

// LatestSetRecordings returns just the MOST RECENT set's files — the newest
// base "set-<ts>.aac" plus any device-yank segments sharing that <ts> — in play
// order. This is what a publish uploads: one set, NOT every set ever recorded
// in the event folder (each Go Live starts a fresh <ts>).
func (s *Store) LatestSetRecordings() []string {
	all := s.RecordingFiles() // play order: ts ascending, then segment
	if len(all) == 0 {
		return nil
	}
	lastTS, _ := recordingKey(filepath.Base(all[len(all)-1]))
	var out []string
	for _, f := range all {
		if ts, _ := recordingKey(filepath.Base(f)); ts == lastTS {
			out = append(out, f)
		}
	}
	return out
}

// recordingKey extracts (timestamp, segment#) from a recording filename.
// "set-20060102-150405.aac" -> ("20060102150405", 1);
// "set-20060102-150405-2.aac" -> ("20060102150405", 2).
func recordingKey(name string) (string, int) {
	core := strings.TrimSuffix(strings.TrimPrefix(name, "set-"), ".aac")
	parts := strings.Split(core, "-") // [date, time] or [date, time, N]
	seg := 1
	ts := core
	if len(parts) >= 2 {
		ts = parts[0] + parts[1]
		if len(parts) >= 3 {
			if n, err := strconv.Atoi(parts[len(parts)-1]); err == nil {
				seg = n
			}
		}
	}
	return ts, seg
}

// LastPublishedSig returns the signature of whatever was last published from
// this event (or ""). Used to skip auto-publishing a set that was already
// published (manually or by a prior auto).
func (s *Store) LastPublishedSig() string {
	s.mu.Lock()
	p := filepath.Join(s.dir, "recordings", ".published")
	s.mu.Unlock()
	data, err := os.ReadFile(p)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(data))
}

// SetPublishedSig records the signature of the just-published set.
func (s *Store) SetPublishedSig(sig string) {
	s.mu.Lock()
	p := filepath.Join(s.dir, "recordings", ".published")
	s.mu.Unlock()
	_ = os.WriteFile(p, []byte(sig), 0o644)
}

// Info describes one event folder for the console's event list.
type Info struct {
	Dir     string `json:"dir"` // folder name under baseDir
	Title   string `json:"title"`
	Starts  string `json:"starts,omitempty"`
	Posts   int    `json:"posts"`
	Media   int    `json:"media"`
	Current bool   `json:"current"`
}

// List enumerates every event folder, newest first (folder names sort by date).
func (s *Store) List() []Info {
	s.mu.Lock()
	base, cur := s.baseDir, s.dir
	s.mu.Unlock()
	entries, _ := os.ReadDir(base)
	var out []Info
	for i := len(entries) - 1; i >= 0; i-- {
		e := entries[i]
		if !e.IsDir() || strings.HasPrefix(e.Name(), ".") {
			continue
		}
		dir := filepath.Join(base, e.Name())
		info := Info{Dir: e.Name(), Title: "partyparty", Current: dir == cur}
		if data, err := os.ReadFile(filepath.Join(dir, "meta.json")); err == nil {
			var m Meta
			if json.Unmarshal(data, &m) == nil {
				if m.Title != "" {
					info.Title = m.Title
					if isLegacyAutoTitle(info.Title, e.Name()) {
						info.Title = "partyparty"
					}
				}
				info.Starts = m.Starts
			}
		}
		// Post/media counts by replaying the journal ops (files are small).
		if data, err := os.ReadFile(filepath.Join(dir, "posts.jsonl")); err == nil {
			alive := map[string]int{}
			for _, raw := range strings.Split(string(data), "\n") {
				var l line
				if json.Unmarshal([]byte(raw), &l) != nil {
					continue
				}
				switch {
				case l.Op == "post" && l.Post != nil:
					alive[l.Post.ID] = len(l.Post.Media)
				case l.Op == "delete":
					delete(alive, l.ID)
				}
			}
			info.Posts = len(alive)
			for _, m := range alive {
				info.Media += m
			}
		}
		out = append(out, info)
	}
	return out
}

// SwitchTo opens another existing event folder (the Partiful "your events"
// move — nothing is created or destroyed).
func (s *Store) SwitchTo(dirName string) error {
	if dirName == "" || dirName != filepath.Base(dirName) || strings.HasPrefix(dirName, ".") {
		return errors.New("bad event name")
	}
	s.mu.Lock()
	dir := filepath.Join(s.baseDir, dirName)
	s.mu.Unlock()
	if st, err := os.Stat(dir); err != nil || !st.IsDir() {
		return errors.New("no such event")
	}
	return s.use(dir)
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

// SaveMedia streams one uploaded file to the media dir and returns its entry.
// There is intentionally no app-level size cap: guests may post full-quality
// phone videos over the LAN, and the Mac should store the original bytes.
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
	n, err := io.Copy(f, r)
	f.Close()
	if err != nil {
		os.Remove(dst)
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

func thumbURL(id string) string { return "/media/thumb/" + id }

func thumbFileName(id string) string { return id + ".jpg" }

func validMediaID(id string) bool {
	return id != "" && id == filepath.Base(id) && !strings.HasPrefix(id, ".")
}

func (s *Store) thumbTargetPath(id string) (string, bool) {
	if !validMediaID(id) {
		return "", false
	}
	s.mu.Lock()
	p := filepath.Join(s.dir, "media", "thumbs", thumbFileName(id))
	s.mu.Unlock()
	return p, true
}

// ThumbPath resolves a thumbnail id to its file, refusing path escapes.
func (s *Store) ThumbPath(id string) (string, bool) {
	p, ok := s.thumbTargetPath(id)
	if !ok {
		return "", false
	}
	if st, err := os.Stat(p); err != nil || st.IsDir() {
		return "", false
	}
	return p, true
}

// SetMediaThumb records a generated thumbnail on every visible media entry
// using the append-only journal, then wakes feed long-polls.
func (s *Store) SetMediaThumb(mediaID string) error {
	if _, ok := s.ThumbPath(mediaID); !ok {
		return errors.New("no such thumbnail")
	}
	thumb := thumbURL(mediaID)
	s.mu.Lock()
	defer s.mu.Unlock()
	var hits []struct {
		p *Post
		i int
	}
	for _, p := range s.posts {
		if p.Deleted {
			continue
		}
		for i := range p.Media {
			if p.Media[i].ID == mediaID && p.Media[i].Thumb != thumb {
				hits = append(hits, struct {
					p *Post
					i int
				}{p: p, i: i})
			}
		}
	}
	if len(hits) == 0 {
		return nil
	}
	now := time.Now().UnixMilli()
	if err := s.appendLine(line{Op: "thumb", MediaID: mediaID, Thumb: thumb, TS: now}); err != nil {
		return err
	}
	for _, h := range hits {
		h.p.Media[h.i].Thumb = thumb
		if h.p.Act < now {
			h.p.Act = now
		}
	}
	s.changed()
	return nil
}

// AddPost validates, journals, and returns the stored post. The second return
// value is kept empty for source compatibility with older claim-link callers.
// Media entries are re-verified against files present in this event's media dir.
func (s *Store) AddPost(cid, author, emoji, text string, media []Media, dj bool) (*Post, string, error) {
	text = strings.TrimSpace(text)
	if len(text) > 2000 {
		text = text[:2000]
	}
	if text == "" && len(media) == 0 {
		return nil, "", errors.New("empty post")
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
		vm := Media{ID: m.ID, Type: typ, Name: name, Size: st.Size()}
		if _, ok := s.ThumbPath(m.ID); ok {
			vm.Thumb = thumbURL(m.ID)
		}
		verified = append(verified, vm)
	}
	p := &Post{
		ID: newID(), CID: cid,
		Author: clip(author, 40), Emoji: clip(emoji, 8), Text: text,
		Media: verified, DJ: dj,
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	// Stamp UNDER the lock: stamping outside let two concurrent posts journal
	// out of timestamp order, and a client cursor could then skip one forever.
	now := time.Now().UnixMilli()
	p.TS, p.Act = now, now
	if dj {
		p.State = StateApproved
	} else {
		p.State = initialState(s.meta.ModerationMode)
	}
	if err := s.appendLine(line{Op: "post", CID: cid, Post: p}); err != nil {
		return nil, "", err
	}
	s.posts = append(s.posts, p)
	s.byID[p.ID] = p
	if !dj && cid != "" {
		g, ok := s.guests[cid]
		if !ok {
			g = &Guest{Created: p.TS}
			s.guests[cid] = g
		}
		g.Pseudonym, g.Emoji = p.Author, p.Emoji // follow renames
		_ = s.saveGuestsLocked()
	}
	s.changed()
	return p, "", nil
}

// AddWebPost injects a post written by an OFF-LAN guest on the cloud event
// page into the room's feed — the wall is one shared party. Keyed by the cloud
// post id (CID "web:<id>", persisted in the journal) so the live check-in can
// hand us the same posts every beat without duplicates, and marked NoPublish
// so the after-set mirror never echoes it back to the cloud it came from.
// Returns whether the post was newly added.
func (s *Store) AddWebPost(webID, author, emoji, text string) (bool, error) {
	text = strings.TrimSpace(text)
	if webID == "" || text == "" {
		return false, nil
	}
	if len(text) > 2000 {
		text = text[:2000]
	}
	cid := "web:" + webID
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, p := range s.posts {
		if p.CID == cid {
			return false, nil // already in the room
		}
	}
	p := &Post{
		ID: newID(), CID: cid,
		Author: clip(author, 40), Emoji: clip(emoji, 8), Text: text,
		NoPublish: true,
	}
	now := time.Now().UnixMilli()
	p.TS, p.Act = now, now
	p.State = initialState(s.meta.ModerationMode)
	if err := s.appendLine(line{Op: "post", CID: cid, Post: p}); err != nil {
		return false, err
	}
	s.posts = append(s.posts, p)
	s.byID[p.ID] = p
	s.changed()
	return true, nil
}

// AddComment appends a reply under a post.
func (s *Store) AddComment(postID, cid, author, emoji, text string, dj bool) (*Comment, error) {
	text = strings.TrimSpace(text)
	if text == "" {
		return nil, errors.New("empty comment")
	}
	if len(text) > 1000 {
		text = text[:1000]
	}
	c := &Comment{
		ID: newID(), CID: cid,
		Author: clip(author, 40), Emoji: clip(emoji, 8), Text: text, DJ: dj,
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	c.TS = time.Now().UnixMilli() // under the lock — keeps Act monotonic across clients
	p, ok := s.byID[postID]
	if !ok || p.Deleted {
		return nil, errors.New("no such post")
	}
	if c.TS <= p.Act {
		c.TS = p.Act + 1
	}
	if len(p.Comments) >= 500 {
		return nil, errors.New("comment limit reached")
	}
	if dj {
		c.State = StateApproved
	} else {
		c.State = initialState(s.meta.ModerationMode)
	}
	if err := s.appendLine(line{Op: "comment", ID: postID, CID: cid, Comment: c}); err != nil {
		return nil, err
	}
	p.Comments = append(p.Comments, *c)
	if p.Act < c.TS {
		p.Act = c.TS
	}
	s.changed()
	return c, nil
}

// AddPostReaction records a lightweight emoji response without manufacturing a
// comment. Reactions are aggregate party signals; guest identities stay local.
func (s *Store) AddPostReaction(postID, reaction string) error {
	reaction = strings.TrimSpace(reaction)
	if !validPostReaction(reaction) {
		return errors.New("unknown reaction")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	p, ok := s.byID[postID]
	if !ok || p.Deleted {
		return errors.New("no such post")
	}
	now := time.Now().UnixMilli()
	if now <= p.Act {
		now = p.Act + 1
	}
	if err := s.appendLine(line{Op: "post-reaction", ID: postID, Reaction: reaction, TS: now}); err != nil {
		return err
	}
	if p.Reactions == nil {
		p.Reactions = map[string]int{}
	}
	p.Reactions[reaction]++
	p.Act = now
	s.changed()
	return nil
}

// SetPublish flags whether a post joins the future ONLINE page (DJ curation;
// party visibility is unaffected).
func (s *Store) SetPublish(postID string, on bool) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	p, ok := s.byID[postID]
	if !ok || p.Deleted {
		return errors.New("no such post")
	}
	if err := s.appendLine(line{Op: "publish", ID: postID, On: on}); err != nil {
		return err
	}
	p.NoPublish = !on
	s.changed()
	return nil
}

// SetPostState changes in-party moderation visibility. It is separate from
// NoPublish/SetPublish, which only curates the future online page.
func (s *Store) SetPostState(id, state string) error {
	if !validState(state) {
		return errors.New("unknown state")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	p, ok := s.byID[id]
	if !ok || p.Deleted {
		return errors.New("no such post")
	}
	now := time.Now().UnixMilli()
	if now <= p.Act {
		now = p.Act + 1
	}
	if err := s.appendLine(line{Op: "mod", ID: id, State: state, TS: now}); err != nil {
		return err
	}
	p.State = state
	p.Act = now
	s.changed()
	return nil
}

// SetCommentState changes moderation visibility for one reply.
func (s *Store) SetCommentState(postID, commentID, state string) error {
	if !validState(state) {
		return errors.New("unknown state")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	p, ok := s.byID[postID]
	if !ok || p.Deleted {
		return errors.New("no such post")
	}
	idx := -1
	for i := range p.Comments {
		if p.Comments[i].ID == commentID {
			idx = i
			break
		}
	}
	if idx < 0 {
		return errors.New("no such comment")
	}
	now := time.Now().UnixMilli()
	if now <= p.Act {
		now = p.Act + 1
	}
	if err := s.appendLine(line{Op: "mod", ID: postID, CommentID: commentID, State: state, TS: now}); err != nil {
		return err
	}
	p.Comments[idx].State = state
	p.Act = now
	s.changed()
	return nil
}

// DeleteComment removes one reply from a post. It is a hard moderation removal
// for the feed; the append-only journal preserves what happened.
func (s *Store) DeleteComment(postID, commentID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	p, ok := s.byID[postID]
	if !ok || p.Deleted {
		return errors.New("no such post")
	}
	idx := -1
	for i := range p.Comments {
		if p.Comments[i].ID == commentID {
			idx = i
			break
		}
	}
	if idx < 0 {
		return errors.New("no such comment")
	}
	now := time.Now().UnixMilli()
	if now <= p.Act {
		now = p.Act + 1
	}
	if err := s.appendLine(line{Op: "comment-delete", ID: postID, CommentID: commentID, TS: now}); err != nil {
		return err
	}
	p.Comments = append(p.Comments[:idx], p.Comments[idx+1:]...)
	p.Act = now
	s.changed()
	return nil
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
	s.changed()
	return nil
}

func (s *Store) mediaFileLocked(id string) (string, bool) {
	if !validMediaID(id) {
		return "", false
	}
	p := filepath.Join(s.dir, "media", id)
	rel, err := filepath.Rel(s.dir, p)
	if err != nil || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) {
		return "", false
	}
	return p, true
}

func (s *Store) thumbFileLocked(id string) (string, bool) {
	if !validMediaID(id) {
		return "", false
	}
	p := filepath.Join(s.dir, "media", "thumbs", thumbFileName(id))
	rel, err := filepath.Rel(s.dir, p)
	if err != nil || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) {
		return "", false
	}
	return p, true
}

// SetGuestProfile stores the name and emoji selected on the guest's phone.
func (s *Store) SetGuestProfile(cid, name, emoji string) error {
	cid = clip(strings.TrimSpace(cid), 64)
	name = clip(strings.TrimSpace(name), 40)
	emoji = clip(strings.TrimSpace(emoji), 8)
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
	g.Pseudonym = name
	g.Emoji = emoji
	return s.saveGuestsLocked()
}

// SetContact stores a guest's optional private email subscription; it is
// never exposed in the public feed.
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

// AddRequest stores one private song request for the DJ.
func (s *Store) AddRequest(cid, text, note, vibe string) (*Request, error) {
	text = clip(strings.TrimSpace(text), 200)
	note = clip(strings.TrimSpace(note), 240)
	vibe = strings.TrimSpace(vibe)
	if text == "" {
		return nil, errors.New("empty request")
	}
	if !ValidRequestVibe(vibe) {
		return nil, errors.New("unknown vibe")
	}
	req := &Request{
		ID: newID(), CID: cid, Text: text, Note: note, Vibe: vibe, State: RequestStateNew,
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	req.TS = time.Now().UnixMilli()
	if err := s.appendLine(line{Op: "request", ID: req.ID, CID: cid, Request: req}); err != nil {
		return nil, err
	}
	s.requests = append(s.requests, req)
	if s.byReqID == nil {
		s.byReqID = map[string]*Request{}
	}
	s.byReqID[req.ID] = req
	s.changed()
	return req, nil
}

// SetRequestState changes a DJ-only request queue item.
func (s *Store) SetRequestState(id, state string) error {
	if !validRequestState(state) {
		return errors.New("unknown request state")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	req, ok := s.byReqID[id]
	if !ok {
		return errors.New("no such request")
	}
	if err := s.appendLine(line{Op: "request-state", ID: id, State: state, TS: time.Now().UnixMilli()}); err != nil {
		return err
	}
	req.State = state
	s.changed()
	return nil
}

// ListRequests returns the DJ-only request queue, with starred items first and
// newest first within each group.
func (s *Store) ListRequests() []Request {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]Request, 0, len(s.requests))
	for _, req := range s.requests {
		if req == nil {
			continue
		}
		cp := *req
		cp.State = normalizeRequestState(cp.State)
		out = append(out, cp)
	}
	sort.SliceStable(out, func(i, j int) bool {
		is, js := out[i].State == RequestStateStarred, out[j].State == RequestStateStarred
		if is != js {
			return is
		}
		return out[i].TS > out[j].TS
	})
	return out
}

// SetCurrentTrack stores the DJ's manually shared now-playing track and rotates
// the previous current track into the recent history.
func (s *Store) SetCurrentTrack(title, artist, note string) (CurrentTrack, error) {
	tr := cleanTrack(CurrentTrack{
		Title:  title,
		Artist: artist,
		Note:   note,
		SetAt:  time.Now().UnixMilli(),
	})
	if tr.Title == "" {
		return CurrentTrack{}, errors.New("missing title")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.appendLine(line{Op: "track-current", Track: &tr, TS: tr.SetAt}); err != nil {
		return CurrentTrack{}, err
	}
	s.rotateTrackLocked()
	s.currentTrack = &tr
	s.changed()
	return tr, nil
}

// ClearCurrentTrack removes the public now-playing slot, keeping the last track
// in the recent list.
func (s *Store) ClearCurrentTrack() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.currentTrack == nil || s.currentTrack.Title == "" {
		return nil
	}
	if err := s.appendLine(line{Op: "track-clear", TS: time.Now().UnixMilli()}); err != nil {
		return err
	}
	s.rotateTrackLocked()
	s.currentTrack = nil
	s.changed()
	return nil
}

func (s *Store) rotateTrackLocked() {
	if s.currentTrack == nil || s.currentTrack.Title == "" {
		return
	}
	s.recentTracks = append([]CurrentTrack{*s.currentTrack}, s.recentTracks...)
	if len(s.recentTracks) > trackHistoryLimit {
		s.recentTracks = s.recentTracks[:trackHistoryLimit]
	}
}

// TrackSnapshot returns copies of now-playing and the capped recent history.
func (s *Store) TrackSnapshot() (*CurrentTrack, []CurrentTrack) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var current *CurrentTrack
	if s.currentTrack != nil && s.currentTrack.Title != "" {
		cp := *s.currentTrack
		current = &cp
	}
	recent := make([]CurrentTrack, len(s.recentTracks))
	copy(recent, s.recentTracks)
	return current, recent
}

func cleanTrack(tr CurrentTrack) CurrentTrack {
	tr.Title = clip(strings.TrimSpace(tr.Title), 120)
	tr.Artist = clip(strings.TrimSpace(tr.Artist), 120)
	tr.Note = clip(strings.TrimSpace(tr.Note), 240)
	if tr.Title == "" {
		return CurrentTrack{}
	}
	if tr.SetAt <= 0 {
		tr.SetAt = time.Now().UnixMilli()
	}
	return tr
}

func (s *Store) saveGuestsLocked() error {
	data, err := json.MarshalIndent(s.guests, "", " ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(s.dir, "guests.json"), data, 0o600)
}

// AddTrackAsk records one guest "what's this track?" tap in a rolling window.
func (s *Store) AddTrackAsk() {
	now := time.Now().UnixMilli()
	cutoff := now - trackAskWindow.Milliseconds()

	s.mu.Lock()
	s.trackAsks = append(pruneReactionHits(s.trackAsks, cutoff), now)
	s.mu.Unlock()

	s.changed()
}

// TrackAskCount returns the current rolling "what's this track?" count.
func (s *Store) TrackAskCount() int {
	now := time.Now().UnixMilli()
	cutoff := now - trackAskWindow.Milliseconds()

	s.mu.Lock()
	defer s.mu.Unlock()
	s.trackAsks = pruneReactionHits(s.trackAsks, cutoff)
	return len(s.trackAsks)
}

// AddReaction records one anonymous crowd-telemetry tap in memory. Reactions
// are deliberately not wall posts; the live feed consumes only aggregates.
func (s *Store) AddReaction(kind string) error {
	kind = strings.TrimSpace(kind)
	if !ValidReactionType(kind) {
		return errors.New("unknown reaction")
	}
	now := time.Now().UnixMilli()
	cutoff := now - reactionWindow.Milliseconds()

	s.mu.Lock()
	if s.reactions == nil {
		s.reactions = newReactionCounters()
	}
	c := s.reactions[kind]
	if c == nil {
		c = &reactionCounter{}
		s.reactions[kind] = c
	}
	c.Total++
	c.Hits = append(pruneReactionHits(c.Hits, cutoff), now)
	s.mu.Unlock()

	s.changed()
	return nil
}

// ReactionSnapshot returns the current last-60s counts and a sparse spike map.
// Totals are retained in memory for later recap use, but the live payload stays
// small and focused on what the DJ can act on right now.
func (s *Store) ReactionSnapshot() (map[string]int, map[string]int) {
	now := time.Now().UnixMilli()
	cutoff := now - reactionWindow.Milliseconds()
	counts := make(map[string]int, len(reactionTypes))
	spikes := map[string]int{}

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.reactions == nil {
		s.reactions = newReactionCounters()
	}
	for _, kind := range reactionTypes {
		c := s.reactions[kind]
		if c == nil {
			c = &reactionCounter{}
			s.reactions[kind] = c
		}
		c.Hits = pruneReactionHits(c.Hits, cutoff)
		n := len(c.Hits)
		counts[kind] = n
		if n >= reactionSpikeThreshold {
			spikes[kind] = n
		}
	}
	return counts, spikes
}

func pruneReactionHits(hits []int64, cutoff int64) []int64 {
	i := 0
	for i < len(hits) && hits[i] < cutoff {
		i++
	}
	if i == 0 {
		return hits
	}
	return append(hits[:0], hits[i:]...)
}

// Feed returns non-deleted posts with activity newer than sinceTS (0 = all),
// oldest first, plus all non-deleted ids and counts. Activity (not creation)
// is the cursor so a comment on an old post syncs to every client.
func (s *Store) Feed(sinceTS int64) (posts []Post, ids []string, mediaCount int) {
	posts, ids, mediaCount, _ = s.FeedFor(sinceTS, "", true)
	return posts, ids, mediaCount
}

// FeedFor returns the caller-visible feed. All new content is approved
// immediately; hidden legacy content remains visible only to DJs. Cursor
// advances across every non-deleted activity, including filtered items, so
// clients do not re-request the same window forever.
func (s *Store) FeedFor(sinceTS int64, cid string, dj bool) (posts []Post, ids []string, mediaCount int, cursor int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	ids = []string{}
	for _, p := range s.posts {
		if p.Deleted {
			continue
		}
		if p.Act > cursor {
			cursor = p.Act
		}
		if !postVisibleTo(p, cid, dj) {
			continue
		}
		cp := *p
		cp.State = normalizeState(cp.State)
		cp.Comments = visibleComments(p.Comments, cid, dj)
		if len(p.Reactions) > 0 {
			cp.Reactions = make(map[string]int, len(p.Reactions))
			for reaction, count := range p.Reactions {
				cp.Reactions[reaction] = count
			}
		}
		ids = append(ids, cp.ID)
		mediaCount += len(cp.Media)
		if cp.Act > sinceTS {
			posts = append(posts, cp)
		}
	}
	sort.Slice(posts, func(i, j int) bool { return posts[i].TS < posts[j].TS })
	return posts, ids, mediaCount, cursor
}

// MediaTypeCounts returns visible media totals for feed headings.
func (s *Store) MediaTypeCounts(cid string, dj bool) (photos, videos, audio int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, p := range s.posts {
		if p.Deleted || !postVisibleTo(p, cid, dj) {
			continue
		}
		for _, media := range p.Media {
			switch media.Type {
			case "image":
				photos++
			case "video":
				videos++
			case "audio":
				audio++
			}
		}
	}
	return photos, videos, audio
}

func postVisibleTo(p *Post, cid string, dj bool) bool {
	if dj {
		return true
	}
	switch normalizeState(p.State) {
	case StateApproved:
		return true
	case StatePending:
		return cid != "" && p.CID == cid
	default:
		return false
	}
}

func visibleComments(comments []Comment, cid string, dj bool) []Comment {
	if len(comments) == 0 {
		return nil
	}
	out := make([]Comment, 0, len(comments))
	for _, c := range comments {
		state := normalizeState(c.State)
		if !dj {
			if state == StateHidden {
				continue
			}
			if state == StatePending && (cid == "" || c.CID != cid) {
				continue
			}
		}
		c.State = state
		out = append(out, c)
	}
	return out
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
