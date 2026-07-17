package main

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/tls"
	"embed"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"partyparty/internal/activate"
	"partyparty/internal/broadcast"
	"partyparty/internal/config"
	"partyparty/internal/diag"
	"partyparty/internal/dnsd"
	"partyparty/internal/event"
	"partyparty/internal/livemirror"
	"partyparty/internal/mediamtx"
	"partyparty/internal/netinfo"
	"partyparty/internal/ota"
	"partyparty/internal/publish"
	"partyparty/internal/server"
	"partyparty/internal/stats"
	postsync "partyparty/internal/sync"
)

//go:embed all:web
var webFS embed.FS

// appVersion is stamped by the build (-ldflags "-X main.appVersion=..."). It is
// shown in the UIs and broadcast to clients so stale player pages refresh
// themselves after an update instead of running old logic forever.
var appVersion = "dev"

// peekConn re-serves bytes already read off the wire (for first-byte sniffing).
type peekConn struct {
	net.Conn
	peeked []byte
}

func (c *peekConn) Read(p []byte) (int, error) {
	if len(c.peeked) > 0 {
		n := copy(p, c.peeked)
		c.peeked = c.peeked[n:]
		return n, nil
	}
	return c.Conn.Read(p)
}

// chanListener is a net.Listener fed pre-accepted conns from a channel — lets
// one raw port drive both an https server and an http-redirect server.
type chanListener struct {
	conns chan net.Conn
	addr  net.Addr
}

func (l *chanListener) Accept() (net.Conn, error) { return <-l.conns, nil }
func (l *chanListener) Close() error              { return nil }
func (l *chanListener) Addr() net.Addr            { return l.addr }

// telemetryLoop ships /api/status snapshots to the cloud while broadcasting.
func telemetryLoop(port int, bc *broadcast.Broadcaster) {
	if appVersion == "dev" {
		return // dev/`go run` instances must not pollute the install's cloud namespace
	}
	id, secret := activate.InstallCreds()
	if id == "" {
		return // never registered — nothing to authenticate with
	}
	base := os.Getenv("PARTYPARTY_BROKER")
	if base == "" {
		base = "https://partyparty.party"
	}
	cl := &http.Client{Timeout: 10 * time.Second}
	for {
		time.Sleep(30 * time.Second)
		if bc.Status().State != "live" {
			continue
		}
		resp, err := cl.Get(fmt.Sprintf("http://127.0.0.1:%d/api/status", port))
		if err != nil {
			continue
		}
		var snap json.RawMessage
		err = json.NewDecoder(resp.Body).Decode(&snap)
		resp.Body.Close()
		if err != nil {
			continue
		}
		body, _ := json.Marshal(map[string]any{"id": id, "secret": secret, "snap": snap})
		if r, err := cl.Post(base+"/api/broker/telemetry", "application/json", bytes.NewReader(body)); err == nil {
			r.Body.Close()
		}
	}
}

// brokerBase resolves the broker URL (PARTYPARTY_BROKER, else the prod default),
// matching every other broker call in this file.
func brokerBase() string {
	if base := os.Getenv("PARTYPARTY_BROKER"); base != "" {
		return base
	}
	return "https://partyparty.party"
}

const maxLiveAckBytes = 256 << 10

type liveAck struct {
	WebListeners int `json:"webListeners"`
	WebPosts     []struct {
		ID     string `json:"id"`
		Author string `json:"author"`
		Emoji  string `json:"emoji"`
		Text   string `json:"text"`
		TS     int64  `json:"ts"`
	} `json:"webPosts"`
}

type webPostAdder interface {
	AddWebPost(webID, author, emoji, text string, ts int64) (bool, error)
}

func decodeLiveAck(resp *http.Response) (liveAck, error) {
	var ack liveAck
	if resp.StatusCode != http.StatusOK {
		return ack, fmt.Errorf("broker returned %s", resp.Status)
	}
	if resp.ContentLength > maxLiveAckBytes {
		return ack, fmt.Errorf("broker response exceeds %d bytes", maxLiveAckBytes)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxLiveAckBytes+1))
	if err != nil {
		return ack, fmt.Errorf("read broker response: %w", err)
	}
	if len(data) > maxLiveAckBytes {
		return ack, fmt.Errorf("broker response exceeds %d bytes", maxLiveAckBytes)
	}
	if err := json.Unmarshal(data, &ack); err != nil {
		return ack, fmt.Errorf("decode broker response: %w", err)
	}
	return ack, nil
}

func ingestLiveAck(ack liveAck, posts webPostAdder, handler *server.Srv, webSince *int64, logf func(string, ...any)) {
	if handler != nil {
		handler.SetWebListeners(ack.WebListeners)
	}
	if posts == nil {
		return
	}
	for _, wp := range ack.WebPosts {
		added, err := posts.AddWebPost(wp.ID, wp.Author, wp.Emoji, wp.Text, wp.TS)
		if err != nil {
			logf("web post inject failed: %v", err)
			return // ordered batch: never advance the cursor past an unpersisted post
		}
		if added {
			logf("web post joined the room feed: %s (%s)", wp.ID, wp.Author)
		}
		if wp.TS > *webSince {
			*webSince = wp.TS
		}
	}
}

func recordLiveCheckinFailure(beatFails *int, handler *server.Srv, logf func(string, ...any), err error) {
	*beatFails++
	// A venue can be offline for hours. Record the first failure immediately,
	// then one reminder every five minutes instead of writing the same line on
	// every 30-second heartbeat forever.
	if *beatFails == 1 || *beatFails%10 == 0 {
		logf("live check-in failed (%d consecutive): %v", *beatFails, err)
	}
	if *beatFails >= 3 && handler != nil {
		handler.SetWebListeners(0)
	}
}

// liveCheckinLoop is the auto-discovery presence heartbeat: while broadcasting,
// POST /api/broker/live every 30s with {id, secret, lan_ip, title, now_playing}
// so the broker can match guests on the same public IP to this party. On the
// live->idle edge it posts /api/broker/offline so a clean stop removes the party
// instantly (the broker's TTL is only the crash backstop). A sibling to
// telemetryLoop but NOT gated on PARTYPARTY_TELEMETRY — discovery must not hinge
// on a debug toggle. Best-effort throughout: failures are sampled into the
// diagnostic log and none of this work blocks the broadcast.
func liveCheckinLoop(bc *broadcast.Broadcaster, events *event.Store, dl *diag.Logger, guestPort int, handler *server.Srv) {
	if appVersion == "dev" {
		return // dev/`go run` must not advertise the install's cloud namespace
	}
	id, secret := activate.InstallCreds()
	if id == "" {
		return // never registered — nothing to authenticate with
	}
	base := brokerBase()
	cl := &http.Client{Timeout: 10 * time.Second}
	logf := func(format string, args ...any) {
		if dl != nil {
			dl.Printf(format, args...)
		}
	}
	wasLive := false
	var lastBeat time.Time
	var webSince int64 // max web-post ts ingested (the check-in delivery cursor)
	beatFails := 0
	for {
		// Poll faster than the 30s heartbeat so the live->idle edge (a Stop that
		// doesn't quit the app) drops presence promptly; the beat itself is still
		// rate-limited to ~30s below.
		time.Sleep(5 * time.Second)
		live := bc.Status().State == "live"
		switch {
		case live:
			if wasLive && time.Since(lastBeat) < 30*time.Second {
				continue // not due yet
			}
			title, nowPlaying := "", ""
			if events != nil {
				title = events.Meta().Title
				nowPlaying = liveNowPlaying(events)
			}
			lanListeners := 0
			if handler != nil {
				lanListeners = handler.ActiveListeners()
			}
			body, _ := json.Marshal(map[string]any{
				"id": id, "secret": secret,
				"lan_ip":      netinfo.PrimaryLanIP(),
				"guest_port":  guestPort, // the :port guests need to reach this Mac's HTTPS listener
				"listeners":   lanListeners,
				"web_since":   webSince, // delivery cursor: only web posts newer than what we've ingested
				"title":       title,
				"now_playing": nowPlaying,
			})
			if r, err := cl.Post(base+"/api/broker/live", "application/json", bytes.NewReader(body)); err == nil {
				// The web side of the party rides back on this heartbeat: the
				// cloud-mirror listener count for the room's combined tally, and
				// web guests' wall posts to inject into the ROOM feed (deduped by
				// cloud id inside AddWebPost, so replays are always safe).
				ack, ackErr := decodeLiveAck(r)
				r.Body.Close()
				if ackErr == nil {
					beatFails = 0
					ingestLiveAck(ack, events, handler, &webSince, logf)
				} else {
					// A broker outage or captive-portal HTML must not leave a stale
					// "M online" painted on the console for the rest of the set.
					recordLiveCheckinFailure(&beatFails, handler, logf, ackErr)
				}
			} else {
				recordLiveCheckinFailure(&beatFails, handler, logf, err)
			}
			lastBeat = time.Now()
			wasLive = true
		case wasLive:
			if handler != nil {
				handler.SetWebListeners(0)
			}
			postLiveOffline(base, id, secret, cl, logf)
			wasLive = false
			lastBeat = time.Time{}
		}
	}
}

// postLiveOffline tells the broker this Mac is no longer live (removes it from
// auto-discovery). Best-effort; logf may be nil.
func postLiveOffline(base, id, secret string, cl *http.Client, logf func(string, ...any)) {
	body, _ := json.Marshal(map[string]any{"id": id, "secret": secret})
	if r, err := cl.Post(base+"/api/broker/offline", "application/json", bytes.NewReader(body)); err == nil {
		r.Body.Close()
	} else if logf != nil {
		logf("live offline post failed: %v", err)
	}
}

// liveNowPlaying renders the DJ's current track for the discovery banner
// ("Title — Artist"), or "" when nothing is shared.
func liveNowPlaying(events *event.Store) string {
	current, _ := events.TrackSnapshot()
	if current == nil {
		return ""
	}
	if current.Artist != "" {
		return current.Title + " — " + current.Artist
	}
	return current.Title
}

// startLiveMirror runs the cloud-mirror uploader across the broadcast lifecycle:
// one livemirror session per go-live (started on the active edge, torn down when
// the set settles to idle/error). A device-yank rebuild dips through
// stopping/idle briefly and is treated as still-active so the upload session —
// and the scratch dir it watches — survive the rebuild. Off entirely unless the
// mirror leg is configured and this install is registered.
func startLiveMirror(scratch string, bc *broadcast.Broadcaster, events *event.Store, dl *diag.Logger) {
	if appVersion == "dev" {
		return
	}
	id, secret := activate.InstallCreds()
	if id == "" {
		return // never registered — uploads would only 401
	}
	logf := log.Printf
	if dl != nil {
		logf = dl.Printf
	}
	m := livemirror.New(livemirror.Config{
		Base:       brokerBase(),
		Creds:      livemirror.Creds{ID: id, Secret: secret},
		ScratchDir: scratch,
		SlugFn: func() string {
			metaSlug := ""
			if events != nil {
				metaSlug = events.Meta().Slug
			}
			return publish.SlugForEvent(metaSlug, activate.InstallSlug())
		},
		Logf: logf,
	})
	go func() {
		var cancel context.CancelFunc
		active := false
		for {
			time.Sleep(2 * time.Second)
			st := bc.Status().State
			isActive := st == "live" || st == "starting" || st == "stopping"
			switch {
			case isActive && !active:
				active = true
				session := strconv.FormatInt(time.Now().UnixMilli(), 10)
				var ctx context.Context
				ctx, cancel = context.WithCancel(context.Background())
				go m.Run(ctx, session)
			case !isActive && active:
				active = false
				if cancel != nil {
					cancel()
					cancel = nil
				}
			}
		}
	}()
}

func main() {
	cfg := config.Parse()

	web, err := fs.Sub(webFS, "web")
	if err != nil {
		log.Fatal(err)
	}

	runDir := filepath.Join(os.TempDir(), "partyparty-run")
	if err := os.MkdirAll(runDir, 0o755); err != nil {
		log.Fatal(err)
	}

	// Over-the-air payload store — created FIRST so its config.json can adjust
	// the streaming config before MediaMTX and the broadcaster are built from
	// it. The store is an fs.FS serving the embedded copy until a newer verified
	// cloud payload is adopted; the server reads all web content through it. Dev
	// builds and telemetry-off instances never fetch. diagLog is assigned later
	// (the diagnostics log opens below) — the store's logger closes over it.
	var diagLog *diag.Logger
	var payload *ota.Store
	{
		embVer := 0
		if b, rerr := fs.ReadFile(web, "PAYLOAD_VERSION"); rerr == nil {
			embVer, _ = strconv.Atoi(strings.TrimSpace(string(b)))
		}
		contentBase := ""
		if appVersion != "dev" && os.Getenv("PARTYPARTY_TELEMETRY") != "0" {
			base := os.Getenv("PARTYPARTY_BROKER")
			if base == "" {
				base = "https://partyparty.party"
			}
			contentBase = base + "/content"
		}
		sd, _ := activate.StateDir()
		diagf := func(f string, a ...any) {
			if diagLog != nil {
				diagLog.Printf(f, a...)
			}
		}
		if st, oerr := ota.Open(web, embVer, sd, contentBase, appVersion, diagf); oerr == nil {
			payload = st
		} else {
			log.Printf("ota disabled: %v", oerr)
		}
	}

	// Apply OTA server overrides (bitrate, channels, HLS/LL timing, latency
	// target) from the payload's config.json BEFORE anything is built from cfg.
	// Every value is strictly validated, so an accepted override is always a safe
	// pipeline setting; a bad or absent config leaves the built-in defaults
	// untouched. MediaMTX LL-timing takes effect from launch; the broadcaster
	// re-reads the encode params on each Go Live.
	if payload != nil {
		cfg = cfg.WithOverrides(config.ParseOverrides(payload.Config()))
	}

	// Resolve the capture helper + ffmpeg. In the default build these extract from
	// the embedded copies; in the signed .app build (-tags bundle) they resolve to
	// the pre-signed binaries in Contents/Helpers/.
	helperPath := helperPPCapture(runDir)
	if cfg.FFmpeg == "ffmpeg" {
		if p := helperFFmpeg(runDir); p != "" {
			cfg.FFmpeg = p
		}
	}

	// Low-latency activation is ASYNC (see below, after the server is up): a
	// first cert issuance takes 30s-3min and blocking startup on it means a
	// dead console ("white screen") the whole time. The server starts on plain
	// HLS immediately; a completed activation flips delivery live.
	if cfg.LiveHost == "" {
		cfg.LiveHost = activate.HostFromEnvOrFile()
	}
	activationHost := func() string {
		if cfg.LiveHost != "" {
			return cfg.LiveHost
		}
		if cfg.Domain != "" {
			return cfg.Domain
		}
		return activate.BrokerHost()
	}
	deliveryFlag := cfg.Delivery // what the user asked for, pre-resolution

	// LL-HLS is served over HTTPS; without a real (publicly-trusted) cert the
	// self-signed cert on a bare LAN IP is rejected by iOS Safari, so guests would
	// get a stream they can't play. "auto" therefore picks LL-HLS only when a real
	// domain+cert is configured explicitly; otherwise plain HLS now, upgraded in
	// the background by activation. Passing --delivery llhls explicitly still
	// forces it (e.g. testing with a trusted self-signed cert on the phone).
	// HTTPS + LL-HLS is the ONLY real-world delivery path — there is no silent
	// plain-HLS downgrade. "auto" always resolves to LL-HLS; without a cert, Go
	// Live is refused (fail loud) and the offline party rides the cached cert.
	// -delivery=hls remains only as a non-default dev/emergency escape hatch.
	if cfg.Delivery == "auto" {
		cfg.Delivery = "llhls"
	}

	ip := netinfo.PrimaryLanIP()
	sharedIP := netinfo.SharedLanIP()
	// 127.0.0.1, NOT "localhost": MediaMTX binds its RTSP ingest to 127.0.0.1
	// (IPv4 loopback) only. On Macs where "localhost" resolves to ::1 (IPv6)
	// first, ffmpeg's RTSP publish hits [::1]:RTSP → Connection refused → the
	// tee's onfail=ignore drops it silently → MediaMTX never gets the stream and
	// guests get "no stream available on path 'party'" (the DJ still shows "live"
	// off the recording leg). Match the bind address exactly. Field-confirmed.
	ingestURL := fmt.Sprintf("rtsp://127.0.0.1:%d/%s", cfg.RTSPPort, cfg.StreamPath)

	bc := broadcast.New(cfg, runDir, helperPath, ingestURL)
	ls := stats.New(20 * time.Second)

	// Cloud mirror (remote-guest HLS via R2, opt-in --cloud-mirror): point the
	// broadcaster's ISOLATED third tee leg at a scratch dir under runDir. The
	// uploader that ships it starts near the telemetry loop below, once the event
	// store + diagnostics exist. Off by default — the leg is absent and the
	// pipeline (LAN RTSP + optional record) is byte-for-byte what it is today.
	// The scratch dir is a subdir of runDir, so cleanRunDir (which only sweeps
	// runDir's own *.m3u8/*.ts) never touches it.
	var mirrorScratch string
	if cfg.CloudMirror {
		mirrorScratch = filepath.Join(runDir, "livemirror")
		if err := os.MkdirAll(mirrorScratch, 0o755); err != nil {
			log.Printf("cloud mirror disabled: scratch dir %s: %v", mirrorScratch, err)
			mirrorScratch = ""
		} else {
			bc.SetMirrorDir(mirrorScratch)
		}
	}

	var localDNS *dnsd.Server
	var dnsCancel context.CancelFunc
	var refreshLocalDNS func(host string)
	var captiveDNSHost string
	if cfg.Captive {
		host := activationHost()
		hosts := captiveDNSHosts(host)
		captiveDNSHost = strings.Join(hosts, ", ")
		localDNS = dnsd.New(dnsd.Config{
			Addr:     dnsd.LocalAddr,
			Hosts:    hosts,
			TargetIP: sharedIP,
			TTL:      5 * time.Second,
			CatchAll: true,
			Logf: func(format string, args ...any) {
				if diagLog != nil {
					diagLog.Printf(format, args...)
					return
				}
				log.Printf(format, args...)
			},
		})
		if err := localDNS.Start(); err != nil {
			log.Printf("dns: captive DNS failed on %s: %v", dnsd.LocalAddr, err)
			localDNS = nil
		} else {
			log.Printf("dns: captive DNS answering %s plus catch-all -> %s on %s", captiveDNSHost, sharedIP, dnsd.LocalAddr)
			refreshLocalDNS = func(host string) {
				if host == "" {
					host = activationHost()
				}
				if localDNS == nil {
					return
				}
				localDNS.Update(captiveDNSHosts(host), netinfo.SharedLanIP())
			}
			var dnsCtx context.Context
			dnsCtx, dnsCancel = context.WithCancel(context.Background())
			go func() {
				t := time.NewTicker(5 * time.Second)
				defer t.Stop()
				for {
					select {
					case <-t.C:
						refreshLocalDNS("")
					case <-dnsCtx.Done():
						return
					}
				}
			}()
		}
	}

	// MediaMTX (LL-HLS): embedded+extracted in dev, or from Contents/Helpers/ in
	// the .app build; fall back to PATH if neither is present.
	mtxBinPath := cfg.MediaMTXBin
	if mtxBinPath == "" {
		if p := helperMediaMTX(runDir); p != "" {
			mtxBinPath = p
		} else if p, err := mediamtx.Find(""); err == nil {
			mtxBinPath = p // fall back to PATH
		}
	}

	var mtx *mediamtx.Server
	var applyActivation func(certFile, keyFile string) error
	if mtxBinPath != "" {
		certPath, keyPath := cfg.CertFile, cfg.KeyFile
		if certPath == "" || keyPath == "" {
			certPath = filepath.Join(runDir, "cert.pem")
			keyPath = filepath.Join(runDir, "key.pem")
			hosts := []string{"localhost", netinfo.LocalHostname()}
			if cfg.Domain != "" {
				hosts = append(hosts, cfg.Domain)
			}
			if err := mediamtx.GenerateSelfSignedCert(certPath, keyPath, []string{ip, "127.0.0.1"}, hosts); err != nil {
				log.Fatalf("cert generation failed: %v", err)
			}
		}
		cfgPath := filepath.Join(runDir, "mediamtx.yml")
		writeMTXConfig := func() error {
			return mediamtx.WriteConfig(cfgPath, mediamtx.ConfigOpts{
				RTSPPort: cfg.RTSPPort, HLSPort: cfg.HLSPort, Path: cfg.StreamPath,
				CertPath: certPath, KeyPath: keyPath, SegDur: cfg.SegDur, PartDur: cfg.PartDur, SegCount: cfg.SegCount,
			})
		}
		if err := writeMTXConfig(); err != nil {
			log.Fatalf("mediamtx config failed: %v", err)
		}
		// Reap orphaned MediaMTX from force-quit runs: an orphan squats on the
		// RTSP/HLS ports with a STALE config+cert, our replacement loses the
		// bind, and guests get a stream no phone will accept while everything
		// LOOKS engaged (field: friend broadcast 6 minutes to zero joinable
		// guests). Reap by PORT OWNERSHIP — the orphan may be an old app
		// version at a different binary path, so path matching isn't enough.
		if n := mediamtx.ReapOrphans(cfg.RTSPPort, cfg.HLSPort); n > 0 {
			log.Printf("reaped %d orphaned mediamtx process(es) from a previous run", n)
		}
		mtx = mediamtx.NewServer(mtxBinPath, cfgPath, bc.ExternalWriter())
		// One fixed LL timing profile (part/seg/count from config) — the old
		// per-latency-mode MediaMTX bouncing is gone with the latency selector.
		// Called by async activation: swap in the real cert and rewrite the
		// MediaMTX config (MediaMTX isn't running yet in plain-HLS mode).
		applyActivation = func(certFile, keyFile string) error {
			certPath, keyPath = certFile, keyFile
			return writeMTXConfig()
		}
		if cfg.Delivery == "llhls" {
			if err := ensureMTXReady(mtx, cfg.RTSPPort, cfg.HLSPort); err != nil {
				// No silent downgrade: stay LL-HLS. /api/start reaps + retries
				// MediaMTX and refuses Go Live if it truly can't start, rather than
				// serving a degraded plain-HLS stream nobody asked for.
				log.Printf("mediamtx failed to start: %v — LL-HLS unavailable (no plain-HLS fallback)", err)
			}
		}
	} else if cfg.Delivery == "llhls" {
		log.Printf("mediamtx binary unavailable — LL-HLS cannot start (no plain-HLS fallback)")
	}
	// Session diagnostics (the Plex model): one verbose file per run in
	// ~/Library/Logs/partyparty, teeing the stdlib logger AND the broadcast
	// log ring, plus structured events (hardware, activation, guest joins,
	// room snapshots). Shipped to the cloud below so field problems can be
	// diagnosed without asking anyone to screenshot a console.
	if home, err := os.UserHomeDir(); err == nil {
		if dl, err := diag.Open(filepath.Join(home, "Library", "Logs", "partyparty")); err == nil {
			diagLog = dl
			log.SetOutput(io.MultiWriter(os.Stderr, diagLog))
			id, _ := activate.InstallCreds()
			diagLog.Printf("partyparty v%s starting (%s)", appVersion, diagLog.Session())
			diagLog.Printf("system: macOS %s · %s · %s", cmdOut("sw_vers", "-productVersion"), cmdOut("sysctl", "-n", "hw.model"), runtime.GOARCH)
			diagLog.Printf("install: id=%s slug=%s", id, activate.InstallSlug())
			diagLog.Printf("network: lan=%s shared=%s interfaces=%+v", ip, sharedIP, netinfo.LanInterfaces())
			diagLog.Printf("config: delivery=%s bitrate=%s part=%s seg=%s", cfg.Delivery, cfg.Bitrate, cfg.PartDur, cfg.SegDur)
			if localDNS != nil && captiveDNSHost != "" {
				diagLog.Printf("dns: captive DNS answering %s plus catch-all -> %s on %s", captiveDNSHost, sharedIP, dnsd.LocalAddr)
			}
			if payload != nil {
				// The store's own "serving cached payload" line is emitted during
				// Open() above, before this logger exists — so record the active
				// payload version here for the shipped diagnostics.
				diagLog.Printf("ota: serving payload %d (runtime %d)", payload.PayloadVersion(), ota.RuntimeVersion)
			}
			bc.SetDiag(diagLog)
		} else {
			log.Printf("diagnostics log unavailable: %v", err)
		}
	}
	if cfg.Captive {
		go func() {
			time.Sleep(8 * time.Second)
			if ip := netinfo.SharedBridgeIP(); ip != "" {
				if diagLog != nil {
					diagLog.Printf("hotspot: Internet Sharing bridge up at %s", ip)
					return
				}
				log.Printf("hotspot: Internet Sharing bridge up at %s", ip)
				return
			}
			if diagLog != nil {
				diagLog.Printf("hotspot: no bridge detected — sharing may not have started (guide user to enable it)")
				return
			}
			log.Printf("hotspot: no bridge detected — sharing may not have started (guide user to enable it)")
		}()
	}

	// The event's social layer lives in a normal, Finder-visible folder — the
	// DJ can open it and drag media/recordings straight out. Feed, uploads,
	// and set recordings all land here; a restart mid-party resumes the same
	// event. Fail-soft: no store just means no feed, never no broadcast.
	var events *event.Store
	if home, err := os.UserHomeDir(); err == nil {
		if st, err := event.Open(filepath.Join(home, "Music", "partyparty")); err == nil {
			events = st
			events.StartThumbWorker(cfg.FFmpeg)
		} else {
			log.Printf("event store unavailable: %v — feed disabled", err)
		}
	}

	// The broadcaster re-reads OTA encode overrides (bitrate, channels, HLS
	// timing) on each Go Live, so a config pushed mid-session takes effect on the
	// next broadcast without a relaunch. Then start the update loop (push + the
	// periodic floor). Both are wired now that diagLog and bc exist.
	if payload != nil {
		bc.SetOverrides(func() config.Overrides {
			return config.ParseOverrides(payload.Config())
		})
		go payload.Run(context.Background())
	}

	handler := server.New(server.Deps{
		Config:      cfg,
		Broadcaster: bc,
		Listeners:   ls,
		RunDir:      runDir,
		Web:         web,
		Payload:     payload,
		MTX:         mtx,
		Events:      events,
		Diag:        diagLog,
		Version:     appVersion,
	})
	handler.StartSyncDrain(context.Background())
	handler.StartReachabilityWatchdog(context.Background())

	ln, err := net.Listen("tcp", fmt.Sprintf(":%d", cfg.Port))
	if err != nil && errors.Is(err, syscall.EADDRINUSE) {
		// Almost certainly our own orphan: a force-quit app skips child cleanup
		// and the old server squats on the port. Ask it to exit (loopback-only
		// endpoint) and retry once.
		cl := &http.Client{Timeout: 2 * time.Second}
		if resp, perr := cl.Post(fmt.Sprintf("http://127.0.0.1:%d/api/shutdown", cfg.Port), "", nil); perr == nil {
			resp.Body.Close()
			time.Sleep(700 * time.Millisecond)
			if ln, err = net.Listen("tcp", fmt.Sprintf(":%d", cfg.Port)); err == nil {
				log.Printf("recovered port %d from a previous instance", cfg.Port)
			}
		}
	}
	if err != nil {
		if errors.Is(err, syscall.EADDRINUSE) {
			fmt.Printf("\n  Port %d is already in use. Try: partyparty --port 8001\n\n", cfg.Port)
			os.Exit(1)
		}
		log.Fatal(err)
	}

	handler.StartDiscovery() // Bonjour: resolve guest IPs → friendly device names

	httpSrv := &http.Server{Handler: handler}
	go func() {
		if err := httpSrv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatal(err)
		}
	}()

	// HTTPS guest listener (the Plex model): the ADVERTISED link is
	// https://<domain>:<tls-port>/ — the page itself rides the activated cert,
	// so a guest who can load it is guaranteed to be able to play the LL
	// stream (same DNS + TLS). The listener starts now with a hot-loadable
	// cert; connections before activation simply fail, and no URL is
	// advertised until the cert is in.
	var certMu sync.Mutex
	var liveCert *tls.Certificate
	loadCert := func(certFile, keyFile string) error {
		c, err := tls.LoadX509KeyPair(certFile, keyFile)
		if err != nil {
			return err
		}
		certMu.Lock()
		liveCert = &c
		certMu.Unlock()
		return nil
	}
	var activationMu sync.Mutex
	activationEngaged := false
	markActivationEngaged := func() {
		activationMu.Lock()
		activationEngaged = true
		activationMu.Unlock()
	}
	isActivationEngaged := func() bool {
		activationMu.Lock()
		defer activationMu.Unlock()
		return activationEngaged
	}
	engageLowLatency := func(source string) {
		if deliveryFlag == "hls" || mtx == nil || applyActivation == nil {
			return
		}
		// Auto-engage after a real certificate is available. Native HLS remains
		// the iPhone path so background and lock-screen playback stay under
		// AVPlayer; the guest page performs bounded wall-clock alignment while it
		// is visible. Engage when idle and never restart a live set.
		for {
			st := bc.Status()
			if st.State == "idle" || st.State == "error" {
				if bc.Delivery() != "hls" {
					return
				}
				if err := ensureMTXReady(mtx, cfg.RTSPPort, cfg.HLSPort); err != nil {
					log.Printf("activate: mediamtx not ready after %s: %v — staying on plain HLS", source, err)
					return
				}
				// Atomic idle-check + switch: a set that started during
				// EnsureReady's up-to-6s wait must NOT be yanked
				// (SetDelivery stops any broadcast). If one snuck in, loop
				// and wait for the next idle gap.
				if bc.SetDeliveryIfIdle("llhls") {
					log.Printf("activate: low-latency room engaged (%s)", source)
					return
				}
			}
			time.Sleep(5 * time.Second)
		}
	}
	applyActivationResult := func(res activate.Result, source string) bool {
		handler.SetActivationResult(res)
		if !res.OK {
			return false
		}
		if applyActivation != nil {
			if err := applyActivation(res.CertFile, res.KeyFile); err != nil {
				log.Printf("activate: mediamtx config failed after %s: %v — staying on plain HLS", source, err)
				return false
			}
		}
		if err := loadCert(res.CertFile, res.KeyFile); err != nil {
			log.Printf("activate: cert load for the guest page failed after %s: %v", source, err)
			return false
		}
		if refreshLocalDNS != nil {
			refreshLocalDNS(res.Host)
		}
		handler.SetActivation(res.Host)
		markActivationEngaged()
		log.Printf("activate: secure link ready from %s — %s", source, res.Host)
		engageLowLatency(source)
		return true
	}
	explicitCertLoaded := false
	if cfg.CertFile != "" && cfg.KeyFile != "" {
		if err := loadCert(cfg.CertFile, cfg.KeyFile); err != nil {
			log.Printf("tls: explicit cert failed to load: %v", err)
		} else {
			explicitCertLoaded = true
		}
	}
	// Boot fast path: a cert issued on a previous run is cached (~90-day
	// validity), so load it SYNCHRONOUSLY here before we serve. Otherwise the
	// listener comes up with no cert, the DJ's already-open phone tab hammers
	// it ("certificate not provisioned yet" x4 in every session log), and the
	// console flashes "setting up the secure link" until async activation
	// re-fetches. With the cache, the guest link is live and Go Live un-gated
	// from t=0; async activation still runs to renew / engage LL.
	if !explicitCertLoaded && cfg.CertFile == "" {
		if res, ok := activate.CachedCertReady(activationHost()); ok {
			applyActivationResult(res, "cached certificate")
		}
	}
	if rawLn, err := net.Listen("tcp", fmt.Sprintf(":%d", cfg.TLSPort)); err == nil {
		tlsSrv := &http.Server{
			Handler: handler,
			TLSConfig: &tls.Config{GetCertificate: func(*tls.ClientHelloInfo) (*tls.Certificate, error) {
				certMu.Lock()
				defer certMu.Unlock()
				if liveCert == nil {
					return nil, errors.New("certificate not provisioned yet")
				}
				return liveCert, nil
			}},
		}
		// Plaintext hitting the HTTPS port (old QR, hand-typed http://) would get
		// Go's ugly "Client sent an HTTP request to an HTTPS server" — redirect
		// to https instead. We can't run http and https on one port with stock
		// listeners, so sniff the first byte: 0x16 = TLS handshake → the TLS
		// server; anything else → a 301-to-https server.
		redirectSrv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			http.Redirect(w, r, "https://"+r.Host+r.URL.RequestURI(), http.StatusMovedPermanently)
		})}
		tlsCh := &chanListener{conns: make(chan net.Conn), addr: rawLn.Addr()}
		httpCh := &chanListener{conns: make(chan net.Conn), addr: rawLn.Addr()}
		go func() {
			if err := tlsSrv.ServeTLS(tlsCh, "", ""); err != nil && !errors.Is(err, http.ErrServerClosed) {
				log.Printf("tls listener: %v", err)
			}
		}()
		go func() { _ = redirectSrv.Serve(httpCh) }()
		go func() {
			for {
				c, aerr := rawLn.Accept()
				if aerr != nil {
					return
				}
				go func(c net.Conn) {
					b := make([]byte, 1)
					_ = c.SetReadDeadline(time.Now().Add(10 * time.Second))
					n, rerr := c.Read(b)
					_ = c.SetReadDeadline(time.Time{})
					if rerr != nil || n == 0 {
						c.Close()
						return
					}
					pc := &peekConn{Conn: c, peeked: b[:n]}
					if b[0] == 0x16 { // TLS ClientHello
						tlsCh.conns <- pc
					} else {
						httpCh.conns <- pc
					}
				}(c)
			}
		}()
		// The https listener is UP: if an explicit cert also loaded, the secure
		// guest link is real — this (not raw config presence) is what un-gates
		// Go Live and the advertised https URL. Async activation performs the
		// equivalent SetActivation after its own successful cert load.
		if explicitCertLoaded && cfg.Domain != "" {
			handler.SetActivation(cfg.Domain)
		}
	} else {
		log.Printf("tls listener failed on :%d: %v — the https guest link is unavailable", cfg.TLSPort, err)
		handler.SetActivationPending(fmt.Sprintf("port %d is taken by another app — quit it and relaunch partyparty", cfg.TLSPort))
	}

	// Background low-latency activation (the Plex pattern) — the console is
	// already serving; this never blocks startup. Two paths, both fail-soft:
	// BYO (live-host + user's Cloudflare token) or the zero-config cert broker
	// at partyparty.party (per-install slugged domain + DNS-01 cert).
	// Cached-cert engagement above is local-only and does not wait for this
	// loop. Online refresh keeps trying to upsert DNS / issue + renew the cert;
	// failures never tear down an already-engaged cached cert. Runs whenever we
	// have no explicit cert — delivery is always LL-HLS now, so the old
	// cfg.Delivery=="hls" gate would have (wrongly) disabled all online
	// issuance/renewal.
	if deliveryFlag != "hls" && cfg.CertFile == "" && mtx != nil && applyActivation != nil {
		networkChanged := make(chan struct{}, 1)
		go func() {
			lastIP := netinfo.PrimaryLanIP()
			ticker := time.NewTicker(2 * time.Second)
			defer ticker.Stop()
			for range ticker.C {
				currentIP := netinfo.PrimaryLanIP()
				parsed := net.ParseIP(currentIP)
				if currentIP == "" || currentIP == lastIP || parsed == nil || parsed.IsLoopback() {
					continue
				}
				lastIP = currentIP
				select {
				case networkChanged <- struct{}{}:
				default:
				}
			}
		}()
		go func() {
			retryIn := 15 * time.Second // fast first retries (LE 503s often clear in seconds), then back off
			waitForRefresh := func(delay time.Duration) {
				timer := time.NewTimer(delay)
				defer timer.Stop()
				select {
				case <-networkChanged:
					log.Printf("activate: LAN address changed to %s — refreshing the secure guest link now", netinfo.PrimaryLanIP())
				case <-timer.C:
				}
			}
			for {
				var res activate.Result
				liveHost := cfg.LiveHost
				if liveHost == "" {
					liveHost = cfg.Domain
				}
				if token := activate.TokenFromEnvOrFile(); liveHost != "" && token != "" {
					res = activate.Try(liveHost, token, netinfo.PrimaryLanIP(), log.Printf)
				} else {
					broker := os.Getenv("PARTYPARTY_BROKER")
					if broker == "" {
						broker = "https://partyparty.party"
					}
					res = activate.TryBroker(broker, netinfo.PrimaryLanIP(), log.Printf)
				}
				handler.SetActivationResult(res)
				if res.OK {
					if applyActivationResult(res, "online refresh") {
						retryIn = 15 * time.Second
						waitForRefresh(30 * time.Minute)
						continue
					}
					if res.Reason == "" {
						res.Reason = "local activation apply failed"
					}
				}
				if !isActivationEngaged() {
					handler.SetActivationPending(humanizeActivation(res.Reason))
					log.Printf("activate: secure link not ready — %s (retrying in %s)", res.Reason, retryIn)
				} else {
					log.Printf("activate: online refresh not ready — %s (retrying in %s)", res.Reason, retryIn)
				}
				waitForRefresh(retryIn)
				if retryIn *= 2; retryIn > 4*time.Minute {
					retryIn = 4 * time.Minute
				}
			}
		}()
	}

	fmt.Println()
	fmt.Println("  partyparty is running")
	fmt.Println("  ───────────────────────────────────────────────")
	fmt.Printf("  DJ console :  http://localhost:%d/dj\n", cfg.Port)
	fmt.Printf("  Guests     :  http://%s:%d/\n", ip, cfg.Port)
	fmt.Printf("  (.local)   :  http://%s:%d/\n", netinfo.LocalHostname(), cfg.Port)
	fmt.Println("  ───────────────────────────────────────────────")
	fmt.Println("  Open the DJ console, choose a capture source, hit Start.")
	if bc.Delivery() == "llhls" {
		host := activationHost()
		if host == "" {
			host = ip
		}
		fmt.Printf("  Low-latency: LL-HLS at https://%s:%d/live/%s/index.m3u8\n", host, cfg.TLSPort, cfg.StreamPath)
	}
	if cfg.Captive {
		fmt.Println("  Captive-portal mode ON (needs DNS hijacked to this Mac).")
	}
	fmt.Println()

	// Open the DJ console automatically (skip for headless test-tone runs and when
	// the native shell hosts the admin in its own window, which passes --no-open).
	if !cfg.Tone && !cfg.NoOpen {
		_ = exec.Command("open", fmt.Sprintf("http://localhost:%d/dj", cfg.Port)).Start()
	}

	if cfg.Tone {
		bc.Start("test", "Test tone (440 Hz)", broadcast.Options{})
	}

	// Debug telemetry: while live, snapshot /api/status to the cloud every 30s
	// (R2 via the site Worker, authenticated with this install's broker
	// identity) so playback problems can be analyzed after the fact — nobody
	// transcribes numbers off phones mid-party. PARTYPARTY_TELEMETRY=0 disables.
	if os.Getenv("PARTYPARTY_TELEMETRY") != "0" {
		go telemetryLoop(cfg.Port, bc)
	}

	// Live presence check-in for auto-discovery: announce this Mac to the broker
	// every 30s while broadcasting so guests on the same Wi-Fi can find the party
	// ("A party is on this Wi-Fi — Join <DJ>"). A sibling to telemetryLoop but
	// deliberately NOT gated on PARTYPARTY_TELEMETRY — discovery must never depend
	// on a debug toggle. Best-effort + logged; a graceful stop/quit posts offline.
	go liveCheckinLoop(bc, events, diagLog, cfg.TLSPort, handler)

	// Cloud mirror uploader: when the leg is on, ship each go-live's scratch HLS
	// to the broker for remote guests. One upload session per go-live, torn down
	// when the set ends.
	if mirrorScratch != "" {
		startLiveMirror(mirrorScratch, bc, events, diagLog)
	}

	// Room snapshots into the diagnostics log: every 60s while live, who's
	// listening and how well (latency/buffer/stalls) — the after-party answer
	// to "the sound was bad", without anyone screenshotting anything.
	if diagLog != nil {
		go func() {
			for {
				time.Sleep(60 * time.Second)
				st := bc.Status()
				if st.State != "live" {
					continue
				}
				roster := ls.Roster()
				h := ls.Health(true, 0)
				diagLog.Printf("room: %d listening · health=%s · source=%s %s %dch",
					len(roster), h.Status, st.DeviceName, st.Bitrate, st.Channels)
				data, _ := json.Marshal(roster)
				diagLog.Printf("roster: %s", data)
			}
		}()
		// A finished set is the moment the log matters most — ship it the
		// moment broadcasting stops, not at the next 3-minute tick.
		go func() {
			wasActive := false
			var liveStart time.Time
			for {
				time.Sleep(2 * time.Second)
				st := bc.Status().State
				// "stopping" is a real, brief intermediate state on the way to
				// idle. Treat any of live/starting/stopping as active and detect
				// the end as active->settled, so a poll that samples "stopping"
				// can't make us miss the end edge (a plain prev==live check did).
				active := st == "live" || st == "starting" || st == "stopping"
				if (st == "live" || st == "starting") && liveStart.IsZero() {
					liveStart = time.Now()
				}
				if wasActive && !active {
					diagLog.Printf("broadcast ended (state=%s) — uploading session log", st)
					uploadLogOnce(diagLog)
					// A cleanly-ended set of real length auto-publishes to its
					// online page (the manual "Publish now" button has no such
					// floor). Errors don't auto-publish — the DJ can still push
					// it by hand.
					if st == "idle" && events != nil {
						maybeAutoPublish(events, cfg.FFmpeg, payload, time.Since(liveStart), diagLog)
					}
					liveStart = time.Time{}
				}
				wasActive = active
			}
		}()
		// Go-live health: a few seconds after the broadcast reports "live", ask
		// MediaMTX's own manifest whether the guest stream actually landed.
		// ffmpeg's -progress only proves the encoder runs — the recording tee leg
		// alone keeps it "live" — NOT that the RTSP publish reached MediaMTX. This
		// catches a false-live ("Live" but guests hear nothing) within ~7s, ships
		// the verdict urgently, and lets the console tell the DJ honestly.
		if mtx != nil {
			go func() {
				word := func(c bool, a, b string) string {
					if c {
						return a
					}
					return b
				}
				lastLive := false
				for {
					time.Sleep(2 * time.Second)
					live := bc.Status().State == "live"
					if live && !lastLive && bc.Delivery() == "llhls" {
						time.Sleep(5 * time.Second) // let LL-HLS parts+segments accumulate
						if bc.Status().State != "live" {
							lastLive = live
							continue
						}
						before, _ := bc.ProgressSnapshot()
						time.Sleep(2 * time.Second)
						after, size := bc.ProgressSnapshot()
						capFlowing := after > before && after > 2_000_000 // out_time advancing, >2s encoded
						pub, code, body := mediamtx.PathPublishing(cfg.HLSPort, cfg.StreamPath)
						verdict := "HEALTHY"
						switch {
						case !capFlowing:
							verdict = "CAPTURE-DEAD"
						case !pub:
							verdict = "DEAD-STREAM"
						}
						diagLog.Printf("go-live health: verdict=%s capture=%s(out_time_us=%d size=%d) mtx=%s(http=%d body=%q) guests=%d path=%s port=%d",
							verdict, word(capFlowing, "flowing", "STALLED"), after, size,
							word(pub, "publishing", "NO-PUBLISHER"), code, body, len(ls.Roster()), cfg.StreamPath, cfg.HLSPort)
						switch verdict {
						case "HEALTHY":
							handler.SetStreamHealth("")
						case "DEAD-STREAM":
							diagLog.MarkUrgent()
							handler.SetStreamHealth("You’re Live, but no audio is reaching guests — the low-latency engine never received the stream. Stop and Go Live again.")
						case "CAPTURE-DEAD":
							diagLog.MarkUrgent()
							handler.SetStreamHealth("You’re Live, but no audio is being captured — make sure something is playing and the right source is selected, then Stop and Go Live again.")
						}
					}
					lastLive = live
				}
			}()
			// Part-cadence heartbeat: while live, sample the LL-HLS media
			// playlist's tip once a second and log when NEW MEDIA stops being
			// emitted. The 2026-07-13 party showed 2-3 phones on different IPs
			// stalling within ~1s of each other with nothing in the server log
			// to attribute it — a production hiccup (capture/encoder/MediaMTX)
			// starves every guest at the same instant, while venue-Wi-Fi trouble
			// hits phones one at a time. These lines make the next field log
			// tell those apart.
			go func() {
				var lastTip string
				var lastAdvance, windowStart time.Time
				var windowMaxGap time.Duration
				advances := 0
				ongoingLogged := false
				for {
					time.Sleep(1 * time.Second)
					if bc.Status().State != "live" || bc.Delivery() != "llhls" {
						lastTip = ""
						lastAdvance, windowStart = time.Time{}, time.Time{}
						windowMaxGap, advances, ongoingLogged = 0, 0, false
						continue
					}
					tip, ok := mediamtx.PlaylistTip(cfg.HLSPort, cfg.StreamPath)
					if !ok {
						continue // transient fetch error; the go-live health check owns dead-engine verdicts
					}
					now := time.Now()
					if windowStart.IsZero() {
						windowStart = now
					}
					if tip != lastTip {
						if lastTip != "" && !lastAdvance.IsZero() {
							gap := now.Sub(lastAdvance)
							advances++
							if gap > windowMaxGap {
								windowMaxGap = gap
							}
							// At 1s parts a healthy tip advances ~every second;
							// 2.5s+ of silence is a real production gap guests
							// felt together.
							if gap >= 2500*time.Millisecond {
								diagLog.Printf("part-cadence: production gap %dms (guests starve together when this spikes)", gap.Milliseconds())
							}
						}
						lastTip = tip
						lastAdvance = now
						ongoingLogged = false
					} else if !lastAdvance.IsZero() && !ongoingLogged && now.Sub(lastAdvance) >= 5*time.Second {
						diagLog.Printf("part-cadence: no new media for %dms and counting", now.Sub(lastAdvance).Milliseconds())
						ongoingLogged = true
					}
					if now.Sub(windowStart) >= 60*time.Second {
						if advances > 0 {
							diagLog.Printf("part-cadence: window=60s advances=%d maxGapMs=%d", advances, windowMaxGap.Milliseconds())
						}
						windowStart = now
						windowMaxGap, advances = 0, 0
					}
				}
			}()
		}
		go uploadLogLoop(diagLog, bc)
	}

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	<-sig

	if diagLog != nil {
		diagLog.Printf("shutting down (signal)")
		uploadLogOnce(diagLog) // final flush — best effort, bounded
	}
	// Drop live presence on a graceful quit so the party disappears from
	// auto-discovery immediately instead of waiting out the broker's TTL. The
	// check-in loop also posts offline on the live->idle edge; both are the same
	// idempotent call. Bounded + best-effort so it never delays shutdown.
	if appVersion != "dev" {
		if id, secret := activate.InstallCreds(); id != "" {
			handler.SetWebListeners(0)
			postLiveOffline(brokerBase(), id, secret, &http.Client{Timeout: 3 * time.Second}, nil)
		}
	}
	bc.Stop()
	if mtx != nil {
		mtx.Stop()
	}
	if dnsCancel != nil {
		dnsCancel()
	}
	if localDNS != nil {
		_ = localDNS.Close()
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	_ = httpSrv.Shutdown(ctx)
}

// cmdOut runs a tiny probe command for the diagnostics header ("" on failure).
func cmdOut(name string, args ...string) string {
	out, err := exec.Command(name, args...).Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

// uploadLogLoop ships the session log to the cloud while it keeps growing —
// every 30s DURING a broadcast, every 3 minutes otherwise, and PROMPTLY (a
// few seconds, debounced) whenever a client reports a problem so a failure is
// analyzable almost live. Same auth + namespace as telemetry;
// PARTYPARTY_TELEMETRY=0 disables it all.
func uploadLogLoop(dl *diag.Logger, bc *broadcast.Broadcaster) {
	if os.Getenv("PARTYPARTY_TELEMETRY") == "0" {
		return
	}
	for {
		wait := 3 * time.Minute
		if bc.Status().State == "live" {
			wait = 30 * time.Second
		}
		timer := time.NewTimer(wait)
		select {
		case <-dl.Urgent():
			timer.Stop()                // don't leak the abandoned timer when a nudge wins
			time.Sleep(3 * time.Second) // let a burst of related events coalesce
		case <-timer.C:
		}
		uploadLogOnce(dl)
	}
}

func uploadLogOnce(dl *diag.Logger) {
	if os.Getenv("PARTYPARTY_TELEMETRY") == "0" || appVersion == "dev" {
		return // dev instances share the Mac's install.json — keep their noise local
	}
	id, secret := activate.InstallCreds()
	if id == "" {
		return // never registered — nowhere to file it under
	}
	data := dl.TailIfDirty(4 << 20)
	if data == nil {
		return
	}
	var gz bytes.Buffer
	zw := gzip.NewWriter(&gz)
	_, _ = zw.Write(data)
	_ = zw.Close()
	base := os.Getenv("PARTYPARTY_BROKER")
	if base == "" {
		base = "https://partyparty.party"
	}
	body, _ := json.Marshal(map[string]any{
		"id": id, "secret": secret,
		"session": dl.Session(),
		"log":     base64.StdEncoding.EncodeToString(gz.Bytes()),
	})
	cl := &http.Client{Timeout: 15 * time.Second}
	if resp, err := cl.Post(base+"/api/broker/log", "application/json", bytes.NewReader(body)); err == nil {
		resp.Body.Close()
	}
}

// maybeAutoPublish publishes a finished set to its online /e/<slug> page — but
// only for REAL sets. Dev builds and telemetry-off installs never publish (same
// rule as logs/telemetry, so a dev instance sharing install.json stays quiet).
// Sets shorter than the configured floor are skipped so sound-checks and test
// blips don't spam the page, and a set already published (manually, or by a
// prior auto) is skipped by signature. The upload itself runs off the poller.
func maybeAutoPublish(events *event.Store, ffmpeg string, payload *ota.Store, dur time.Duration, dl *diag.Logger) {
	if appVersion == "dev" || os.Getenv("PARTYPARTY_TELEMETRY") == "0" {
		return
	}
	var cfgJSON []byte
	if payload != nil {
		cfgJSON = payload.Config()
	}
	if !autoPublishEnabled(cfgJSON) {
		return
	}
	if dur < autoPublishMinDur(cfgJSON) {
		return // too short — a sound-check, not a set worth a page
	}
	// Snapshot the set NOW (not inside the goroutine): capture the exact
	// recordings + meta + signature we validated, so a "New event"/next Go Live
	// during the up-to-10-min upload can't swap what gets published (TOCTOU).
	recordings := events.LatestSetRecordings()
	if len(recordings) == 0 {
		return // nothing recorded (recording off, or no audio captured)
	}
	sig := publish.Signature(recordings)
	if sig == events.LastPublishedSig() {
		return // already online (manual publish, or a prior auto)
	}
	id, secret := activate.InstallCreds()
	if id == "" {
		return // never registered — nowhere to publish
	}
	m := events.Meta()
	base := os.Getenv("PARTYPARTY_BROKER")
	if base == "" {
		base = "https://partyparty.party"
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
		defer cancel()
		creds := publish.Creds{ID: id, Secret: secret, InstallSlug: activate.InstallSlug()}
		res, err := publish.Publish(ctx, ffmpeg, recordings, publish.Meta{
			Slug: m.Slug, Title: m.Title, Host: m.Host, Starts: m.Starts,
		}, creds, base)
		if dl == nil {
			return
		}
		if err != nil {
			dl.Printf("auto-publish failed: %v", err)
			return
		}
		events.SetPublishedSig(sig)
		_, _ = events.SetSlug(res.Slug)
		if res.Warning != "" {
			dl.Printf("auto-published set → %s (%s)", res.URL, res.Warning)
		} else {
			dl.Printf("auto-published set → %s", res.URL)
		}
		autoSyncPosts(events, res.Slug, creds, base, dl)
	}()
}

func autoSyncPosts(events *event.Store, slug string, creds publish.Creds, base string, dl *diag.Logger) {
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 8*time.Minute)
		defer cancel()
		res, err := postsync.SyncPosts(ctx, events.Dir(), creds, slug, base)
		if err != nil {
			dl.Printf("auto post sync failed: %v", err)
			return
		}
		if res.Offline {
			dl.Printf("auto post sync deferred: offline (%s)", res.LastError)
			return
		}
		dl.Printf("auto post sync complete: posts=%d media=%d skipped_posts=%d skipped_media=%d", res.PostsPushed, res.MediaPushed, res.PostsSkipped, res.MediaSkipped)
	}()
}

// autoPublishEnabled reads the OTA flags.autoPublish switch (default OFF).
// Auto-publish is opt-in: the DJ turns it on in the console settings (which
// drives /api/stop?publish=1), or an OTA push can force it on for a fleet.
func autoPublishEnabled(cfgJSON []byte) bool {
	var c struct {
		Flags struct {
			AutoPublish *bool `json:"autoPublish"`
		} `json:"flags"`
	}
	if len(cfgJSON) > 0 && json.Unmarshal(cfgJSON, &c) == nil && c.Flags.AutoPublish != nil {
		return *c.Flags.AutoPublish
	}
	return false
}

// autoPublishMinDur is the minimum set length for auto-publish: env override,
// else the OTA tunables.publishAutoMinSec, else 3 minutes.
func autoPublishMinDur(cfgJSON []byte) time.Duration {
	if v := os.Getenv("PARTYPARTY_PUBLISH_MIN_SEC"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 0 {
			return time.Duration(n) * time.Second
		}
	}
	var c struct {
		Tunables struct {
			PublishAutoMinSec *int `json:"publishAutoMinSec"`
		} `json:"tunables"`
	}
	if len(cfgJSON) > 0 && json.Unmarshal(cfgJSON, &c) == nil && c.Tunables.PublishAutoMinSec != nil && *c.Tunables.PublishAutoMinSec >= 0 {
		return time.Duration(*c.Tunables.PublishAutoMinSec) * time.Second
	}
	return 3 * time.Minute
}

func captiveDNSHosts(host string) []string {
	seen := map[string]bool{}
	var out []string
	add := func(h string) {
		h = strings.TrimSpace(strings.TrimSuffix(h, "."))
		if h == "" || seen[h] {
			return
		}
		seen[h] = true
		out = append(out, h)
	}
	add(host)
	add("party")
	add("party.lan")
	add("partyparty")
	add("partyparty.lan")
	return out
}

// humanizeActivation turns raw activation errors into console-worthy English.
// The DJ saw "certificate: ACME register: 503 : 503 Service Unavailable" in
// the field — accurate, useless, and scary. The retry loop is automatic; the
// message's only job is to say WHO is being waited on.
func humanizeActivation(reason string) string {
	r := strings.ToLower(reason)
	switch {
	case strings.Contains(r, "link this mac") || strings.Contains(r, "account link"):
		return "link this Mac to your partyparty account before secure low-latency setup can finish"
	case strings.Contains(r, "acme") || strings.Contains(r, "letsencrypt") || strings.Contains(r, "let's encrypt"):
		return "the free certificate service (Let's Encrypt) isn't answering right now — retrying automatically, this usually clears in a few minutes"
	case strings.Contains(r, "register") || strings.Contains(r, "broker") || strings.Contains(r, "partyparty.party"):
		return "can't reach the partyparty setup service — check the internet connection; retrying automatically"
	case strings.Contains(r, "resolve") || strings.Contains(r, "dns"):
		return "waiting for the new address to become reachable (DNS) — retrying automatically"
	case strings.Contains(r, "no lan") || strings.Contains(r, "network"):
		return "no network connection — join a Wi-Fi network or start your hotspot"
	default:
		return reason
	}
}

// ensureMTXReady is EnsureReady with one reap-and-retry: if readiness fails
// because a stale orphan owns the ports (or anything else mediamtx-shaped
// squats there), kill it and try once more.
func ensureMTXReady(mtx *mediamtx.Server, rtspPort, hlsPort int) error {
	err := mtx.EnsureReady(rtspPort, hlsPort, 6*time.Second)
	if err == nil {
		return nil
	}
	if n := mediamtx.ReapOrphans(rtspPort, hlsPort); n > 0 {
		log.Printf("reaped %d mediamtx orphan(s) after readiness failure — retrying", n)
		return mtx.EnsureReady(rtspPort, hlsPort, 6*time.Second)
	}
	return err
}
