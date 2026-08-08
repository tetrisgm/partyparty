package event

import (
	"encoding/json"
	"os"
	"strings"
)

// Which canonical party this Mac's live room belongs to.
//
// The party is the permanent record and it lives on the platform, the same row
// the web renders. What sits here is only the pointer: which party this room is
// currently running, so a broadcast attaches to something that already exists
// instead of minting a second one. Ending a broadcast clears nothing - the
// pointer is how the console still knows, tomorrow, which party last night was.
//
// Stored beside the party folder rather than inside meta.json because it
// belongs to the LIVE session's relationship with the account, not to the
// keepsake.

type CanonicalParty struct {
	Key      string `json:"key"`      // the platform's id for the party
	Slug     string `json:"slug"`     // its address under the group
	Title    string `json:"title"`    // last known, for showing offline
	URL      string `json:"url"`      // the page a guest opens
	Handle   string `json:"handle"`   // the group it belongs to
	StartsMs int64  `json:"startsMs"` // when it is, as the record says
	Place    string `json:"place"`
}

func canonicalPath(dir string) string {
	if dir == "" {
		return ""
	}
	return dataPath(dir, "canonical.json")
}

// Canonical reports the platform party this room is running, if any.
func (s *Store) Canonical() CanonicalParty {
	s.mu.Lock()
	path := canonicalPath(s.dir)
	s.mu.Unlock()
	if path == "" {
		return CanonicalParty{}
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return CanonicalParty{}
	}
	var out CanonicalParty
	if json.Unmarshal(data, &out) != nil {
		return CanonicalParty{}
	}
	return out
}

// SetCanonical records which platform party this room is running, and mirrors
// its name onto the local meta so the console and the guest page agree with the
// web immediately rather than after the next sync.
func (s *Store) SetCanonical(p CanonicalParty) error {
	s.mu.Lock()
	path := canonicalPath(s.dir)
	s.mu.Unlock()
	if path == "" {
		return nil
	}
	data, err := json.MarshalIndent(p, "", " ")
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, append(data, '\n'), 0o644); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		return err
	}
	if title := strings.TrimSpace(p.Title); title != "" {
		// SetMeta keeps the current value for an empty field, so this moves the
		// title and leaves everything else where it is.
		return s.SetMeta(title, "", "")
	}
	return nil
}

// ClearCanonical forgets the pointer. Used when a room is deliberately detached
// from its party - never when a broadcast merely ends.
func (s *Store) ClearCanonical() error {
	s.mu.Lock()
	path := canonicalPath(s.dir)
	s.mu.Unlock()
	if path == "" {
		return nil
	}
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}
