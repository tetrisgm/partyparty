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
	Captive    bool
	Tone       bool
	NoOpen     bool
	FFmpeg     string

	// Delivery + LL-HLS (MediaMTX) settings.
	Delivery    string // "auto" (default: llhls only with a real domain+cert, else hls), "llhls", or "hls"
	MediaMTXBin string
	RTSPPort    int
	HLSPort     int
	StreamPath  string
	Domain      string // public hostname for the cert/URL; "" = plain-HLS IP until broker activation
	CertFile    string // real cert (fullchain); "" = self-signed
	KeyFile     string
	LiveHost    string // Plex-style low-latency host (auto cert + A record via Cloudflare); "" = off

	// LL-HLS tuning (MediaMTX). Defaults tuned for iPhone stability.
	PartDur  string // EXT-X-PART duration, e.g. "350ms"
	SegDur   string // HLS segment duration, e.g. "1s"
	SegCount int    // segments kept in the LL-HLS playlist

	// EXPERIMENTAL: negative seconds injected as #EXT-X-START:TIME-OFFSET into
	// the plain-HLS playlist to ask players to park closer to live than the
	// default 3x target duration. 0 = off. Spec says live offsets inside 3xTD
	// SHOULD NOT be used and iOS may ignore/misbehave — device-test only.
	StartOffset float64

	// LatencyTarget pins every listener to the same wall-clock delay behind the
	// DJ (seconds). 0 = auto (plain HLS varies by segment size; LL-HLS: 7).
	// The room dropping together matters more than absolute closeness to the DJ.
	LatencyTarget float64
}

func Parse() Config {
	var c Config
	flag.IntVar(&c.Port, "port", envInt("PARTYPARTY_PORT", 8000), "HTTP port (localhost console + diagnostics; never advertised to guests)")
	flag.IntVar(&c.TLSPort, "tls-port", envInt("PARTYPARTY_TLS_PORT", 8443), "HTTPS port for the guest page — the only link guests ever see")
	flag.StringVar(&c.Name, "name", env("PARTYPARTY_NAME", "partyparty"), "display name shown to guests")
	flag.StringVar(&c.Bitrate, "bitrate", env("PARTYPARTY_BITRATE", "320k"), "AAC audio bitrate (LAN has headroom — default to max quality)")
	flag.StringVar(&c.Codec, "codec", env("PARTYPARTY_CODEC", "aac_at"), "AAC encoder (aac_at = Apple, best on macOS; aac = portable fallback)")
	flag.IntVar(&c.SampleRate, "sample-rate", envInt("PARTYPARTY_SAMPLE_RATE", 48000), "audio sample rate")
	flag.IntVar(&c.HLSTime, "hls-time", envInt("PARTYPARTY_HLS_TIME", 1), "HLS segment length in seconds (lower = less latency, less drop-cushion)")
	flag.IntVar(&c.HLSList, "hls-list", envInt("PARTYPARTY_HLS_LIST", 24), "number of segments kept in the playlist (deep window: the room parks ~10s behind live and needs margin on both sides)")
	flag.StringVar(&c.Device, "device", env("PARTYPARTY_DEVICE", "auto"), "default capture device index")
	flag.BoolVar(&c.Captive, "captive", env("PARTYPARTY_CAPTIVE", "") == "1", "answer OS connectivity probes to trigger a captive portal")
	flag.BoolVar(&c.Tone, "tone", false, "auto-start a 440 Hz test tone on launch")
	flag.BoolVar(&c.NoOpen, "no-open", false, "don't auto-open the DJ console in a browser (the native app hosts it in-window)")
	flag.StringVar(&c.FFmpeg, "ffmpeg", env("PARTYPARTY_FFMPEG", "ffmpeg"), "path to the ffmpeg binary")
	mono := false
	flag.BoolVar(&mono, "mono", env("PARTYPARTY_MONO", "") == "1", "broadcast in mono (about half the bandwidth)")
	flag.StringVar(&c.Delivery, "delivery", env("PARTYPARTY_DELIVERY", "auto"), "delivery: auto (llhls if a real cert is set, else plain hls), llhls, or hls")
	flag.StringVar(&c.MediaMTXBin, "mediamtx", env("PARTYPARTY_MEDIAMTX", ""), "path to mediamtx binary (default: found on PATH)")
	flag.IntVar(&c.RTSPPort, "rtsp-port", envInt("PARTYPARTY_RTSP_PORT", 8554), "MediaMTX RTSP ingest port")
	flag.IntVar(&c.HLSPort, "hls-port", envInt("PARTYPARTY_HLS_PORT", 8888), "MediaMTX LL-HLS (HTTPS) port")
	flag.StringVar(&c.StreamPath, "stream-path", env("PARTYPARTY_STREAM_PATH", "party"), "MediaMTX stream path name")
	flag.StringVar(&c.Domain, "domain", env("PARTYPARTY_DOMAIN", ""), "public hostname for guests (matches your cert); empty = plain-HLS IP until broker activation")
	flag.StringVar(&c.CertFile, "cert", env("PARTYPARTY_CERT", ""), "TLS cert (fullchain) for LL-HLS; empty = self-signed")
	flag.StringVar(&c.KeyFile, "key", env("PARTYPARTY_KEY", ""), "TLS private key for LL-HLS; empty = self-signed")
	flag.StringVar(&c.LiveHost, "live-host", env("PARTYPARTY_LIVE_HOST", ""), "hostname for automatic low-latency setup (Let's Encrypt cert + Cloudflare A record -> this Mac's LAN IP); needs PARTYPARTY_CF_TOKEN")
	flag.StringVar(&c.PartDur, "part-duration", env("PARTYPARTY_PART_DUR", "500ms"), "LL-HLS part duration (Precise room profile: fine parts halve the start-position quantization and drop PART-HOLD-BACK to ~1.3s, growing the EXT-X-START pin's honor margin)")
	flag.StringVar(&c.SegDur, "seg-duration", env("PARTYPARTY_SEG_DUR", "1s"), "LL-HLS segment duration (1s puts the -3s room pin at the RFC 8216 three-target-duration boundary instead of inside the discouraged zone)")
	flag.IntVar(&c.SegCount, "seg-count", envInt("PARTYPARTY_SEG_COUNT", 12), "LL-HLS segments kept in the playlist. 12x1s = the room's FAILURE BUDGET: nothing older than 12s exists to play, so the worst possible device desync is 12s by construction (scrubs included). The drift watchdog re-attaches anyone sustained past target+8s=11s, so a deeper window was dead capability; a guest who falls off the back breaks cleanly and snaps back to the room.")
	flag.Float64Var(&c.StartOffset, "start-offset", 0, "EXPERIMENTAL: seconds before live to ask players to start (injects #EXT-X-START:TIME-OFFSET=-N into the plain-HLS playlist; 0 = off)")
	flag.Float64Var(&c.LatencyTarget, "latency-target", envFloat("PARTYPARTY_LATENCY_TARGET", 0), "wall-clock delay behind the DJ every listener aligns to, in seconds (0 = auto per delivery mode)")
	flag.Parse()
	c.Channels = 2
	if mono {
		c.Channels = 1
	}
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

func envFloat(key string, def float64) float64 {
	if v, ok := os.LookupEnv(key); ok {
		if f, err := strconv.ParseFloat(v, 64); err == nil {
			return f
		}
	}
	return def
}
