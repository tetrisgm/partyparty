package event

import (
	"bytes"
	"encoding/json"
	"errors"
	"html/template"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// RecapOptions controls optional private-data inclusion. By default requests
// are summarized only, because song requests are DJ-private during the party.
type RecapOptions struct {
	IncludeRequestDetails bool
}

// RecapData is the portable manifest written beside the static recap page.
type RecapData struct {
	GeneratedAt int64             `json:"generatedAt"`
	Event       RecapEvent        `json:"event"`
	Links       []Link            `json:"links,omitempty"`
	Posts       []RecapPost       `json:"posts"`
	Media       []RecapMedia      `json:"media"`
	Comments    []RecapComment    `json:"comments"`
	Reactions   map[string]int    `json:"reactions"`
	Requests    RecapRequests     `json:"requests"`
	Tracks      []CurrentTrack    `json:"tracks,omitempty"`
	Stats       RecapStats        `json:"stats"`
	Assets      map[string]string `json:"assets,omitempty"`
}

type RecapEvent struct {
	Title  string `json:"title"`
	Host   string `json:"host"`
	Starts string `json:"starts,omitempty"`
}

type RecapPost struct {
	ID       string         `json:"id"`
	TS       int64          `json:"ts"`
	Author   string         `json:"author"`
	Emoji    string         `json:"emoji,omitempty"`
	Text     string         `json:"text,omitempty"`
	DJ       bool           `json:"dj,omitempty"`
	Media    []RecapMedia   `json:"media,omitempty"`
	Comments []RecapComment `json:"comments,omitempty"`
}

type RecapComment struct {
	ID     string `json:"id"`
	PostID string `json:"postId,omitempty"`
	TS     int64  `json:"ts"`
	Author string `json:"author"`
	Emoji  string `json:"emoji,omitempty"`
	Text   string `json:"text"`
	DJ     bool   `json:"dj,omitempty"`
}

type RecapMedia struct {
	ID        string `json:"id"`
	Type      string `json:"type"`
	Name      string `json:"name,omitempty"`
	Size      int64  `json:"size,omitempty"`
	Asset     string `json:"asset,omitempty"`
	Thumb     string `json:"thumb,omitempty"`
	PostID    string `json:"postId,omitempty"`
	PostTS    int64  `json:"postTs,omitempty"`
	Author    string `json:"author,omitempty"`
	Emoji     string `json:"emoji,omitempty"`
	Caption   string `json:"caption,omitempty"`
	ThumbOnly bool   `json:"thumbOnly,omitempty"`
}

type RecapRequests struct {
	Total          int            `json:"total"`
	ByState        map[string]int `json:"byState,omitempty"`
	ByVibe         map[string]int `json:"byVibe,omitempty"`
	Details        []Request      `json:"details,omitempty"`
	DetailsEnabled bool           `json:"detailsEnabled"`
}

type RecapStats struct {
	Posts    int `json:"posts"`
	Comments int `json:"comments"`
	Media    int `json:"media"`
	Requests int `json:"requests"`
	Tracks   int `json:"tracks"`
}

type recapSnapshot struct {
	dir       string
	data      RecapData
	mediaSrc  map[string]string
	thumbSrc  map[string]string
	assetName map[string]string
}

// RecapSnapshot gathers approved content into an immutable manifest without
// mutating event state. The store lock is held only while copying in-memory
// values and computing validated local paths.
func (s *Store) RecapSnapshot(opts RecapOptions) (RecapData, error) {
	snap, err := s.recapSnapshot(opts)
	if err != nil {
		return RecapData{}, err
	}
	return snap.data, nil
}

// GenerateRecap regenerates recap/index.html, recap/manifest.json, and
// recap/assets from the current approved-content snapshot.
func (s *Store) GenerateRecap(opts RecapOptions) (RecapData, error) {
	snap, err := s.recapSnapshot(opts)
	if err != nil {
		return RecapData{}, err
	}
	if err := writeRecap(snap); err != nil {
		return RecapData{}, err
	}
	return snap.data, nil
}

// RecapDir returns the static recap folder path for this event.
func (s *Store) RecapDir() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return filepath.Join(s.dir, "recap")
}

func (s *Store) recapSnapshot(opts RecapOptions) (recapSnapshot, error) {
	now := time.Now().UnixMilli()
	s.mu.Lock()
	defer s.mu.Unlock()

	meta := s.meta
	meta.Features = normalizeFeatures(meta.Features)
	links := append([]Link(nil), meta.Links...)
	data := RecapData{
		GeneratedAt: now,
		Event: RecapEvent{
			Title:  meta.Title,
			Host:   meta.Host,
			Starts: meta.Starts,
		},
		Links:     links,
		Posts:     []RecapPost{},
		Media:     []RecapMedia{},
		Comments:  []RecapComment{},
		Reactions: map[string]int{},
		Assets:    map[string]string{},
		Requests: RecapRequests{
			ByState:        map[string]int{},
			ByVibe:         map[string]int{},
			DetailsEnabled: opts.IncludeRequestDetails,
		},
	}
	mediaSrc := map[string]string{}
	thumbSrc := map[string]string{}
	assetName := map[string]string{}

	for _, kind := range reactionTypes {
		if c := s.reactions[kind]; c != nil {
			data.Reactions[kind] = c.Total
		} else {
			data.Reactions[kind] = 0
		}
	}

	for _, req := range s.requests {
		if req == nil {
			continue
		}
		cp := *req
		cp.State = normalizeRequestState(cp.State)
		data.Requests.Total++
		data.Requests.ByState[cp.State]++
		if cp.Vibe != "" {
			data.Requests.ByVibe[cp.Vibe]++
		}
		if opts.IncludeRequestDetails {
			cp.CID = ""
			data.Requests.Details = append(data.Requests.Details, cp)
		}
	}

	if s.currentTrack != nil && s.currentTrack.Title != "" {
		data.Tracks = append(data.Tracks, *s.currentTrack)
	}
	data.Tracks = append(data.Tracks, s.recentTracks...)

	for _, p := range s.posts {
		if p == nil || p.Deleted || normalizeState(p.State) != StateApproved {
			continue
		}
		rp := RecapPost{
			ID:     p.ID,
			TS:     p.TS,
			Author: p.Author,
			Emoji:  p.Emoji,
			Text:   p.Text,
			DJ:     p.DJ,
		}
		for _, m := range p.Media {
			if !validMediaID(m.ID) {
				continue
			}
			src, ok := s.mediaFileLocked(m.ID)
			if !ok {
				continue
			}
			if st, err := os.Stat(src); err != nil || st.IsDir() {
				continue
			}
			rm := RecapMedia{
				ID:      m.ID,
				Type:    m.Type,
				Name:    m.Name,
				Size:    m.Size,
				Asset:   "assets/" + m.ID,
				PostID:  p.ID,
				PostTS:  p.TS,
				Author:  p.Author,
				Emoji:   p.Emoji,
				Caption: p.Text,
			}
			mediaSrc[m.ID] = src
			assetName[m.ID] = m.ID
			data.Assets[m.ID] = rm.Asset
			if thumb, ok := s.thumbFileLocked(m.ID); ok {
				if st, err := os.Stat(thumb); err == nil && !st.IsDir() {
					tn := "thumb-" + thumbFileName(m.ID)
					rm.Thumb = "assets/" + tn
					thumbSrc[m.ID] = thumb
					assetName["thumb:"+m.ID] = tn
					data.Assets["thumb:"+m.ID] = rm.Thumb
				}
			}
			rp.Media = append(rp.Media, rm)
			data.Media = append(data.Media, rm)
		}
		for _, c := range p.Comments {
			if normalizeState(c.State) != StateApproved {
				continue
			}
			rc := RecapComment{
				ID:     c.ID,
				PostID: p.ID,
				TS:     c.TS,
				Author: c.Author,
				Emoji:  c.Emoji,
				Text:   c.Text,
				DJ:     c.DJ,
			}
			rp.Comments = append(rp.Comments, rc)
			data.Comments = append(data.Comments, rc)
		}
		data.Posts = append(data.Posts, rp)
	}

	sort.SliceStable(data.Posts, func(i, j int) bool { return data.Posts[i].TS < data.Posts[j].TS })
	sort.SliceStable(data.Media, func(i, j int) bool { return data.Media[i].PostTS < data.Media[j].PostTS })
	sort.SliceStable(data.Comments, func(i, j int) bool { return data.Comments[i].TS < data.Comments[j].TS })
	sort.SliceStable(data.Tracks, func(i, j int) bool { return data.Tracks[i].SetAt > data.Tracks[j].SetAt })
	data.Stats = RecapStats{
		Posts:    len(data.Posts),
		Comments: len(data.Comments),
		Media:    len(data.Media),
		Requests: data.Requests.Total,
		Tracks:   len(data.Tracks),
	}

	return recapSnapshot{dir: s.dir, data: data, mediaSrc: mediaSrc, thumbSrc: thumbSrc, assetName: assetName}, nil
}

func writeRecap(snap recapSnapshot) error {
	recapDir := filepath.Join(snap.dir, "recap")
	assetsDir := filepath.Join(recapDir, "assets")
	if recapDir == "" || filepath.Base(recapDir) != "recap" {
		return errors.New("bad recap path")
	}
	if err := os.RemoveAll(recapDir); err != nil {
		return err
	}
	if err := os.MkdirAll(assetsDir, 0o755); err != nil {
		return err
	}
	for id, src := range snap.mediaSrc {
		name := snap.assetName[id]
		if name == "" || !validMediaID(name) {
			return errors.New("bad recap asset")
		}
		if err := copyFile(filepath.Join(assetsDir, name), src); err != nil {
			return err
		}
	}
	for id, src := range snap.thumbSrc {
		name := snap.assetName["thumb:"+id]
		if name == "" || name != filepath.Base(name) || strings.HasPrefix(name, ".") {
			return errors.New("bad recap thumbnail")
		}
		if err := copyFile(filepath.Join(assetsDir, name), src); err != nil {
			return err
		}
	}
	manifest, err := json.MarshalIndent(snap.data, "", "  ")
	if err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(recapDir, "manifest.json"), manifest, 0o644); err != nil {
		return err
	}
	html, err := renderRecapHTML(snap.data)
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(recapDir, "index.html"), html, 0o644)
}

func copyFile(dst, src string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	_, copyErr := io.Copy(out, in)
	closeErr := out.Close()
	if copyErr != nil {
		return copyErr
	}
	return closeErr
}

func renderRecapHTML(data RecapData) ([]byte, error) {
	t, err := template.New("recap").Funcs(template.FuncMap{
		"date": func(ms int64) string {
			if ms <= 0 {
				return ""
			}
			return time.UnixMilli(ms).Format("Jan 2, 2006 3:04 PM")
		},
		"reactionLabel": func(kind string) string {
			switch kind {
			case "fire":
				return "Fire"
			case "heart":
				return "Love"
			case "louder":
				return "Louder"
			case "quieter":
				return "Quieter"
			case "rewind":
				return "Rewind"
			case "id":
				return "Track IDs"
			case "more":
				return "More"
			default:
				return kind
			}
		},
	}).Parse(recapHTMLTemplate)
	if err != nil {
		return nil, err
	}
	var buf bytes.Buffer
	if err := t.Execute(&buf, data); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

const recapHTMLTemplate = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{{.Event.Title}} - recap</title>
<style>
:root{color-scheme:light;--bg:#f5f5f7;--card:#fff;--label:#1d1d1f;--muted:#6e6e73;--soft:#86868b;--sep:rgba(0,0,0,.08);--fill:rgba(120,120,128,.10);--accent:#ff2d55;--green:#34c759;--shadow:0 4px 20px rgba(0,0,0,.07),0 1px 3px rgba(0,0,0,.05);font-family:-apple-system,BlinkMacSystemFont,system-ui,"Segoe UI",sans-serif}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--label);font:14px/1.45 -apple-system,BlinkMacSystemFont,system-ui,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}a{color:var(--accent);font-weight:700;text-decoration:none}a:hover{text-decoration:underline}.wrap{max-width:980px;margin:0 auto;padding:34px 20px 70px}.hero{min-height:42vh;display:flex;flex-direction:column;justify-content:center;padding:24px 0 34px}.eyebrow{color:var(--muted);font-weight:700;margin-bottom:4px}.hero h1{font-size:clamp(34px,7vw,72px);line-height:1.03;margin:0 0 10px;letter-spacing:0;font-weight:850}.meta{color:var(--muted);font-size:16px}.stats{display:grid;grid-template-columns:repeat(5,1fr);gap:10px;margin:18px 0 10px}.stat{background:var(--card);border:1px solid var(--sep);border-radius:14px;padding:13px 14px;box-shadow:var(--shadow)}.stat b{display:block;font-size:24px;line-height:1.05}.stat span{display:block;color:var(--muted);font-size:12px;font-weight:700;margin-top:3px}.section{margin-top:34px}.section h2{font-size:24px;margin:0 0 12px;letter-spacing:0}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:10px}.tile{background:var(--card);border:1px solid var(--sep);border-radius:14px;overflow:hidden;box-shadow:var(--shadow)}.tile img,.tile video{display:block;width:100%;aspect-ratio:1;object-fit:cover;background:#e8e8ed}.tile audio{width:100%;margin:14px}.cap{padding:10px 12px;color:var(--muted);font-size:12px}.cap b{color:var(--label)}.posts{display:grid;gap:12px}.post{background:var(--card);border:1px solid var(--sep);border-radius:16px;padding:14px 16px;box-shadow:var(--shadow)}.phead{display:flex;gap:8px;align-items:baseline;color:var(--muted);font-size:12px}.phead b{color:var(--label);font-size:14px}.dj{background:var(--accent);color:#fff;border-radius:6px;font-size:10px;font-weight:850;padding:1px 6px}.text{white-space:pre-wrap;word-break:break-word;margin-top:7px;font-size:15px}.mini{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px}.mini img,.mini video{width:82px;height:82px;object-fit:cover;border-radius:10px;background:#e8e8ed}.comments{border-top:1px solid var(--sep);margin-top:10px;padding-top:8px}.comment{font-size:13px;word-break:break-word;margin:4px 0;color:var(--label)}.comment b{font-weight:800}.chips{display:flex;gap:8px;flex-wrap:wrap}.chip{background:var(--card);border:1px solid var(--sep);border-radius:999px;padding:8px 12px;box-shadow:0 1px 5px rgba(0,0,0,.06);color:var(--muted);font-weight:700}.chip b{color:var(--label);margin-right:5px}.tracks{display:grid;gap:7px}.track{background:var(--fill);border-radius:10px;padding:9px 11px}.track b{display:block}.empty{color:var(--soft);background:var(--card);border:1px solid var(--sep);border-radius:14px;padding:18px;text-align:center}.foot{margin-top:42px;color:var(--soft);font-size:12px}@media(max-width:680px){.stats{grid-template-columns:repeat(2,1fr)}.hero{min-height:30vh}.wrap{padding-left:16px;padding-right:16px}}
</style>
</head>
<body>
<main class="wrap">
  <section class="hero">
    <div class="eyebrow">{{.Event.Host}} hosted</div>
    <h1>{{.Event.Title}}</h1>
    <div class="meta">{{if .Event.Starts}}{{.Event.Starts}}{{else}}{{date .GeneratedAt}}{{end}}</div>
    <div class="stats">
      <div class="stat"><b>{{.Stats.Posts}}</b><span>posts</span></div>
      <div class="stat"><b>{{.Stats.Media}}</b><span>media</span></div>
      <div class="stat"><b>{{.Stats.Comments}}</b><span>comments</span></div>
      <div class="stat"><b>{{.Stats.Requests}}</b><span>requests</span></div>
      <div class="stat"><b>{{.Stats.Tracks}}</b><span>tracks</span></div>
    </div>
  </section>

  {{if .Links}}<section class="section"><h2>DJ links</h2><div class="chips">{{range .Links}}<a class="chip" href="{{.URL}}">{{.Label}}</a>{{end}}</div></section>{{end}}

  <section class="section"><h2>Photo and video wall</h2>{{if .Media}}<div class="grid">{{range .Media}}<article class="tile">{{if eq .Type "video"}}<video controls preload="metadata" src="{{.Asset}}" {{if .Thumb}}poster="{{.Thumb}}"{{end}}></video>{{else if eq .Type "audio"}}<audio controls src="{{.Asset}}"></audio>{{else}}<img src="{{if .Thumb}}{{.Thumb}}{{else}}{{.Asset}}{{end}}" alt="">{{end}}<div class="cap"><b>{{.Emoji}}{{.Author}}</b>{{if .Caption}}<br>{{.Caption}}{{end}}</div></article>{{end}}</div>{{else}}<div class="empty">No approved media in this recap.</div>{{end}}</section>

  <section class="section"><h2>Shoutouts</h2>{{if .Posts}}<div class="posts">{{range .Posts}}<article class="post"><div class="phead"><b>{{.Emoji}} {{.Author}}</b>{{if .DJ}}<span class="dj">DJ</span>{{end}}<span>{{date .TS}}</span></div>{{if .Text}}<div class="text">{{.Text}}</div>{{end}}{{if .Media}}<div class="mini">{{range .Media}}{{if eq .Type "video"}}<video src="{{.Asset}}" {{if .Thumb}}poster="{{.Thumb}}"{{end}}></video>{{else if eq .Type "audio"}}<audio controls src="{{.Asset}}"></audio>{{else}}<img src="{{if .Thumb}}{{.Thumb}}{{else}}{{.Asset}}{{end}}" alt="">{{end}}{{end}}</div>{{end}}{{if .Comments}}<div class="comments">{{range .Comments}}<div class="comment"><b>{{.Emoji}} {{.Author}}:</b> {{.Text}}</div>{{end}}</div>{{end}}</article>{{end}}</div>{{else}}<div class="empty">No approved posts in this recap.</div>{{end}}</section>

  <section class="section"><h2>Crowd signal</h2><div class="chips">{{range $kind,$n := .Reactions}}<span class="chip"><b>{{$n}}</b>{{reactionLabel $kind}}</span>{{end}}<span class="chip"><b>{{.Requests.Total}}</b>song requests summarized</span></div></section>

  {{if .Tracks}}<section class="section"><h2>Recently played</h2><div class="tracks">{{range .Tracks}}<div class="track"><b>{{.Title}}</b>{{if .Artist}}{{.Artist}}{{end}}{{if .Note}} · {{.Note}}{{end}}</div>{{end}}</div></section>{{end}}

  <div class="foot">Generated locally by partyparty. This folder is self-contained; open index.html without running the app.</div>
</main>
</body>
</html>
`
