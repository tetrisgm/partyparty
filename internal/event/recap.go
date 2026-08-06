package event

import (
	"fmt"
	"html"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// The party folder is something a DJ opens, not a database. Beside the photos
// and videos guests uploaded sits one index.html: open it and the wall is
// there - posts, comments, images, video - rendered from the journal that
// otherwise stays hidden in .state.
//
// It is deliberately a single static file with no scripts and relative links,
// so the folder can be copied to a drive, mailed, or opened in five years.

const recapFile = "index.html"

// writeRecap regenerates the party's index.html. Cheap enough to call on every
// change behind a debounce; callers hold no lock.
func (s *Store) writeRecap() {
	s.mu.Lock()
	dir := s.dir
	meta := s.meta
	posts := make([]*Post, 0, len(s.posts))
	for _, p := range s.posts {
		if p.Deleted || p.State == StateHidden {
			continue
		}
		clone := *p
		posts = append(posts, &clone)
	}
	tracks := append([]CurrentTrack(nil), s.setlistTracks...)
	s.mu.Unlock()
	if dir == "" {
		return
	}
	sort.SliceStable(posts, func(i, j int) bool { return posts[i].TS < posts[j].TS })

	var b strings.Builder
	title := meta.Title
	if strings.TrimSpace(title) == "" {
		title = "PartyParty"
	}
	b.WriteString(`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>` + html.EscapeString(title) + `</title>
<style>
:root{color-scheme:light dark}
body{margin:0;padding:32px 20px 64px;background:Canvas;color:CanvasText;
  font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
main{max-width:720px;margin:0 auto}
h1{font-size:30px;line-height:1.15;margin:0 0 6px}
.sub{color:color-mix(in srgb,CanvasText 60%,transparent);margin:0 0 32px}
.post{padding:16px 0;border-top:1px solid color-mix(in srgb,CanvasText 14%,transparent)}
.who{display:flex;align-items:baseline;gap:8px;margin-bottom:6px}
.name{font-weight:650}
.dj{font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;
  padding:2px 6px;border-radius:5px;background:#ff2d6f;color:#fff}
.when{margin-left:auto;font-size:13px;color:color-mix(in srgb,CanvasText 45%,transparent)}
.text{white-space:pre-wrap;overflow-wrap:anywhere}
.media{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:8px;margin-top:10px}
.media img,.media video{width:100%;height:100%;max-height:320px;object-fit:cover;border-radius:10px;display:block}
.comments{margin:10px 0 0;padding:10px 0 0 14px;border-left:2px solid color-mix(in srgb,CanvasText 12%,transparent)}
.comment{margin:0 0 6px;font-size:15px}
.setlist{margin-top:40px;padding-top:16px;border-top:1px solid color-mix(in srgb,CanvasText 14%,transparent)}
.setlist ol{padding-left:20px;margin:8px 0 0}
.empty{color:color-mix(in srgb,CanvasText 45%,transparent)}
</style></head><body><main>
`)
	fmt.Fprintf(&b, "<h1>%s</h1>\n", html.EscapeString(title))
	sub := []string{}
	if h := strings.TrimSpace(meta.Host); h != "" && h != placeholderHost {
		sub = append(sub, "with "+h)
	}
	if len(posts) > 0 {
		sub = append(sub, time.UnixMilli(posts[0].TS).Format("Monday, 2 January 2006"))
	}
	fmt.Fprintf(&b, "<p class=\"sub\">%s</p>\n", html.EscapeString(strings.Join(sub, " · ")))

	if len(posts) == 0 {
		b.WriteString("<p class=\"empty\">Nobody posted at this party.</p>\n")
	}
	for _, p := range posts {
		b.WriteString("<article class=\"post\">\n<div class=\"who\">")
		fmt.Fprintf(&b, "<span class=\"name\">%s %s</span>",
			html.EscapeString(p.Emoji), html.EscapeString(p.Author))
		if p.DJ {
			b.WriteString("<span class=\"dj\">DJ</span>")
		}
		fmt.Fprintf(&b, "<span class=\"when\">%s</span></div>\n",
			html.EscapeString(time.UnixMilli(p.TS).Format("15:04")))
		if strings.TrimSpace(p.Text) != "" {
			fmt.Fprintf(&b, "<div class=\"text\">%s</div>\n", html.EscapeString(p.Text))
		}
		if len(p.Media) > 0 {
			b.WriteString("<div class=\"media\">")
			for _, m := range p.Media {
				// Relative to this file: the uploads sit right next to it.
				src := html.EscapeString(m.ID)
				switch m.Type {
				case "video":
					fmt.Fprintf(&b, "<video controls preload=\"metadata\" src=\"%s\"></video>", src)
				case "audio":
					fmt.Fprintf(&b, "<audio controls src=\"%s\"></audio>", src)
				default:
					fmt.Fprintf(&b, "<img loading=\"lazy\" src=\"%s\" alt=\"%s\">",
						src, html.EscapeString(m.Name))
				}
			}
			b.WriteString("</div>\n")
		}
		if len(p.Comments) > 0 {
			b.WriteString("<div class=\"comments\">")
			for _, c := range p.Comments {
				if c.State == StateHidden {
					continue
				}
				fmt.Fprintf(&b, "<p class=\"comment\"><b>%s %s</b> %s</p>",
					html.EscapeString(c.Emoji), html.EscapeString(c.Author), html.EscapeString(c.Text))
			}
			b.WriteString("</div>\n")
		}
		b.WriteString("</article>\n")
	}

	if len(tracks) > 0 {
		b.WriteString("<section class=\"setlist\"><h2>Setlist</h2><ol>\n")
		for _, t := range tracks {
			line := t.Title
			if t.Artist != "" {
				line = t.Artist + " - " + t.Title
			}
			fmt.Fprintf(&b, "<li>%s</li>\n", html.EscapeString(line))
		}
		b.WriteString("</ol></section>\n")
	}
	b.WriteString("</main></body></html>\n")

	tmp := filepath.Join(dir, ".recap.tmp")
	if os.WriteFile(tmp, []byte(b.String()), 0o644) == nil {
		_ = os.Rename(tmp, filepath.Join(dir, recapFile))
	}
}

// scheduleRecap coalesces recap writes: a busy wall would otherwise rewrite the
// page on every reaction.
func (s *Store) scheduleRecap() {
	s.recapMu.Lock()
	defer s.recapMu.Unlock()
	if s.recapPending {
		return
	}
	s.recapPending = true
	time.AfterFunc(3*time.Second, func() {
		s.recapMu.Lock()
		s.recapPending = false
		s.recapMu.Unlock()
		s.writeRecap()
	})
}
