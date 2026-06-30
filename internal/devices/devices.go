package devices

import (
	"os/exec"
	"regexp"
	"strconv"
	"strings"
)

type Device struct {
	Index   int    `json:"index"`
	Name    string `json:"name"`
	Virtual bool   `json:"virtual"` // a loopback/aggregate device usable to capture app/system audio
	Hint    string `json:"hint,omitempty"`
}

var lineRE = regexp.MustCompile(`\[(\d+)\]\s+(.*)$`)

// List asks FFmpeg to enumerate avfoundation inputs. FFmpeg prints the list to
// stderr and exits non-zero (no output specified) — that's expected.
func List(ffmpeg string) []Device {
	cmd := exec.Command(ffmpeg, "-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", "")
	var stderr strings.Builder
	cmd.Stderr = &stderr
	_ = cmd.Run()
	return Parse(stderr.String())
}

func Parse(stderr string) []Device {
	var devs []Device
	inAudio := false
	for _, line := range strings.Split(stderr, "\n") {
		if strings.Contains(line, "AVFoundation video devices") {
			inAudio = false
			continue
		}
		if strings.Contains(line, "AVFoundation audio devices") {
			inAudio = true
			continue
		}
		if !inAudio {
			continue
		}
		m := lineRE.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		idx, _ := strconv.Atoi(m[1])
		d := Device{Index: idx, Name: strings.TrimSpace(m[2])}
		classify(&d)
		devs = append(devs, d)
	}
	return devs
}

func classify(d *Device) {
	l := strings.ToLower(d.Name)
	switch {
	case strings.Contains(l, "blackhole"),
		strings.Contains(l, "soundflower"),
		strings.Contains(l, "loopback"),
		strings.Contains(l, "aggregate"),
		strings.Contains(l, "multi-output"),
		strings.Contains(l, "multi output"):
		d.Virtual = true
		d.Hint = "virtual device — route RekordBox or the Mac's audio here, then capture it"
	case strings.Contains(l, "microphone"), strings.Contains(l, " mic"):
		d.Hint = "built-in mic — picks up the room, usually not what you want"
	}
}

func HasVirtual(devs []Device) bool {
	for _, d := range devs {
		if d.Virtual {
			return true
		}
	}
	return false
}
