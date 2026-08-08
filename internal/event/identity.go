package event

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// The DJ's identity outlives any one party. Events rotate per calendar day, so
// everything stored only in an event's meta.json vanished at midnight: name,
// bio, social links, photo, even the party's own name and cover. A DJ who set
// all of it up yesterday opened a blank console today (2026-08-06).
//
// Identity therefore lives beside the events directory, is written through on
// every change, and seeds each newly created event. The event still owns what
// is genuinely per-party: the feed, photos, guests, setlist.

type djIdentity struct {
	Host   string `json:"host,omitempty"`
	Bio    string `json:"bio,omitempty"`
	Links  []Link `json:"links,omitempty"`
	Avatar string `json:"avatar,omitempty"` // file name beside this file, "" = none
	Title  string `json:"title,omitempty"`
	Cover  string `json:"cover,omitempty"`

	// The @name on the platform, and when this profile last changed. Neither is
	// derived from an event: the handle is minted by the platform and the stamp
	// is what decides, when a Mac and the web disagree, which one is stale.
	// AvatarURL is the platform picture already taken, so an unchanged photo is
	// not downloaded again on every tick.
	Handle    string `json:"handle,omitempty"`
	ProfileMs int64  `json:"profileMs,omitempty"`
	AvatarURL string `json:"avatarUrl,omitempty"`
}

// placeholderHost is the stand-in a fresh event carries until the DJ names
// themselves; it must never look like a set identity to the seeder or get
// written out as one.
const placeholderHost = "the DJ"

func realHost(h string) string {
	if h == placeholderHost {
		return ""
	}
	return h
}

func (d djIdentity) empty() bool {
	return d.Host == "" && d.Bio == "" && len(d.Links) == 0 &&
		d.Avatar == "" && d.Title == "" && d.Cover == ""
}

// identityPath is <state>/dj-profile.json - a sibling of the events directory,
// never inside a dated event folder.
func identityPath(base string) string {
	if base == "" {
		return ""
	}
	return filepath.Join(filepath.Dir(base), "dj-profile.json")
}

func identityAvatarPath(base, name string) string {
	if base == "" || name == "" {
		return ""
	}
	return filepath.Join(filepath.Dir(base), name)
}

func loadIdentity(base string) (djIdentity, bool) {
	path := identityPath(base)
	if path == "" {
		return djIdentity{}, false
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return djIdentity{}, false
	}
	var id djIdentity
	if json.Unmarshal(data, &id) != nil {
		return djIdentity{}, false
	}
	return id, true
}

func writeIdentity(base string, id djIdentity) error {
	path := identityPath(base)
	if path == "" {
		return nil
	}
	data, err := json.MarshalIndent(id, "", " ")
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, append(data, '\n'), 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// eventAvatarFileLocked returns the current event's profile photo, if any.
func (s *Store) eventAvatarFileLocked() (path string, ext string, ok bool) {
	entries, err := os.ReadDir(dataDir(s.dir))
	if err != nil {
		return "", "", false
	}
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || !strings.HasPrefix(name, "profile.") {
			continue
		}
		return dataPath(s.dir, name), filepath.Ext(name), true
	}
	return "", "", false
}

// saveIdentityLocked mirrors the identity fields of the current event out to
// the durable file. Callers hold s.mu; failures are not fatal to the edit that
// triggered them - the event's own meta.json is still the live truth.
func (s *Store) saveIdentityLocked() {
	if s.base == "" {
		return
	}
	id := djIdentity{
		Host:  realHost(s.meta.Host),
		Bio:   s.meta.Bio,
		Links: s.meta.Links,
		Title: s.meta.Title,
		Cover: s.meta.Cover,
	}
	// The handle and the stamp are not derived from the event, so a write
	// triggered by a cover change must carry them across rather than blank
	// them. Losing the stamp would make every local profile look brand new and
	// let the Mac overwrite the web on the next tick.
	if prev, ok := loadIdentity(s.base); ok {
		id.Handle, id.ProfileMs, id.AvatarURL = prev.Handle, prev.ProfileMs, prev.AvatarURL
	}
	if src, ext, ok := s.eventAvatarFileLocked(); ok && s.meta.Avatar == "/dj-avatar" {
		name := "dj-avatar" + ext
		if data, err := os.ReadFile(src); err == nil {
			if os.WriteFile(identityAvatarPath(s.base, name), data, 0o644) == nil {
				id.Avatar = name
			}
		}
	} else if s.meta.Avatar == "" {
		// A removed photo must not come back on the next event.
		if prev, ok := loadIdentity(s.base); ok && prev.Avatar != "" {
			_ = os.Remove(identityAvatarPath(s.base, prev.Avatar))
		}
	}
	_ = writeIdentity(s.base, id)
}

// seedFromIdentity fills a newly created event with the DJ's durable identity.
// Only empty fields are touched, so a resumed event is never overwritten.
func (s *Store) seedFromIdentity() {
	if s.base == "" {
		return
	}
	id, ok := loadIdentity(s.base)
	if !ok || id.empty() {
		// First run after the fix: recover the identity from the most recent
		// event that has one, so a DJ who set it up before today gets it back
		// instead of a blank console.
		id = identityFromRecentEvents(s.base, s.dir)
		if id.empty() {
			return
		}
		_ = writeIdentity(s.base, id)
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	changed := false
	if realHost(s.meta.Host) == "" && id.Host != "" {
		s.meta.Host, changed = id.Host, true
	}
	if s.meta.Bio == "" && id.Bio != "" {
		s.meta.Bio, changed = id.Bio, true
	}
	if len(s.meta.Links) == 0 && len(id.Links) > 0 {
		s.meta.Links, changed = id.Links, true
	}
	if s.meta.Title == "" && id.Title != "" {
		s.meta.Title, changed = id.Title, true
	}
	if s.meta.Cover == "" && id.Cover != "" {
		s.meta.Cover, changed = id.Cover, true
	}
	if s.meta.Avatar == "" && id.Avatar != "" {
		if data, err := os.ReadFile(identityAvatarPath(s.base, id.Avatar)); err == nil {
			dst := dataPath(s.dir, "profile"+filepath.Ext(id.Avatar))
			if os.WriteFile(dst, data, 0o644) == nil {
				s.meta.Avatar, changed = "/dj-avatar", true
			}
		}
	}
	if changed {
		_ = s.saveMetaLocked()
	}
}

// identityFromRecentEvents scans event folders newest-first for a usable
// identity. Folder names are dates, so a plain reverse sort is newest-first.
func identityFromRecentEvents(base, skip string) djIdentity {
	entries, err := os.ReadDir(base)
	if err != nil {
		return djIdentity{}
	}
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() {
			names = append(names, entry.Name())
		}
	}
	sort.Sort(sort.Reverse(sort.StringSlice(names)))
	for _, name := range names {
		dir := filepath.Join(base, name)
		if dir == skip {
			continue
		}
		data, err := os.ReadFile(dataPath(dir, "meta.json"))
		if err != nil {
			if !errors.Is(err, os.ErrNotExist) {
				continue
			}
			continue
		}
		var m Meta
		if json.Unmarshal(data, &m) != nil {
			continue
		}
		id := djIdentity{Host: realHost(m.Host), Bio: m.Bio, Links: m.Links, Title: m.Title, Cover: m.Cover}
		if m.Avatar == "/dj-avatar" {
			if src, ext, ok := avatarFileIn(dir); ok {
				avatarName := "dj-avatar" + ext
				if body, err := os.ReadFile(src); err == nil {
					if os.WriteFile(identityAvatarPath(base, avatarName), body, 0o644) == nil {
						id.Avatar = avatarName
					}
				}
			}
		}
		if !id.empty() {
			return id
		}
	}
	return djIdentity{}
}

func avatarFileIn(dir string) (path string, ext string, ok bool) {
	entries, err := os.ReadDir(dataDir(dir))
	if err != nil {
		return "", "", false
	}
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || !strings.HasPrefix(name, "profile.") {
			continue
		}
		return dataPath(dir, name), filepath.Ext(name), true
	}
	return "", "", false
}
