package event

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

const thumbQueueSize = 128

type thumbJob struct {
	mediaID string
	path    string
	typ     string
}

type thumbTools struct {
	sips   string
	ffmpeg string
}

var thumbLookPath = exec.LookPath

// StartThumbWorker feature-detects thumbnail tools once and starts the single
// low-contention worker. Uploads remain non-blocking even when the queue is
// full; skipped thumbnails simply fall back to originals in the clients.
func (s *Store) StartThumbWorker(ffmpeg string) {
	s.thumbOnce.Do(func() {
		tools := detectThumbTools(ffmpeg)
		s.thumbQ = make(chan thumbJob, thumbQueueSize)
		go s.runThumbWorker(tools)
	})
}

func detectThumbTools(ffmpeg string) thumbTools {
	var tools thumbTools
	if p, err := thumbLookPath("sips"); err == nil {
		tools.sips = p
	}
	if strings.TrimSpace(ffmpeg) != "" {
		if p, err := thumbLookPath(ffmpeg); err == nil {
			tools.ffmpeg = p
		}
	}
	return tools
}

// EnqueueThumb queues async thumbnail work for server-side media. It validates
// the id through MediaPath and never blocks the upload response.
func (s *Store) EnqueueThumb(mediaID, path, typ string) bool {
	if typ == "audio" || s.thumbQ == nil {
		return false
	}
	actual, ok := s.MediaPath(mediaID)
	if !ok || actual != path {
		return false
	}
	switch typ {
	case "image", "video":
	default:
		return false
	}
	select {
	case s.thumbQ <- thumbJob{mediaID: mediaID, path: path, typ: typ}:
		return true
	default:
		return false
	}
}

func (s *Store) runThumbWorker(tools thumbTools) {
	for job := range s.thumbQ {
		if err := s.makeThumb(tools, job); err == nil {
			_ = s.SetMediaThumb(job.mediaID)
		}
	}
}

func (s *Store) makeThumb(tools thumbTools, job thumbJob) error {
	if !validMediaID(job.mediaID) {
		return errors.New("bad media id")
	}
	if st, err := os.Stat(job.path); err != nil || st.IsDir() {
		return errors.New("missing media")
	}
	if filepath.Base(filepath.Dir(job.path)) != "media" {
		return errors.New("media outside event media dir")
	}
	thumbDir := filepath.Join(filepath.Dir(job.path), "thumbs")
	if err := os.MkdirAll(thumbDir, 0o755); err != nil {
		return err
	}
	dst := filepath.Join(thumbDir, thumbFileName(job.mediaID))
	tmp := filepath.Join(thumbDir, "."+thumbFileName(job.mediaID)+"."+time.Now().Format("150405.000000000")+".tmp")
	defer os.Remove(tmp)

	var cmd *exec.Cmd
	switch job.typ {
	case "image":
		if tools.sips == "" {
			return errors.New("sips unavailable")
		}
		cmd = exec.Command(tools.sips, "-Z", "640", job.path, "--out", tmp)
	case "video":
		if tools.ffmpeg == "" {
			return errors.New("ffmpeg unavailable")
		}
		cmd = exec.Command(tools.ffmpeg, "-y", "-ss", "0", "-i", job.path, "-frames:v", "1", "-vf", "scale=640:-2", tmp)
	default:
		return errors.New("unsupported thumbnail type")
	}
	if err := cmd.Run(); err != nil {
		return err
	}
	if st, err := os.Stat(tmp); err != nil || st.IsDir() || st.Size() == 0 {
		return errors.New("empty thumbnail")
	}
	return os.Rename(tmp, dst)
}
