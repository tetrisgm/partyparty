package config

import (
	"flag"
	"os"
	"strconv"
)

// Config holds all tunables. CLI flags override env vars override defaults.
type Config struct {
	Port       int
	TLSPort    int // HTTPS guest-page listener (the advertised link — the Plex model)
	Name       string
	Bitrate    string
	Codec      string
	Channels   int
	SampleRate int
	HLSTime    int
	HLSList    int
	Device     string
	Tone       bool
	NoOpen     bool
	FFmpeg     string

	// LL-HLS (MediaMTX) settings. Delivery remains an internal broadcaster field
	// until the protected encoder cleanup, but production always sets "llhls".
	Delivery    string
	MediaMTXBin string
	RTSPPort    int
	HLSPort     int
	StreamPath  string
	Domain      string // public hostname for the cert/URL; "" = broker activation
	CertFile    string // real cert (fullchain); "" = self-signed
	KeyFile     string
	LiveHost    string // Plex-style low-latency host (auto cert + A record via Cloudflare); "" = off

	// Fixed LL-HLS profile verified with native iPhone playback.
	PartDur  string
	SegDur   string
	SegCount int // segments kept in the LL-HLS playlist

}

func Parse() Config {
	var c Config
	flag.IntVar(&c.Port, "port", envInt("PARTYPARTY_PORT", 8000), "HTTP port (localhost console + diagnostics; never advertised to guests)")
	flag.IntVar(&c.TLSPort, "tls-port", envInt("PARTYPARTY_TLS_PORT", 8443), "HTTPS port for the guest page — the only link guests ever see")
	flag.StringVar(&c.Name, "name", env("PARTYPARTY_NAME", "partyparty"), "display name shown to guests")
	flag.StringVar(&c.Device, "device", env("PARTYPARTY_DEVICE", "auto"), "default capture device index")
	flag.BoolVar(&c.Tone, "tone", false, "auto-start a 440 Hz test tone on launch")
	flag.BoolVar(&c.NoOpen, "no-open", false, "don't auto-open the DJ console in a browser (the native app hosts it in-window)")
	flag.StringVar(&c.FFmpeg, "ffmpeg", env("PARTYPARTY_FFMPEG", "ffmpeg"), "path to the ffmpeg binary")
	flag.StringVar(&c.MediaMTXBin, "mediamtx", env("PARTYPARTY_MEDIAMTX", ""), "path to mediamtx binary (default: found on PATH)")
	flag.IntVar(&c.RTSPPort, "rtsp-port", envInt("PARTYPARTY_RTSP_PORT", 8554), "MediaMTX RTSP ingest port")
	flag.IntVar(&c.HLSPort, "hls-port", envInt("PARTYPARTY_HLS_PORT", 8888), "MediaMTX LL-HLS (HTTPS) port")
	flag.StringVar(&c.StreamPath, "stream-path", env("PARTYPARTY_STREAM_PATH", "party"), "MediaMTX stream path name")
	flag.StringVar(&c.Domain, "domain", env("PARTYPARTY_DOMAIN", ""), "public hostname for guests (matches your cert); empty uses broker activation")
	flag.StringVar(&c.CertFile, "cert", env("PARTYPARTY_CERT", ""), "TLS cert (fullchain) for LL-HLS; empty = self-signed")
	flag.StringVar(&c.KeyFile, "key", env("PARTYPARTY_KEY", ""), "TLS private key for LL-HLS; empty = self-signed")
	flag.StringVar(&c.LiveHost, "live-host", env("PARTYPARTY_LIVE_HOST", ""), "hostname for automatic low-latency setup (Let's Encrypt cert + Cloudflare A record -> this Mac's LAN IP); needs PARTYPARTY_CF_TOKEN")
	flag.Parse()
	c.Bitrate = "320k"
	c.Codec = "aac_at"
	c.Channels = 2
	c.SampleRate = 48000
	c.HLSTime = 1
	c.HLSList = 24
	c.Delivery = "llhls"
	c.PartDur = "150ms"
	c.SegDur = "500ms"
	c.SegCount = 48
	return c
}

func env(key, def string) string {
	if v, ok := os.LookupEnv(key); ok {
		return v
	}
	return def
}

func envInt(key string, def int) int {
	if v, ok := os.LookupEnv(key); ok {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}
