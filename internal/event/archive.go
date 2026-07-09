package event

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"
)

const exportManifestName = ".partyparty-export.json"

type exportManifest struct {
	Files []string `json:"files"`
}

// ExportArchive refreshes the human-facing event folder view. The journal,
// metadata, media, and recording folders stay in place for the local server;
// this writes flat files in the event root for Finder: event.md, readable media
// links/copies, and recording.aac (or numbered recording segments).
func (s *Store) ExportArchive() error {
	s.mu.Lock()
	dir := s.dir
	meta := s.meta
	meta.Links = append([]Link(nil), s.meta.Links...)
	posts := make([]Post, 0, len(s.posts))
	for _, p := range s.posts {
		if p == nil || p.Deleted {
			continue
		}
		cp := *p
		cp.Media = append([]Media(nil), p.Media...)
		cp.Comments = append([]Comment(nil), p.Comments...)
		posts = append(posts, cp)
	}
	tracks := append([]CurrentTrack(nil), s.recentTracks...)
	if s.currentTrack != nil && s.currentTrack.Title != "" {
		tracks = append([]CurrentTrack{*s.currentTrack}, tracks...)
	}
	s.mu.Unlock()

	if dir == "" {
		return errors.New("event has no directory")
	}
	if err := cleanupPreviousExport(dir); err != nil {
		return err
	}
	files := []string{}
	mediaNames, mediaFiles, err := s.archiveMediaNames(posts)
	if err != nil {
		return err
	}
	for _, f := range mediaFiles {
		if err := linkOrCopy(f.src, filepath.Join(dir, f.name)); err != nil {
			return err
		}
		files = append(files, f.name)
	}
	recFiles, err := s.archiveRecordings(dir)
	if err != nil {
		return err
	}
	files = append(files, recFiles...)

	md := renderArchiveMarkdown(dir, meta, posts, tracks, mediaNames)
	if err := writeFileAtomic(filepath.Join(dir, "event.md"), []byte(md), 0o644); err != nil {
		return err
	}
	files = append(files, "event.md")
	sort.Strings(files)
	if err := writeExportManifest(dir, files); err != nil {
		return err
	}
	hideInternalEventFiles(dir)
	return nil
}

type archiveFile struct {
	src  string
	name string
}

func (s *Store) archiveMediaNames(posts []Post) (map[string]string, []archiveFile, error) {
	names := map[string]string{}
	used := map[string]bool{}
	counts := map[string]int{}
	var files []archiveFile
	for _, p := range posts {
		for _, m := range p.Media {
			if names[m.ID] != "" {
				continue
			}
			src, ok := s.MediaPath(m.ID)
			if !ok {
				continue
			}
			typ := m.Type
			if typ == "" {
				typ = mediaExt[strings.ToLower(filepath.Ext(m.ID))]
			}
			prefix := "media"
			switch typ {
			case "image":
				prefix = "photo"
			case "video":
				prefix = "video"
			case "audio":
				prefix = "audio"
			}
			counts[prefix]++
			ext := strings.ToLower(filepath.Ext(m.ID))
			if ext == "" {
				ext = strings.ToLower(filepath.Ext(m.Name))
			}
			stem := sanitizeArchiveStem(strings.TrimSuffix(filepath.Base(m.Name), filepath.Ext(m.Name)))
			if stem == "" || stem == "." {
				stem = prefix
			}
			name := uniqueArchiveName(used, fmt.Sprintf("%s-%02d-%s%s", prefix, counts[prefix], stem, ext))
			names[m.ID] = name
			files = append(files, archiveFile{src: src, name: name})
		}
	}
	return names, files, nil
}

func (s *Store) archiveRecordings(dir string) ([]string, error) {
	recs := s.LatestSetRecordings()
	if len(recs) == 0 {
		return nil, nil
	}
	files := []string{}
	if len(recs) == 1 {
		ext := strings.ToLower(filepath.Ext(recs[0]))
		if ext == "" {
			ext = ".aac"
		}
		name := "recording" + ext
		if err := linkOrCopy(recs[0], filepath.Join(dir, name)); err != nil {
			return nil, err
		}
		return []string{name}, nil
	}
	for i, rec := range recs {
		ext := strings.ToLower(filepath.Ext(rec))
		if ext == "" {
			ext = ".aac"
		}
		name := fmt.Sprintf("recording-%02d%s", i+1, ext)
		if err := linkOrCopy(rec, filepath.Join(dir, name)); err != nil {
			return nil, err
		}
		files = append(files, name)
	}
	return files, nil
}

func renderArchiveMarkdown(dir string, meta Meta, posts []Post, tracks []CurrentTrack, mediaNames map[string]string) string {
	var b strings.Builder
	title := strings.TrimSpace(meta.Title)
	if title == "" {
		title = "partyparty"
	}
	fmt.Fprintf(&b, "# %s\n\n", title)
	if meta.Host != "" {
		fmt.Fprintf(&b, "- Host: %s\n", meta.Host)
	}
	if meta.Starts != "" {
		fmt.Fprintf(&b, "- Date / place: %s\n", meta.Starts)
	}
	if meta.Slug != "" {
		fmt.Fprintf(&b, "- Event link: https://party.ramine.net/e/%s\n", meta.Slug)
	}
	fmt.Fprintf(&b, "- Folder: %s\n", filepath.Base(dir))
	fmt.Fprintf(&b, "- Exported: %s\n", time.Now().Format(time.RFC3339))
	if len(meta.Links) > 0 {
		b.WriteString("- Links:\n")
		for _, link := range meta.Links {
			label := strings.TrimSpace(link.Label)
			if label == "" {
				label = strings.TrimSpace(link.Type)
			}
			if label == "" {
				label = "Link"
			}
			fmt.Fprintf(&b, "  - [%s](%s)\n", label, link.URL)
		}
	}
	b.WriteString("\n## Party feed\n\n")
	if len(posts) == 0 {
		b.WriteString("No posts yet.\n")
	} else {
		sort.Slice(posts, func(i, j int) bool { return posts[i].TS < posts[j].TS })
		for _, p := range posts {
			fmt.Fprintf(&b, "### %s - %s %s%s%s\n\n",
				formatMillis(p.TS), p.Emoji, p.Author, djSuffix(p.DJ), stateSuffix(p.State))
			if p.Text != "" {
				b.WriteString(p.Text)
				b.WriteString("\n\n")
			}
			if len(p.Media) > 0 {
				b.WriteString("Media:\n")
				for _, m := range p.Media {
					name := mediaNames[m.ID]
					if name == "" {
						name = m.Name
					}
					fmt.Fprintf(&b, "- [%s](%s)\n", displayMediaName(m, name), name)
				}
				b.WriteString("\n")
			}
			if len(p.Comments) > 0 {
				b.WriteString("Comments:\n")
				for _, c := range p.Comments {
					fmt.Fprintf(&b, "- %s - %s %s%s%s: %s\n",
						formatMillis(c.TS), c.Emoji, c.Author, djSuffix(c.DJ), stateSuffix(c.State), c.Text)
				}
				b.WriteString("\n")
			}
		}
	}
	if len(tracks) > 0 {
		b.WriteString("## Tracks\n\n")
		sort.Slice(tracks, func(i, j int) bool { return tracks[i].SetAt < tracks[j].SetAt })
		for _, tr := range tracks {
			title := tr.Title
			if tr.Artist != "" {
				title += " - " + tr.Artist
			}
			fmt.Fprintf(&b, "- %s - %s\n", formatMillis(tr.SetAt), title)
		}
		b.WriteString("\n")
	}
	return b.String()
}

func displayMediaName(m Media, fallback string) string {
	if strings.TrimSpace(m.Name) != "" {
		return m.Name
	}
	return fallback
}

func djSuffix(dj bool) string {
	if dj {
		return " [DJ]"
	}
	return ""
}

func stateSuffix(state string) string {
	state = normalizeState(state)
	if state == "" || state == StateApproved {
		return ""
	}
	return " [" + state + "]"
}

func formatMillis(ms int64) string {
	if ms <= 0 {
		return "unknown time"
	}
	return time.UnixMilli(ms).Format("2006-01-02 15:04")
}

func sanitizeArchiveStem(s string) string {
	s = strings.TrimSpace(s)
	var b strings.Builder
	lastDash := false
	for _, r := range s {
		ok := (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9')
		if ok {
			b.WriteRune(r)
			lastDash = false
			continue
		}
		if (r == '-' || r == '_' || r == ' ') && !lastDash && b.Len() > 0 {
			b.WriteByte('-')
			lastDash = true
		}
	}
	out := strings.Trim(b.String(), "-")
	if len(out) > 52 {
		out = strings.Trim(out[:52], "-")
	}
	return out
}

func uniqueArchiveName(used map[string]bool, name string) string {
	ext := filepath.Ext(name)
	stem := strings.TrimSuffix(name, ext)
	out := name
	for n := 2; used[out]; n++ {
		out = fmt.Sprintf("%s-%d%s", stem, n, ext)
	}
	used[out] = true
	return out
}

func cleanupPreviousExport(dir string) error {
	data, err := os.ReadFile(filepath.Join(dir, exportManifestName))
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	}
	var m exportManifest
	if err := json.Unmarshal(data, &m); err != nil {
		return nil
	}
	for _, name := range m.Files {
		if name == "" || name != filepath.Base(name) {
			continue
		}
		_ = os.Remove(filepath.Join(dir, name))
	}
	return nil
}

func writeExportManifest(dir string, files []string) error {
	data, err := json.MarshalIndent(exportManifest{Files: files}, "", " ")
	if err != nil {
		return err
	}
	return writeFileAtomic(filepath.Join(dir, exportManifestName), data, 0o644)
}

func writeFileAtomic(path string, data []byte, perm os.FileMode) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, perm); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func linkOrCopy(src, dst string) error {
	_ = os.Remove(dst)
	if err := os.Link(src, dst); err == nil {
		return nil
	}
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	_, copyErr := io.Copy(out, in)
	closeErr := out.Close()
	if copyErr != nil {
		_ = os.Remove(dst)
		return copyErr
	}
	if closeErr != nil {
		_ = os.Remove(dst)
		return closeErr
	}
	return nil
}

func hideInternalEventFiles(dir string) {
	if runtime.GOOS != "darwin" {
		return
	}
	for _, name := range []string{
		"media", "recordings", "recap",
		"meta.json", "posts.jsonl", "guests.json", exportManifestName,
	} {
		_ = exec.Command("chflags", "hidden", filepath.Join(dir, name)).Run()
	}
}
