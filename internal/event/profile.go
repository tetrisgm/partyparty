package event

import (
	"bytes"
	"os"
	"strings"
	"time"
)

// The DJ's profile, as the platform holds it.
//
// A DJ who fills their name and photo in on the web should open the console
// and find it already there, and the other way round. That is one record with
// two editors, so the only question this file answers is which of them saw it
// last: every local edit stamps ProfileMs, the platform keeps its own stamp,
// and the newer one wins. There is no merge, because there is nothing to merge
// - it is one person editing their own name from whichever screen is in front
// of them.
//
// The handle is different: it is minted and owned by the platform, and the Mac
// only ever displays it. Nothing here can rename anybody.

// CloudProfile is the shape both sides agree on. Links are keyed the way the
// platform keys them, which is also how the console's three pills are labelled.
type CloudProfile struct {
	Handle    string
	Name      string
	Bio       string
	Links     map[string]string
	UpdatedMs int64
}

// linkKeys are the three the platform stores, in the order the console shows
// them. Anything else a DJ has added stays local: the platform has no field
// for it, and dropping it on the way past would be a silent deletion.
var linkKeys = []string{"instagram", "soundcloud", "website"}

// The two sides store the same link differently, and neither is wrong. The
// platform keeps "lunasets", because that is what a DJ types and what reads
// well on a page; the console keeps the whole URL, because it renders a link
// and refuses anything that is not one. Translating in one place is what stops
// a sync from failing on every tick with "link URL must be a full URL".
var linkPrefix = map[string]string{
	"instagram":  "https://instagram.com/",
	"soundcloud": "https://soundcloud.com/",
}

func linkToURL(key, value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	if strings.HasPrefix(value, "http://") || strings.HasPrefix(value, "https://") {
		return value
	}
	if prefix, ok := linkPrefix[key]; ok {
		return prefix + strings.TrimPrefix(value, "@")
	}
	return "https://" + value
}

func linkToName(key, url string) string {
	url = strings.TrimSpace(url)
	if prefix, ok := linkPrefix[key]; ok {
		if trimmed := strings.TrimPrefix(url, prefix); trimmed != url {
			return strings.Trim(trimmed, "/")
		}
	}
	return url
}

// CloudProfile reads what this Mac would send up.
func (s *Store) CloudProfile() CloudProfile {
	meta := s.Meta()
	out := CloudProfile{
		Name:  realHost(meta.Host),
		Bio:   meta.Bio,
		Links: map[string]string{},
	}
	for _, link := range meta.Links {
		for _, key := range linkKeys {
			if link.Type == key && link.URL != "" {
				out.Links[key] = linkToName(key, link.URL)
			}
		}
	}
	s.mu.Lock()
	base := s.base
	s.mu.Unlock()
	if id, ok := loadIdentity(base); ok {
		out.Handle, out.UpdatedMs = id.Handle, id.ProfileMs
	}
	return out
}

// StampProfile records that the profile just changed here. Called after a local
// edit so the next sync knows this Mac is the newer of the two.
func (s *Store) StampProfile() int64 {
	s.mu.Lock()
	base := s.base
	s.mu.Unlock()
	if base == "" {
		return 0
	}
	id, _ := loadIdentity(base)
	// Never go backwards, and never collide with the stamp already there: two
	// edits in the same millisecond must still be ordered, or the second one
	// looks stale to the platform and is thrown away.
	now := time.Now().UnixMilli()
	if now <= id.ProfileMs {
		now = id.ProfileMs + 1
	}
	id.ProfileMs = now
	_ = writeIdentity(base, id)
	return now
}

// ApplyCloudProfile takes the platform's copy when the platform's copy is
// newer. It reports whether anything changed, so a caller can stay quiet on the
// overwhelmingly common tick where nothing has.
func (s *Store) ApplyCloudProfile(p CloudProfile) (bool, error) {
	s.mu.Lock()
	base := s.base
	s.mu.Unlock()
	if base == "" {
		return false, nil
	}
	id, _ := loadIdentity(base)

	// The handle is the platform's to set, and is worth recording even when
	// nothing else moved - it is how the console can show the DJ their address.
	changed := false
	if p.Handle != "" && p.Handle != id.Handle {
		id.Handle = p.Handle
		changed = true
	}
	if p.UpdatedMs <= id.ProfileMs {
		if changed {
			_ = writeIdentity(base, id)
		}
		return changed, nil
	}
	id.ProfileMs = p.UpdatedMs
	if err := writeIdentity(base, id); err != nil {
		return changed, err
	}

	name, bio := strings.TrimSpace(p.Name), strings.TrimSpace(p.Bio)
	if err := s.SetProfile(&name, &bio); err != nil {
		return true, err
	}
	if err := s.SetLinks(mergeCloudLinks(s.Meta().Links, p.Links)); err != nil {
		return true, err
	}
	return true, nil
}

// AvatarSeen reports which platform picture this Mac has already taken.
func (s *Store) AvatarSeen() string {
	s.mu.Lock()
	base := s.base
	s.mu.Unlock()
	id, _ := loadIdentity(base)
	return id.AvatarURL
}

// ApplyCloudAvatar stores a photo that came from the platform and records
// where it came from, so it is fetched once rather than every minute.
func (s *Store) ApplyCloudAvatar(url, contentType string, data []byte) error {
	name := "avatar" + avatarExt(contentType)
	if _, err := s.SaveAvatar(name, bytes.NewReader(data)); err != nil {
		return err
	}
	s.mu.Lock()
	base := s.base
	s.mu.Unlock()
	id, _ := loadIdentity(base)
	id.AvatarURL = url
	return writeIdentity(base, id)
}

// LocalAvatar is this Mac's photo, ready to send. Reads the file the console
// wrote rather than re-deriving it, so what goes up is exactly what is shown.
func (s *Store) LocalAvatar() (string, []byte, bool) {
	s.mu.Lock()
	path, ext, ok := s.eventAvatarFileLocked()
	s.mu.Unlock()
	if !ok {
		return "", nil, false
	}
	data, err := os.ReadFile(path)
	if err != nil || len(data) == 0 {
		return "", nil, false
	}
	return "avatar" + ext, data, true
}

func avatarExt(contentType string) string {
	switch strings.ToLower(strings.TrimSpace(strings.Split(contentType, ";")[0])) {
	case "image/png":
		return ".png"
	case "image/webp":
		return ".webp"
	default:
		return ".jpg"
	}
}

// mergeCloudLinks replaces the three the platform knows about and leaves every
// other link the DJ has alone.
func mergeCloudLinks(current []Link, incoming map[string]string) []Link {
	out := make([]Link, 0, len(current)+len(linkKeys))
	for _, link := range current {
		known := false
		for _, key := range linkKeys {
			if link.Type == key {
				known = true
			}
		}
		if !known {
			out = append(out, link)
		}
	}
	for _, key := range linkKeys {
		if url := linkToURL(key, incoming[key]); url != "" {
			out = append(out, Link{Type: key, URL: url, Label: linkTypeLabels[key]})
		}
	}
	return out
}
