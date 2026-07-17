// Package publish takes an event's finished set recordings and puts them
// online: it remuxes the raw ADTS/AAC recording(s) into one seekable faststart
// .m4a, renders a waveform, and uploads both to the DJ's /e/<slug> page via the
// partyparty.party broker — reusing this install's existing broker identity for
// auth. The Mac stays the source of truth; publishing is just a sync of what it
// already recorded. See internal/event (recordings live in the event folder)
// and internal/activate (install creds).
package publish

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"partyparty/internal/event"
)

// Meta is the event's public identity carried to the online page.
type Meta struct {
	Slug    string // DJ-chosen slug; "" (or invalid) = auto-derive from the install
	Title   string
	Host    string
	Starts  string
	Where   string
	Tagline string
	About   string
}

// Creds authenticate the publish to the broker. InstallSlug is this install's
// memorable broker slug ("fader91"), used to auto-derive an event slug.
type Creds struct {
	ID          string
	Secret      string
	InstallSlug string
}

// Result is what a successful publish yields — the shareable page.
type Result struct {
	URL     string `json:"url"`
	Slug    string `json:"slug"`
	SetID   string `json:"setId"`
	Warning string `json:"warning,omitempty"` // e.g. only part of a multi-segment set could be stitched
}

const (
	maxAudioBytes = 200_000_000 // must match the Worker's publish-audio cap
	peakBins      = 1000        // waveform resolution
	peakRate      = 1000        // Hz, mono — the s16le rate we decode for peaks
)

var (
	errSlugTaken = errors.New("slug taken")
	validSlugRe  = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,48}$`)
	httpClient   = &http.Client{Timeout: 10 * time.Minute} // uploads can be large
)

// FromEvent publishes the event store's current set recordings — mapping its
// meta into a Publish call — and records the published signature on success
// (so auto-publish can skip a set that already went out). Shared by the manual
// "Publish now" button and the auto-on-set-end path.
func FromEvent(ctx context.Context, ffmpeg string, ev *event.Store, creds Creds, base string) (*Result, error) {
	recordings := ev.LatestSetRecordings()
	m := ev.Meta()
	res, err := Publish(ctx, ffmpeg, recordings, Meta{
		Slug: m.Slug, Title: m.Title, Host: m.Host, Starts: m.Starts,
	}, creds, base)
	if err != nil {
		return nil, err
	}
	ev.SetPublishedSig(Signature(recordings))
	return res, nil
}

// Signature identifies a set of recordings by name+size so a publish can be
// deduped — auto-publish skips a set that already went out (manually or by a
// prior auto).
func Signature(recordings []string) string {
	var b strings.Builder
	for _, f := range recordings {
		st, err := os.Stat(f)
		if err != nil {
			continue
		}
		fmt.Fprintf(&b, "%s:%d;", filepath.Base(f), st.Size())
	}
	return b.String()
}

// Publish remuxes the recordings into one faststart .m4a, renders a waveform,
// and uploads both to the online event page. ffmpeg is the resolved ffmpeg
// binary; base is the broker URL (e.g. https://partyparty.party).
func Publish(ctx context.Context, ffmpeg string, recordings []string, meta Meta, creds Creds, base string) (*Result, error) {
	if creds.ID == "" || creds.Secret == "" {
		return nil, errors.New("this Mac isn't registered yet — go live once first")
	}
	if len(recordings) == 0 {
		return nil, errors.New("nothing to publish yet — record a set first")
	}

	slug := SlugForEvent(meta.Slug, creds.InstallSlug)

	tmp, err := os.MkdirTemp("", "ppublish-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(tmp)

	m4a := filepath.Join(tmp, "set.m4a")
	used, err := remux(ctx, ffmpeg, recordings, m4a)
	if err != nil {
		return nil, fmt.Errorf("couldn't prepare the recording: %w", err)
	}
	st, err := os.Stat(m4a)
	if err != nil {
		return nil, err
	}
	if st.Size() > maxAudioBytes {
		return nil, fmt.Errorf("set is too long to publish (%d MB, max %d MB)", st.Size()/1_000_000, maxAudioBytes/1_000_000)
	}
	sizeBytes := st.Size()

	// Waveform is best-effort: audio is the point, so a peaks failure still
	// publishes (with a flat strip) rather than blocking the set. Duration must
	// NOT depend on it, though — if the waveform decode fails, probe the length
	// separately so the page never shows a real set as 0:00.
	peaksJSON, durMs := waveform(ctx, ffmpeg, m4a)
	if durMs == 0 {
		durMs = probeDurationMs(ctx, ffmpeg, m4a)
	}

	recordedMs := time.Now().UnixMilli()
	if fi, e := os.Stat(recordings[len(recordings)-1]); e == nil {
		recordedMs = fi.ModTime().UnixMilli()
	}

	// publish-meta claims/owns the slug and mints the set. If a DJ-chosen slug
	// is owned by ANOTHER install, fall back to the collision-proof auto slug.
	setID, url, err := postMeta(ctx, base, creds, slug, meta, durMs, sizeBytes, recordedMs)
	if errors.Is(err, errSlugTaken) {
		auto := autoSlug(creds.InstallSlug)
		if slug != auto {
			slug = auto
			setID, url, err = postMeta(ctx, base, creds, slug, meta, durMs, sizeBytes, recordedMs)
		}
	}
	if err != nil {
		return nil, err
	}

	if err := putFile(ctx, base, creds, slug, setID, "publish-audio", m4a, "audio/mp4"); err != nil {
		return nil, fmt.Errorf("couldn't upload the set: %w", err)
	}
	if err := putBytes(ctx, base, creds, slug, setID, "publish-peaks", peaksJSON, "application/json"); err != nil {
		return nil, fmt.Errorf("couldn't finish publishing: %w", err)
	}

	if url == "" {
		url = "https://partyparty.party/e/" + slug
	}
	warning := ""
	if used < len(recordings) {
		warning = fmt.Sprintf("published %d of %d recording segments — the set couldn't be fully stitched", used, len(recordings))
	}
	return &Result{URL: url, Slug: slug, SetID: setID, Warning: warning}, nil
}

// PublishCover normalizes an event cover to JPEG when possible, then uploads it
// to the online event page using the same install-secret broker auth as sets.
func PublishCover(ctx context.Context, imgPath, slug string, creds Creds, base string) error {
	if creds.ID == "" || creds.Secret == "" {
		return errors.New("this Mac isn't registered yet — go live once first")
	}
	slug = SlugForEvent(slug, creds.InstallSlug)

	tmp, err := os.MkdirTemp("", "pcover-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(tmp)

	upload := imgPath
	jpg := filepath.Join(tmp, "cover.jpg")
	if err := exec.CommandContext(ctx, "sips", "-s", "format", "jpeg", "-Z", "1600", imgPath, "--out", jpg).Run(); err == nil {
		upload = jpg
	}

	err = putFile(ctx, base, creds, slug, "", "publish-cover", upload, "image/jpeg")
	if errors.Is(err, errSlugTaken) {
		auto := autoSlug(creds.InstallSlug)
		if slug != auto {
			slug = auto
			err = putFile(ctx, base, creds, slug, "", "publish-cover", upload, "image/jpeg")
		}
	}
	if err != nil {
		return fmt.Errorf("couldn't upload the cover: %w", err)
	}
	return nil
}

// DeleteCover removes the online event cover using the same install-secret
// broker auth as publishing. The local Mac remains the source of truth for
// live/offline guest service; this only edits the public replay page.
func DeleteCover(ctx context.Context, slug string, creds Creds, base string) error {
	if creds.ID == "" || creds.Secret == "" {
		return errors.New("this Mac isn't registered yet — go live once first")
	}
	slug = SlugForEvent(slug, creds.InstallSlug)
	err := deleteCover(ctx, base, creds, slug)
	if errors.Is(err, errSlugTaken) {
		auto := autoSlug(creds.InstallSlug)
		if slug != auto {
			err = deleteCover(ctx, base, creds, auto)
		}
	}
	if err != nil {
		return fmt.Errorf("couldn't remove the cover: %w", err)
	}
	return nil
}

// autoSlug derives a collision-proof-across-installs slug from the install's own
// broker slug + the date. Same-day sets share one page (latest set shows).
func autoSlug(installSlug string) string {
	base := installSlug
	if base == "" {
		base = "set"
	}
	// Full date, not just MMDD — else next year's set on the same day would land
	// on the same page and overwrite the link's latest set.
	return base + "-" + time.Now().Format("20060102")
}

// SlugForEvent returns the cloud event slug used by publish paths: a valid
// DJ-chosen slug when present, otherwise the install-derived automatic slug.
func SlugForEvent(metaSlug, installSlug string) string {
	slug := strings.TrimSpace(metaSlug)
	if validSlugRe.MatchString(slug) {
		return slug
	}
	return autoSlug(installSlug)
}

// remux joins the ADTS/AAC recording(s) into one faststart .m4a (stream-copy,
// no re-encode) and returns how many of the input segments made it in. Multiple
// segments (device-yank rebuilds) use the concat demuxer; if that fails, it
// falls back to the largest single segment so a publish never produces nothing
// — the caller surfaces a warning when used < len(recordings) so that partial
// stitch is never silent.
func remux(ctx context.Context, ffmpeg string, recordings []string, out string) (used int, err error) {
	if len(recordings) == 1 {
		return 1, runFF(ctx, ffmpeg, "-y", "-i", recordings[0], "-c", "copy", "-movflags", "+faststart", out)
	}
	list := out + ".concat.txt"
	var b strings.Builder
	for _, f := range recordings {
		b.WriteString("file '" + strings.ReplaceAll(f, "'", `'\''`) + "'\n")
	}
	if err := os.WriteFile(list, []byte(b.String()), 0o644); err != nil {
		return 0, err
	}
	if err := runFF(ctx, ffmpeg, "-y", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", "-movflags", "+faststart", out); err == nil {
		return len(recordings), nil
	}
	largest := recordings[0]
	var max int64
	for _, f := range recordings {
		if st, e := os.Stat(f); e == nil && st.Size() > max {
			max, largest = st.Size(), f
		}
	}
	if err := runFF(ctx, ffmpeg, "-y", "-i", largest, "-c", "copy", "-movflags", "+faststart", out); err != nil {
		return 0, err
	}
	return 1, nil
}

// probeDurationMs reads a clip's length by decoding it to null and parsing the
// last "time=" ffmpeg emits — a fallback for when the waveform decode failed
// but the audio is fine. Returns 0 if it can't be determined.
func probeDurationMs(ctx context.Context, ffmpeg, m4a string) int64 {
	cmd := exec.CommandContext(ctx, ffmpeg, "-hide_banner", "-i", m4a, "-f", "null", "-")
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	_ = cmd.Run() // even a non-zero exit usually still prints progress time
	return parseFFTime(stderr.String())
}

var ffTimeRe = regexp.MustCompile(`time=(\d+):(\d+):(\d+)\.(\d+)`)

// parseFFTime pulls the last "time=HH:MM:SS.xx" from ffmpeg stderr → millis.
func parseFFTime(s string) int64 {
	m := ffTimeRe.FindAllStringSubmatch(s, -1)
	if len(m) == 0 {
		return 0
	}
	last := m[len(m)-1]
	h, _ := strconv.Atoi(last[1])
	mn, _ := strconv.Atoi(last[2])
	sec, _ := strconv.Atoi(last[3])
	frac, _ := strconv.ParseFloat("0."+last[4], 64)
	return int64(h)*3600000 + int64(mn)*60000 + int64(sec)*1000 + int64(frac*1000)
}

// waveform decodes the set to mono s16le at a low rate and buckets peak
// amplitudes into peakBins values (0-100) for the page's waveform strip. On any
// failure it returns an empty (flat) waveform with zero duration.
func waveform(ctx context.Context, ffmpeg, m4a string) (peaksJSON []byte, durMs int64) {
	empty, _ := json.Marshal(map[string]any{"peaks": []int{}, "durationMs": 0})
	cmd := exec.CommandContext(ctx, ffmpeg, "-v", "error", "-i", m4a,
		"-ac", "1", "-filter:a", fmt.Sprintf("aresample=%d", peakRate), "-f", "s16le", "-")
	pcm, err := cmd.Output()
	if err != nil {
		return empty, 0
	}
	n := len(pcm) / 2 // sample count
	durMs = int64(n) * 1000 / peakRate
	bins := peakBins
	if n < bins {
		bins = n
	}
	peaks := make([]int, bins)
	for i := 0; i < bins; i++ {
		start, end := i*n/bins, (i+1)*n/bins
		var mx int
		for j := start; j < end; j++ {
			v := int(int16(binary.LittleEndian.Uint16(pcm[j*2:])))
			if v < 0 {
				v = -v
			}
			if v > mx {
				mx = v
			}
		}
		peaks[i] = mx * 100 / 32768
	}
	body, err := json.Marshal(map[string]any{"peaks": peaks, "durationMs": durMs})
	if err != nil {
		return empty, durMs
	}
	return body, durMs
}

func runFF(ctx context.Context, ffmpeg string, args ...string) error {
	cmd := exec.CommandContext(ctx, ffmpeg, args...)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		msg := strings.TrimSpace(stderr.String())
		if len(msg) > 200 {
			msg = msg[len(msg)-200:]
		}
		if msg == "" {
			return err
		}
		return fmt.Errorf("%v: %s", err, msg)
	}
	return nil
}

func postMeta(ctx context.Context, base string, creds Creds, slug string, meta Meta, durMs, sizeBytes, recordedMs int64) (setID, url string, err error) {
	body, _ := json.Marshal(map[string]any{
		"id": creds.ID, "secret": creds.Secret, "slug": slug,
		"title": meta.Title, "host": meta.Host, "starts": meta.Starts,
		"where": meta.Where, "tagline": meta.Tagline, "about": meta.About,
		"duration_ms": durMs, "size_bytes": sizeBytes, "recorded_ms": recordedMs,
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+"/api/broker/publish-meta", bytes.NewReader(body))
	if err != nil {
		return "", "", err
	}
	req.Header.Set("content-type", "application/json")
	resp, err := httpClient.Do(req)
	if err != nil {
		return "", "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusConflict {
		return "", "", errSlugTaken
	}
	if resp.StatusCode != http.StatusOK {
		return "", "", fmt.Errorf("publish-meta: %s", httpErr(resp))
	}
	var out struct {
		SetID string `json:"setId"`
		Slug  string `json:"slug"`
		URL   string `json:"url"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil || out.SetID == "" {
		return "", "", errors.New("publish-meta: malformed response")
	}
	return out.SetID, out.URL, nil
}

func putFile(ctx context.Context, base string, creds Creds, slug, setID, endpoint, path, ctype string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, base+"/api/broker/"+endpoint, f)
	if err != nil {
		return err
	}
	req.ContentLength = st.Size()
	setPutHeaders(req, creds, slug, setID, ctype)
	return doPut(req)
}

func putBytes(ctx context.Context, base string, creds Creds, slug, setID, endpoint string, data []byte, ctype string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, base+"/api/broker/"+endpoint, bytes.NewReader(data))
	if err != nil {
		return err
	}
	req.ContentLength = int64(len(data))
	setPutHeaders(req, creds, slug, setID, ctype)
	return doPut(req)
}

func deleteCover(ctx context.Context, base string, creds Creds, slug string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodDelete, base+"/api/broker/publish-cover", nil)
	if err != nil {
		return err
	}
	setPutHeaders(req, creds, slug, "", "application/octet-stream")
	return doRequest(req)
}

func setPutHeaders(req *http.Request, creds Creds, slug, setID, ctype string) {
	req.Header.Set("content-type", ctype)
	req.Header.Set("x-pp-id", creds.ID)
	req.Header.Set("x-pp-secret", creds.Secret)
	req.Header.Set("x-pp-slug", slug)
	if setID != "" {
		req.Header.Set("x-pp-set", setID)
	}
}

func doPut(req *http.Request) error {
	return doRequest(req)
}

func doRequest(req *http.Request) error {
	resp, err := httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusConflict {
		return errSlugTaken
	}
	if resp.StatusCode != http.StatusOK {
		return errors.New(httpErr(resp))
	}
	return nil
}

func httpErr(resp *http.Response) string {
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
	var e struct {
		Error string `json:"error"`
	}
	if json.Unmarshal(data, &e) == nil && e.Error != "" {
		return e.Error
	}
	return resp.Status
}
