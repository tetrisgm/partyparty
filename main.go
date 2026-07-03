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
	"partyparty/internal/event"
	"partyparty/internal/mediamtx"
	"partyparty/internal/netinfo"
	"partyparty/internal/ota"
	"partyparty/internal/server"
	"partyparty/internal/stats"
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
		base = "https://party.ramine.net"
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
				base = "https://party.ramine.net"
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
	deliveryFlag := cfg.Delivery // what the user asked for, pre-resolution

	// LL-HLS is served over HTTPS; without a real (publicly-trusted) cert the
	// self-signed cert on a bare LAN IP is rejected by iOS Safari, so guests would
	// get a stream they can't play. "auto" therefore picks LL-HLS only when a real
	// domain+cert is configured explicitly; otherwise plain HLS now, upgraded in
	// the background by activation. Passing --delivery llhls explicitly still
	// forces it (e.g. testing with a trusted self-signed cert on the phone).
	realCert := cfg.Domain != "" && cfg.CertFile != "" && cfg.KeyFile != ""
	if cfg.Delivery == "auto" {
		if realCert {
			cfg.Delivery = "llhls"
		} else {
			cfg.Delivery = "hls"
		}
	}

	ip := netinfo.PrimaryLanIP()
	ingestURL := fmt.Sprintf("rtsp://localhost:%d/%s", cfg.RTSPPort, cfg.StreamPath)

	bc := broadcast.New(cfg, runDir, helperPath, ingestURL)
	ls := stats.New(20 * time.Second)

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
		writeMTXConfig := func(partDur, segDur string, segCount int) error {
			return mediamtx.WriteConfig(cfgPath, mediamtx.ConfigOpts{
				RTSPPort: cfg.RTSPPort, HLSPort: cfg.HLSPort, Path: cfg.StreamPath,
				CertPath: certPath, KeyPath: keyPath, SegDur: segDur, PartDur: partDur, SegCount: segCount,
			})
		}
		if err := writeMTXConfig(cfg.PartDur, cfg.SegDur, cfg.SegCount); err != nil {
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
			return writeMTXConfig(cfg.PartDur, cfg.SegDur, cfg.SegCount)
		}
		if cfg.Delivery == "llhls" {
			if err := ensureMTXReady(mtx, cfg.RTSPPort, cfg.HLSPort); err != nil {
				log.Printf("mediamtx failed to start: %v — falling back to plain HLS", err)
				bc.SetDelivery("hls")
			}
		}
	} else if cfg.Delivery == "llhls" {
		bc.SetDelivery("hls")
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
			diagLog.Printf("network: lan=%s interfaces=%+v", ip, netinfo.LanInterfaces())
			diagLog.Printf("config: delivery=%s bitrate=%s part=%s seg=%s", cfg.Delivery, cfg.Bitrate, cfg.PartDur, cfg.SegDur)
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

	// The event's social layer lives in a normal, Finder-visible folder — the
	// DJ can open it and drag media/recordings straight out. Feed, uploads,
	// and set recordings all land here; a restart mid-party resumes the same
	// event. Fail-soft: no store just means no feed, never no broadcast.
	var events *event.Store
	if home, err := os.UserHomeDir(); err == nil {
		if st, err := event.Open(filepath.Join(home, "Music", "partyparty")); err == nil {
			events = st
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
		if cf, kf, ok := activate.CachedCert(); ok {
			host := cfg.LiveHost
			if host == "" {
				host = activate.BrokerHost()
			}
			if host != "" {
				if err := loadCert(cf, kf); err == nil {
					if applyActivation != nil {
						_ = applyActivation(cf, kf) // point MediaMTX's config at the real cert
					}
					handler.SetActivation(host)
					log.Printf("cached cert loaded — %s ready immediately", host)
				}
			}
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
	// at party.ramine.net (per-install wildcard cert, IP-encoded hostname).
	// On success we flip delivery to LL-HLS the moment the DJ is idle (never
	// mid-set); on failure we retry every 5 minutes (Wi-Fi comes and goes).
	if deliveryFlag != "hls" && cfg.Delivery == "hls" && cfg.CertFile == "" && mtx != nil && applyActivation != nil {
		go func() {
			retryIn := 15 * time.Second // fast first retries (LE 503s often clear in seconds), then back off
			for {
				var res activate.Result
				if token := activate.TokenFromEnvOrFile(); cfg.LiveHost != "" && token != "" {
					res = activate.Try(cfg.LiveHost, token, netinfo.PrimaryLanIP(), log.Printf)
				} else {
					broker := os.Getenv("PARTYPARTY_BROKER")
					if broker == "" {
						broker = "https://party.ramine.net"
					}
					res = activate.TryBroker(broker, netinfo.PrimaryLanIP(), log.Printf)
				}
				if res.OK {
					if err := applyActivation(res.CertFile, res.KeyFile); err != nil {
						log.Printf("activate: mediamtx config failed: %v — staying on plain HLS", err)
						return
					}
					if err := loadCert(res.CertFile, res.KeyFile); err != nil {
						log.Printf("activate: cert load for the guest page failed: %v", err)
						return
					}
					handler.SetActivation(res.Host)
					log.Printf("activate: low latency ON — %s", res.Host)
					// Auto-engage: THE LL ROOM IS THE PRODUCT (the cert broker
					// exists precisely for this). It is safe under the passive
					// architecture: LL devices park at Apple's PART-HOLD-BACK
					// by themselves — every iPhone at the SAME hold-back =
					// self-syncing ~1.5s, and self-healing (the player
					// re-chases hold-back after a stall). No client control
					// anywhere. Guests whose DNS blocks the domain fail the
					// probe and land on the teed plain stream as visible
					// outliers — they never get a dead stream and never drag
					// the room. Engage when idle; never restart a live set.
					for {
						st := bc.Status()
						if st.State == "idle" || st.State == "error" {
							if bc.Delivery() != "hls" {
								return
							}
							if err := ensureMTXReady(mtx, cfg.RTSPPort, cfg.HLSPort); err != nil {
								log.Printf("activate: mediamtx not ready: %v — staying on plain HLS", err)
								return
							}
							// Atomic idle-check + switch: a set that started
							// during EnsureReady's up-to-6s wait must NOT be
							// yanked (SetDelivery stops any broadcast). If one
							// snuck in, loop and wait for the next idle gap.
							if bc.SetDeliveryIfIdle("llhls") {
								log.Printf("activate: low-latency room engaged")
								return
							}
						}
						time.Sleep(5 * time.Second)
					}
				}
				handler.SetActivationPending(humanizeActivation(res.Reason))
				log.Printf("activate: secure link not ready — %s (retrying in %s)", res.Reason, retryIn)
				time.Sleep(retryIn)
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
		host := cfg.Domain
		if host == "" {
			host = ip
		}
		fmt.Printf("  Low-latency: LL-HLS via MediaMTX at https://%s:%d/%s/index.m3u8\n", host, cfg.HLSPort, cfg.StreamPath)
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
			prev := ""
			for {
				time.Sleep(2 * time.Second)
				st := bc.Status().State
				if (prev == "live" || prev == "starting") && (st == "idle" || st == "error") {
					diagLog.Printf("broadcast ended (state=%s) — uploading session log", st)
					uploadLogOnce(diagLog)
				}
				prev = st
			}
		}()
		go uploadLogLoop(diagLog, bc)
	}

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	<-sig

	if diagLog != nil {
		diagLog.Printf("shutting down (signal)")
		uploadLogOnce(diagLog) // final flush — best effort, bounded
	}
	bc.Stop()
	if mtx != nil {
		mtx.Stop()
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
		base = "https://party.ramine.net"
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

// humanizeActivation turns raw activation errors into console-worthy English.
// The DJ saw "certificate: ACME register: 503 : 503 Service Unavailable" in
// the field — accurate, useless, and scary. The retry loop is automatic; the
// message's only job is to say WHO is being waited on.
func humanizeActivation(reason string) string {
	r := strings.ToLower(reason)
	switch {
	case strings.Contains(r, "acme") || strings.Contains(r, "letsencrypt") || strings.Contains(r, "let's encrypt"):
		return "the free certificate service (Let's Encrypt) isn't answering right now — retrying automatically, this usually clears in a few minutes"
	case strings.Contains(r, "register") || strings.Contains(r, "broker") || strings.Contains(r, "party.ramine.net"):
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
	err := mtx.EnsureReady(rtspPort, 6*time.Second)
	if err == nil {
		return nil
	}
	if n := mediamtx.ReapOrphans(rtspPort, hlsPort); n > 0 {
		log.Printf("reaped %d mediamtx orphan(s) after readiness failure — retrying", n)
		return mtx.EnsureReady(rtspPort, 6*time.Second)
	}
	return err
}
