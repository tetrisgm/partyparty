package event

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// A party is one night, not one calendar day.
//
// Storage used to rotate on the date the app happened to LAUNCH, which is
// neither when a party starts nor when it ends: a set that crossed midnight
// split in two, and a relaunch the next morning opened a blank console
// (2026-08-06). A party now has an id, is resumed while it is still the
// current one, and ends by going idle.
//
// The folder is also a deliverable, not a database: what a DJ opens is the
// night's photos and videos plus an index.html of the wall. Everything the app
// needs to run - the journal, guest names, the setlist, thumbnails - lives in
// a hidden .state directory inside the party.

// partyIdleWindow: a party stays current until this long after its last
// activity. Long enough that a laptop lid, a set break, or a crash resumes the
// same night; short enough that tomorrow's party is its own.
const partyIdleWindow = 8 * time.Hour

// currentFile records which party is open, so a relaunch rejoins it.
const currentFile = "current.json"

type currentParty struct {
	ID       string `json:"id"`
	LastSeen int64  `json:"lastSeenAt"`
}

// newPartyID is sortable, human-readable in Finder, and unique enough to be
// adopted by another Mac joining the same party.
func newPartyID(now time.Time) string {
	b := make([]byte, 2)
	_, _ = rand.Read(b)
	return now.Format("2006-01-02-1504") + "-" + hex.EncodeToString(b)
}

func currentPath(base string) string { return filepath.Join(base, currentFile) }

func readCurrent(base string) (currentParty, bool) {
	data, err := os.ReadFile(currentPath(base))
	if err != nil {
		return currentParty{}, false
	}
	var c currentParty
	if json.Unmarshal(data, &c) != nil || c.ID == "" {
		return currentParty{}, false
	}
	return c, true
}

func writeCurrent(base, id string) {
	data, err := json.Marshal(currentParty{ID: id, LastSeen: time.Now().UnixMilli()})
	if err != nil {
		return
	}
	tmp := currentPath(base) + ".tmp"
	if os.WriteFile(tmp, append(data, '\n'), 0o644) == nil {
		_ = os.Rename(tmp, currentPath(base))
	}
}

// partyIsEmpty reports whether nothing has happened in a party yet. An empty
// current party is reused instead of leaving a litter of folders behind every
// time the app is opened and closed.
func partyIsEmpty(dir string) bool {
	if _, err := os.Stat(dataPath(dir, "posts.jsonl")); err == nil {
		return false
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return true
	}
	for _, entry := range entries {
		name := entry.Name()
		if strings.HasPrefix(name, ".") || name == recapFile {
			continue
		}
		return false // a guest upload lives here
	}
	return true
}

// chooseParty resumes the current party when it is still this night's, and
// otherwise starts a new one.
func chooseParty(base string, now time.Time) string {
	if c, ok := readCurrent(base); ok {
		dir := filepath.Join(base, c.ID)
		if st, err := os.Stat(dir); err == nil && st.IsDir() {
			fresh := now.Sub(time.UnixMilli(c.LastSeen)) < partyIdleWindow
			if fresh || partyIsEmpty(dir) {
				return c.ID
			}
		}
	}
	return newPartyID(now)
}

// StatePath is where callers put party machinery that is not a keepsake - it
// stays out of the folder a DJ opens.
func (s *Store) StatePath(name string) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.dir == "" {
		return ""
	}
	return dataPath(s.dir, name)
}

// PartyID is the id of the open party.
func (s *Store) PartyID() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return filepath.Base(s.dir)
}

// TouchParty marks the open party as still current. Called when a set starts,
// so an idle window is measured from real activity rather than app launch.
func (s *Store) TouchParty() {
	s.mu.Lock()
	base, id := s.base, filepath.Base(s.dir)
	s.mu.Unlock()
	if base != "" && id != "" {
		writeCurrent(base, id)
	}
}

// PastParties lists finished parties, newest first, for anything that wants to
// look back (a recap browser, a future archive view).
func PastParties(base string) []string {
	entries, err := os.ReadDir(base)
	if err != nil {
		return nil
	}
	var ids []string
	for _, entry := range entries {
		if entry.IsDir() && !strings.HasPrefix(entry.Name(), ".") {
			ids = append(ids, entry.Name())
		}
	}
	sort.Sort(sort.Reverse(sort.StringSlice(ids)))
	return ids
}

// migrateEventsRoot moves pre-party event folders (events/<date>/) into the
// parties root, keeping every byte: the journal and friends land in .state,
// guest uploads move to the party's top level, and old set recordings are
// tucked out of sight rather than deleted - they are the DJ's audio, not ours
// to throw away.
func migrateEventsRoot(base string) error {
	old := filepath.Join(filepath.Dir(base), "events")
	entries, err := os.ReadDir(old)
	if err != nil {
		return nil // nothing to migrate
	}
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		src := filepath.Join(old, entry.Name())
		dst := filepath.Join(base, entry.Name())
		if _, err := os.Stat(dst); err == nil {
			continue // already migrated
		}
		if err := os.MkdirAll(dataDir(dst), 0o755); err != nil {
			return err
		}
		if err := moveInto(filepath.Join(src, "data"), dataDir(dst)); err != nil {
			return err
		}
		if err := moveInto(filepath.Join(src, "media", "thumbs"), filepath.Join(dataDir(dst), "thumbs")); err != nil {
			return err
		}
		if err := moveInto(filepath.Join(src, "media"), dst); err != nil {
			return err
		}
		if err := moveInto(filepath.Join(src, "recordings"), filepath.Join(dataDir(dst), "old-recordings")); err != nil {
			return err
		}
		// Loose files from the pre-data/ era.
		if err := moveInto(src, dataDir(dst)); err != nil {
			return err
		}
		_ = os.RemoveAll(src) // empty by now; contents were moved, not copied
	}
	_ = os.Remove(old) // only succeeds once it is empty
	return nil
}

// moveInto moves every file in src into dst, creating dst as needed. Missing
// src is not an error: these are optional legacy shapes.
func moveInto(src, dst string) error {
	entries, err := os.ReadDir(src)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	}
	var made bool
	for _, entry := range entries {
		if entry.IsDir() {
			continue // handled explicitly by the caller
		}
		if !made {
			if err := os.MkdirAll(dst, 0o755); err != nil {
				return err
			}
			made = true
		}
		from := filepath.Join(src, entry.Name())
		to := filepath.Join(dst, entry.Name())
		if _, err := os.Stat(to); err == nil {
			continue
		}
		if err := os.Rename(from, to); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	return nil
}
