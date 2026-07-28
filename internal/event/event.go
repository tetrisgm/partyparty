// Package event stores the active room's feed, media, and set recording on the
// Mac. Optional guest contact information remains private.
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
	URL   string `json:"url,omitempty"`   // absolute URL when federated from another Mac
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
// pseudonym leaves the server in feed responses.
type Post struct {
	ID  string `json:"id"`
	TS  int64  `json:"ts"`  // unix millis (creation)
	Act int64  `json:"act"` // last activity (creation/comment) - the feed cursor,
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
	Title      string `json:"title"`
	Artist     string `json:"artist,omitempty"`
	ArtworkURL string `json:"artworkUrl,omitempty"`
	Note       string `json:"note,omitempty"`
	MatchID    string `json:"matchId,omitempty"`
	SetAt      int64  `json:"setAt"`
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
	MediaID   string        `json:"mediaId,omitempty"`
	Thumb     string        `json:"thumb,omitempty"`
	TS        int64         `json:"ts,omitempty"`
}

// Guest is the private per-guest record (guests.json, DJ-only). It captures
// only the party identity chosen on the phone.
type Guest struct {
	Pseudonym string `json:"pseudonym"`
	Emoji     string `json:"emoji"`
	Created   int64  `json:"createdAt"` // unix millis
}

// Meta is the active room identity shown to guests and edited by the DJ.
type Meta struct {
	Title    string          `json:"title"`
	Host     string          `json:"host"`
	Starts   string          `json:"starts,omitempty"`
	Date     string          `json:"date,omitempty"`
	Time     string          `json:"time,omitempty"`
	Place    string          `json:"place,omitempty"`
	Cover    string          `json:"cover,omitempty"`
	Features map[string]bool `json:"features,omitempty"`
	Links    []Link          `json:"links,omitempty"`
}

type Link struct {
	Label string `json:"label"`
	URL   string `json:"url"`
	Type  string `json:"type"`
}

const (
	StateApproved = "approved"
	StateHidden   = "hidden"

	RequestStateNew       = "new"
	RequestStateDone      = "done"
	RequestStateDismissed = "dismissed"
	RequestStateStarred   = "starred"
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

func normalizeState(state string) string {
	switch state {
	case StateHidden:
		return state
	default:
		return StateApproved
	}
}

func validState(state string) bool {
	return state == StateApproved || state == StateHidden
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
	mu            sync.Mutex
	dir           string
	meta          Meta
	posts         []*Post
	byID          map[string]*Post
	requests      []*Request
	byReqID       map[string]*Request
	guests        map[string]*Guest // cid -> guest - PRIVATE, never in feed responses
	reactions     map[string]*reactionCounter
	currentTrack  *CurrentTrack
	recentTracks  []CurrentTrack
	setlistTracks []CurrentTrack
	trackAsks     []int64
	thumbQ        chan thumbJob
	thumbOnce     sync.Once

	// Long-poll wakeup: closed and replaced on every visible mutation, so
	// /api/feed?wait=1 can hold requests and answer the INSTANT something
	// happens - the wall feels realtime without a 1s hammering interval.
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

// Open uses one active room per calendar day, so an app restart mid-party
// lands back in the same feed without exposing a previous-room picker.
func Open(baseDir string) (*Store, error) {
	if err := os.MkdirAll(baseDir, 0o755); err != nil {
		return nil, err
	}
	dir := filepath.Join(baseDir, time.Now().Format("2006-01-02"))
	s := &Store{notify: make(chan struct{})}
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
	for _, sub := range []string{"", "media", filepath.Join("media", "thumbs"), "recordings"} {
		if err := os.MkdirAll(filepath.Join(dir, sub), 0o755); err != nil {
			return err
		}
	}
	posts, byID := []*Post{}, map[string]*Post{}
	requests, byReqID := []*Request{}, map[string]*Request{}
	var currentTrack *CurrentTrack
	recentTracks := []CurrentTrack{}
	setlistTracks := []CurrentTrack{}
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
					setlistTracks = append(setlistTracks, *currentTrack)
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
					setlistTracks = append(setlistTracks, *currentTrack)
					if len(recentTracks) > trackHistoryLimit {
						recentTracks = recentTracks[:trackHistoryLimit]
					}
				}
				currentTrack = nil
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
	meta := Meta{Title: "partyparty", Host: "the DJ"}
	if data, err := os.ReadFile(filepath.Join(dir, "meta.json")); err == nil {
		_ = json.Unmarshal(data, &meta)
	}
	meta.Features = normalizeFeatures(meta.Features)
	meta.Links, _ = normalizeLinks(meta.Links)
	meta.Cover = normalizeCoverRef(meta.Cover)
	s.mu.Lock()
	s.dir, s.posts, s.byID, s.requests, s.byReqID, s.guests, s.meta, s.reactions = dir, posts, byID, requests, byReqID, guests, meta, newReactionCounters()
	s.currentTrack, s.recentTracks, s.setlistTracks, s.trackAsks = currentTrack, recentTracks, setlistTracks, nil
	_ = s.writeSetlistLocked()
	s.mu.Unlock()
	s.changed()
	return nil
}

// Meta returns the active room identity.
func (s *Store) Meta() Meta {
	s.mu.Lock()
	defer s.mu.Unlock()
	m := s.meta
	m.Features = normalizeFeatures(s.meta.Features)
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
	mediaDir := filepath.Join(s.dir, "media")
	dst := filepath.Join(mediaDir, id)
	s.mu.Unlock()
	f, err := os.CreateTemp(mediaDir, ".upload-*"+ext)
	if err != nil {
		return Media{}, err
	}
	tmp := f.Name()
	defer os.Remove(tmp)
	n, err := io.Copy(f, r)
	if err != nil {
		f.Close()
		return Media{}, err
	}
	if err := f.Chmod(0o644); err != nil {
		f.Close()
		return Media{}, err
	}
	if err := f.Close(); err != nil {
		return Media{}, err
	}
	// Link publishes the completed inode atomically without overwriting the
	// astronomically unlikely case of a colliding generated media ID.
	if err := os.Link(tmp, dst); err != nil {
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

// AddPost validates, journals, and returns the stored post.
// Media entries are re-verified against files present in this event's media dir.
func (s *Store) AddPost(cid, author, emoji, text string, media []Media, dj bool) (*Post, error) {
	text = strings.TrimSpace(text)
	if len(text) > 2000 {
		text = text[:2000]
	}
	if text == "" && len(media) == 0 {
		return nil, errors.New("empty post")
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
		p.State = StateApproved
	}
	if err := s.appendLine(line{Op: "post", CID: cid, Post: p}); err != nil {
		return nil, err
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
	return p, nil
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
	c.TS = time.Now().UnixMilli() // under the lock - keeps Act monotonic across clients
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
		c.State = StateApproved
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

// SetPostState changes in-party moderation visibility.
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

// Delete tombstones a post (DJ moderation). Media files stay on disk - the
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
	_ = s.writeSetlistLocked()
	s.changed()
	return tr, nil
}

// SetRecognizedTrack stores a Shazam catalog match. Repeated callbacks for the
// same catalog item are idempotent and do not create duplicate set-list rows.
func (s *Store) SetRecognizedTrack(matchID, title, artist, artworkURL string) (CurrentTrack, bool, error) {
	tr := cleanTrack(CurrentTrack{
		Title: title, Artist: artist, ArtworkURL: artworkURL, MatchID: strings.TrimSpace(matchID),
		SetAt: time.Now().UnixMilli(),
	})
	if tr.Title == "" {
		return CurrentTrack{}, false, errors.New("missing title")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.currentTrack != nil && tr.MatchID != "" && s.currentTrack.MatchID == tr.MatchID {
		return *s.currentTrack, false, nil
	}
	if err := s.appendLine(line{Op: "track-current", Track: &tr, TS: tr.SetAt}); err != nil {
		return CurrentTrack{}, false, err
	}
	s.rotateTrackLocked()
	s.currentTrack = &tr
	_ = s.writeSetlistLocked()
	s.changed()
	return tr, true, nil
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
	_ = s.writeSetlistLocked()
	s.changed()
	return nil
}

func (s *Store) rotateTrackLocked() {
	if s.currentTrack == nil || s.currentTrack.Title == "" {
		return
	}
	s.recentTracks = append([]CurrentTrack{*s.currentTrack}, s.recentTracks...)
	s.setlistTracks = append(s.setlistTracks, *s.currentTrack)
	if len(s.recentTracks) > trackHistoryLimit {
		s.recentTracks = s.recentTracks[:trackHistoryLimit]
	}
}

func (s *Store) writeSetlistLocked() error {
	tracks := append([]CurrentTrack(nil), s.setlistTracks...)
	if s.currentTrack != nil && s.currentTrack.Title != "" {
		tracks = append(tracks, *s.currentTrack)
	}
	var out strings.Builder
	out.WriteString("PartyParty set list\n\n")
	for _, tr := range tracks {
		when := time.UnixMilli(tr.SetAt).Format("15:04")
		if tr.Artist != "" {
			fmt.Fprintf(&out, "%s  %s - %s\n", when, tr.Artist, tr.Title)
		} else {
			fmt.Fprintf(&out, "%s  %s\n", when, tr.Title)
		}
	}
	path := filepath.Join(s.dir, "setlist.txt")
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, []byte(out.String()), 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
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
	tr.ArtworkURL = clip(strings.TrimSpace(tr.ArtworkURL), 1000)
	if tr.ArtworkURL != "" {
		u, err := url.Parse(tr.ArtworkURL)
		if err != nil || u.Scheme != "https" || u.Host == "" {
			tr.ArtworkURL = ""
		}
	}
	tr.Note = clip(strings.TrimSpace(tr.Note), 240)
	tr.MatchID = clip(strings.TrimSpace(tr.MatchID), 160)
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
// The live payload stays small and focused on what the DJ can act on now.
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
		if legacyStreamStatusPost(p) {
			continue
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

func legacyStreamStatusPost(p *Post) bool {
	if p == nil || p.CID != "dj" || !p.DJ || p.Emoji != "🎧" || len(p.Media) != 0 || len(p.Comments) != 0 {
		return false
	}
	return p.Text == "Started the stream." || p.Text == "Stopped the stream."
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
