package main

import (
	"context"
	"crypto/tls"
	"embed"
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
	"strings"
	"sync"
	"syscall"
	"time"

	"partyparty/internal/activate"
	"partyparty/internal/broadcast"
	"partyparty/internal/config"
	"partyparty/internal/contribute"
	"partyparty/internal/diag"
	"partyparty/internal/event"
	"partyparty/internal/mediamtx"
	"partyparty/internal/netinfo"
	"partyparty/internal/peers"
	"partyparty/internal/relay"
	"partyparty/internal/schedule"
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

// chanListener is a net.Listener fed pre-accepted conns from a channel - lets
// one raw port drive both an https server and an http-redirect server.
type chanListener struct {
	conns chan net.Conn
	addr  net.Addr
}

func (l *chanListener) Accept() (net.Conn, error) { return <-l.conns, nil }
func (l *chanListener) Close() error              { return nil }
func (l *chanListener) Addr() net.Addr            { return l.addr }

func main() {
	cfg := config.Parse()

	web, err := fs.Sub(webFS, "web")
	if err != nil {
		log.Fatal(err)
	}
	// Serving the console and guest page from disk makes UI work iterable: the
	// alternative is a full rebuild to look at a CSS change. Opt-in only, so a
	// shipped app always serves the embedded copy it was signed with.
	if dir := os.Getenv("PP_WEB_DIR"); dir != "" {
		web = os.DirFS(dir)
		log.Printf("serving web assets from %s (PP_WEB_DIR)", dir)
	}

	runDir := filepath.Join(os.TempDir(), "partyparty-run")
	if err := os.MkdirAll(runDir, 0o755); err != nil {
		log.Fatal(err)
	}

	var diagLog *diag.Logger

	// Resolve the capture helper + ffmpeg. `make build` embeds generated helpers;
	// clean dev builds copy local assets when present. The signed .app build
	// (-tags bundle) resolves pre-signed binaries in Contents/Helpers/.
	helperPath := helperPPCapture(runDir)
	if cfg.FFmpeg == "ffmpeg" {
		if p := helperFFmpeg(runDir); p != "" {
			cfg.FFmpeg = p
		}
	}

	// Certificate activation is asynchronous so a first issuance cannot block
	// the local DJ console. Guest playback has one production path: cert-backed
	// HTTPS LL-HLS.
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
	cfg.Delivery = "llhls"

	ip := netinfo.PrimaryLanIP()
	// 127.0.0.1, NOT "localhost": MediaMTX binds its RTSP ingest to 127.0.0.1
	// (IPv4 loopback) only. On Macs where "localhost" resolves to ::1 (IPv6)
	// first, ffmpeg's RTSP publish hits [::1]:RTSP → Connection refused → the
	// tee's onfail=ignore drops it silently → MediaMTX never gets the stream and
	// guests get "no stream available on path 'party'" (the DJ still shows "live"
	// off the recording leg). Match the bind address exactly. Field-confirmed.
	ingestURL := fmt.Sprintf("rtsp://127.0.0.1:%d/%s", cfg.RTSPPort, cfg.StreamPath)

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
		// guests). Reap by PORT OWNERSHIP - the orphan may be an old app
		// version at a different binary path, so path matching isn't enough.
		if n := mediamtx.ReapOrphans(cfg.RTSPPort, cfg.HLSPort); n > 0 {
			log.Printf("reaped %d orphaned mediamtx process(es) from a previous run", n)
		}
		mtx = mediamtx.NewServer(mtxBinPath, cfgPath, bc.ExternalWriter())
		// One fixed LL timing profile. Async activation swaps in the real cert
		// without changing the playback or encoding mode.
		applyActivation = func(certFile, keyFile string) error {
			certPath, keyPath = certFile, keyFile
			return writeMTXConfig()
		}
		if err := ensureMTXReady(mtx, cfg.RTSPPort, cfg.HLSPort); err != nil {
			log.Printf("mediamtx failed to start: %v - LL-HLS unavailable", err)
		}
	} else {
		log.Printf("mediamtx binary unavailable - LL-HLS cannot start")
	}
	// Session diagnostics (the Plex model): one verbose file per run in
	// ~/Library/Logs/PartyParty, teeing the stdlib logger AND the broadcast
	// log ring, plus structured events (hardware, activation, guest joins,
	// room snapshots). Shipped to the cloud below so field problems can be
	// diagnosed without asking anyone to screenshot a console.
	if home, err := os.UserHomeDir(); err == nil {
		if dl, err := diag.Open(filepath.Join(home, "Library", "Logs", "PartyParty")); err == nil {
			diagLog = dl
			log.SetOutput(io.MultiWriter(os.Stderr, diagLog))
			id, _ := activate.InstallCreds()
			diagLog.Printf("PartyParty v%s starting (%s)", appVersion, diagLog.Session())
			diagLog.Printf("diagnostics: %s", diagLog.Path())
			diagLog.Printf("system: macOS %s · %s · %s", cmdOut("sw_vers", "-productVersion"), cmdOut("sysctl", "-n", "hw.model"), runtime.GOARCH)
			diagLog.Printf("install: id=%s host_label=%s", id, activate.InstallHostLabel())
			diagLog.Printf("network: lan=%s interfaces=%+v", ip, netinfo.LanInterfaces())
			diagLog.Printf("config: https-llhls native-apple target=3s bitrate=%s part=%s seg=%s count=%d", cfg.Bitrate, cfg.PartDur, cfg.SegDur, cfg.SegCount)
			bc.SetDiag(diagLog)
		} else {
			log.Printf("diagnostics log unavailable: %v", err)
		}
	}

	// The LAN event store lives inside Application Support (and therefore inside
	// the App Sandbox container in Mac App Store builds). Guests can still post
	// during the party without granting broad Music-folder access.
	var events *event.Store
	if stateDir, err := activate.StateDir(); err == nil {
		if st, err := event.Open(filepath.Join(stateDir, "events")); err == nil {
			events = st
			events.StartThumbWorker(cfg.FFmpeg)
		} else {
			log.Printf("event store unavailable: %v - feed disabled", err)
		}
	}

	peerCtx, stopPeers := context.WithCancel(context.Background())
	var peerDirectory *peers.Directory
	var peerHost string
	peerID, _ := activate.InstallCreds()

	var relayManager *relay.Manager
	var contributor *contribute.Manager
	// Declared before contribution is configured because the two refer to each
	// other: contribution publishes what this server renders, and the server is
	// built below with the relay manager contribution drives.
	var handler *server.Srv
	{
		brokerURL := os.Getenv("PARTYPARTY_BROKER")
		if brokerURL == "" {
			brokerURL = "https://partyparty.party"
		}
		// Contribution: in RELAY mode this Mac pushes its own LL-HLS to the relay
		// origin, which then fans it out. It reads the stream MediaMTX already
		// serves on loopback, so internal/broadcast is untouched.
		contributor = contribute.New(contribute.Config{
			SourceURL: fmt.Sprintf("https://127.0.0.1:%d/%s/index.m3u8", cfg.HLSPort, cfg.StreamPath),
			// Resolved per push from the broker registration, so this install can
			// only ever publish to its own room and needs nothing configured by hand.
			Target: func() (string, string) {
				if cfg.RelayOrigin != "" {
					return cfg.RelayOrigin, cfg.RelayToken // explicit override, for testing
				}
				if relayManager == nil {
					return "", ""
				}
				return relayManager.Relay()
			},
			// The Mac publishes its OWN guest page, so a relayed guest always gets
			// the page matching the app they are listening to and a web change ships
			// with the app rather than needing the origin redeployed.
			Page: func() []byte { return handler.GuestPage() },
			// The page's static dependencies (avatar, cover, fonts) travel with
			// it: a relayed guest resolves those URLs against the origin.
			Assets:    func() []contribute.Asset { return handler.PageAssets() },
			AssetsRev: func() string { return handler.PageAssetsRev() },
			Logf:      log.Printf,
		})
		relayManager = relay.New(relay.Config{
			BrokerURL: brokerURL,
			Version:   appVersion,
			Logf:      log.Printf,
			OnMode: func(mode string) {
				// Only RELAY needs a copy of the stream on the internet. Pushing in
				// LOCAL or DIRECT would spend the DJ's uplink for nothing.
				if contributor != nil {
					contributor.SetEnabled(mode == relay.ModeRelay)
				}
			},
		})
	}

	handler = server.New(server.Deps{
		Config:      cfg,
		Broadcaster: bc,
		Listeners:   ls,
		RunDir:      runDir,
		Web:         web,
		MTX:         mtx,
		Peers:       peerDirectory,
		PeerID:      peerID,
		Relay:       relayManager,
		Contribute:  contributor,
		Events:      events,
		Diag:        diagLog,
		Version:     appVersion,
	})
	relayCtx, stopRelay := context.WithCancel(context.Background())
	// The room writes its own post-set report into the event folder, so "how
	// did the party actually go" has an answer that does not depend on anyone
	// watching a dashboard mid-set.
	go handler.RunSetReports(relayCtx)
	if relayManager != nil {
		relayManager.Start(relayCtx)
		if contributor != nil {
			go contributor.Run(relayCtx)
			// The room's interactive surface for relayed guests. Without this the
			// origin serves audio and answers 503 for everything else, so a relayed
			// guest sees a party with no listeners, no feed and no way to post.
			go contributor.RunPlane(relayCtx, contribute.PlaneHooks{
				Snapshots:  handler.RoomSnapshots,
				DelaySec:   func() float64 { return schedule.Delay },
				ApplyWrite: handler.ApplyRelayWrite,
				Presence: func(p contribute.Presence) {
					guests := make([]server.RelayGuest, 0, len(p.Roster))
					for _, guest := range p.Roster {
						guests = append(guests, server.RelayGuest{
							ID: guest.ID, Name: guest.Name, Emoji: guest.Emoji,
							DJID: guest.DJID, Paused: guest.Paused,
						})
					}
					handler.SetRelayPresence(p.Listeners, p.SpreadMs, guests)
				},
			})
		}
	}
	startPeerDiscovery := func(host string) {
		if host == "" || (peerDirectory != nil && peerHost == host) {
			return
		}
		if peerDirectory != nil {
			peerDirectory.Close()
			peerDirectory = nil
		}
		id, _ := activate.InstallCreds()
		if id == "" {
			id = activate.InstallHostLabel()
		}
		if id == "" {
			return
		}
		directory, derr := peers.New(peerCtx, id, host, cfg.TLSPort)
		if derr != nil {
			log.Printf("peer discovery unavailable: %v", derr)
			return
		}
		peerDirectory = directory
		peerHost = host
		handler.SetPeers(directory, id)
		log.Printf("peer discovery: advertising %s as %s", host, id)
	}
	startPeerDiscovery(activationHost())

	// tcp4, NOT tcp: on some Macs `net.Listen("tcp", ...)` binds an IPv6-only
	// socket, and if that machine's IPv6 loopback (::1) is also broken, NOTHING
	// local can reach the server - the console loads http://127.0.0.1:<port> and
	// gets nothing, a permanent white screen, even though the process is healthy
	// and its outbound work succeeds. Forcing tcp4 binds 0.0.0.0 (all IPv4
	// interfaces), so 127.0.0.1 (console) and the LAN IP (guests) both resolve
	// with no dependence on IPv6. THIS is the field white screen's root cause.
	ln, err := net.Listen("tcp4", fmt.Sprintf(":%d", cfg.Port))
	if err != nil && errors.Is(err, syscall.EADDRINUSE) {
		// Almost certainly our own orphan: a force-quit can skip child cleanup
		// and leave the old server squatting on the port,
		// which white-screens the new console. Ask it to exit (loopback-only
		// endpoint), then retry the bind with backoff for a few seconds - a
		// draining server can take longer than a single retry to release. The
		// This loopback-only handoff is the sandbox-safe recovery path.
		cl := &http.Client{Timeout: 2 * time.Second}
		if resp, perr := cl.Post(fmt.Sprintf("http://127.0.0.1:%d/api/shutdown", cfg.Port), "", nil); perr == nil {
			resp.Body.Close()
		}
		for i := 0; i < 20; i++ {
			time.Sleep(300 * time.Millisecond)
			if ln, err = net.Listen("tcp4", fmt.Sprintf(":%d", cfg.Port)); err == nil {
				log.Printf("recovered port %d from a previous instance", cfg.Port)
				break
			}
		}
	}
	if err != nil {
		if errors.Is(err, syscall.EADDRINUSE) {
			fmt.Printf("\n  Port %d is already in use. Try: PartyParty --port 8001\n\n", cfg.Port)
			os.Exit(1)
		}
		log.Fatal(err)
	}

	// Record exactly what we bound, and self-test that the console's loopback
	// address is actually reachable from our own process - so a "white screen"
	// that is really an unreachable listener is named in the log instead of
	// guessed at. Logged over the diag channel, which is independent of this
	// HTTP listener.
	log.Printf("http listener bound: %s (%s)", ln.Addr().String(), ln.Addr().Network())
	go func() {
		time.Sleep(500 * time.Millisecond)
		addr := fmt.Sprintf("127.0.0.1:%d", cfg.Port)
		if c, e := net.DialTimeout("tcp", addr, 2*time.Second); e != nil {
			log.Printf("selftest: console loopback %s NOT reachable from self: %v", addr, e)
		} else {
			c.Close()
			log.Printf("selftest: console loopback %s reachable", addr)
		}
	}()

	httpSrv := &http.Server{Handler: handler}

	// HTTPS guest listener (the Plex model): the ADVERTISED link is
	// https://<domain>:<tls-port>/ - the page itself rides the activated cert,
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
	activationEngagedHost := ""
	markActivationEngaged := func(host string) {
		activationMu.Lock()
		activationEngaged = true
		activationEngagedHost = host
		activationMu.Unlock()
	}
	isActivationEngagedFor := func(host string) bool {
		activationMu.Lock()
		defer activationMu.Unlock()
		return activationEngaged && activationEngagedHost == host
	}
	applyActivationResult := func(res activate.Result, source string) bool {
		handler.SetActivationResult(res)
		if !res.OK {
			return false
		}
		if applyActivation != nil {
			if err := applyActivation(res.CertFile, res.KeyFile); err != nil {
				log.Printf("activate: mediamtx config failed after %s: %v - LL-HLS unavailable", source, err)
				return false
			}
		}
		if err := loadCert(res.CertFile, res.KeyFile); err != nil {
			log.Printf("activate: cert load for the guest page failed after %s: %v", source, err)
			return false
		}
		handler.SetActivation(res.Host)
		startPeerDiscovery(res.Host)
		markActivationEngaged(res.Host)
		log.Printf("activate: secure link ready from %s - %s", source, res.Host)
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
	if rawLn, err := net.Listen("tcp4", fmt.Sprintf(":%d", cfg.TLSPort)); err == nil {
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
		// Plaintext hitting the HTTPS port is normally redirected. The one
		// exception is the explicitly advertised offline emergency link, which
		// uses the current LAN IP because that IP cannot present the hostname
		// certificate. We sniff the first byte: 0x16 is TLS, anything else is HTTP.
		redirectSrv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if handler.AllowHTTPFallback(r) {
				handler.ServeHTTP(w, r)
				return
			}
			http.Redirect(w, r, "https://"+r.Host+r.URL.RequestURI(), http.StatusMovedPermanently)
		})}
		tlsCh := &chanListener{conns: make(chan net.Conn), addr: rawLn.Addr()}
		httpCh := &chanListener{conns: make(chan net.Conn), addr: rawLn.Addr()}
		// Boot fast path: a cert issued on a previous run is cached (~90-day
		// validity), so engage it synchronously after the HTTPS listener has
		// successfully bound but before it accepts connections or the console
		// can load. This preserves first-paint QR rendering without advertising
		// a secure URL whose local port failed to open.
		if !explicitCertLoaded && cfg.CertFile == "" {
			if res, ok := activate.CachedCertReady(activationHost()); ok {
				applyActivationResult(res, "cached certificate")
			}
		}
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
		// guest link is real - this (not raw config presence) is what un-gates
		// Go Live and the advertised https URL. Async activation performs the
		// equivalent SetActivation after its own successful cert load.
		if explicitCertLoaded && cfg.Domain != "" {
			handler.SetActivation(cfg.Domain)
		}
	} else {
		log.Printf("tls listener failed on :%d: %v - the https guest link is unavailable", cfg.TLSPort, err)
		handler.SetActivationPending(fmt.Sprintf("port %d is taken by another app - quit it and relaunch PartyParty", cfg.TLSPort))
	}

	// Start serving the console only after synchronous cached activation and
	// TLS listener setup finish. The TCP port is already bound, so the native
	// shell can launch immediately, but its first /dj response cannot race
	// ahead and embed an empty secure URL when a valid cached URL exists.
	go func() {
		if err := httpSrv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatal(err)
		}
	}()

	// Background low-latency activation (the Plex pattern) - the console is
	// already serving; this never blocks startup. Two paths, both fail-soft:
	// BYO (live-host + user's Cloudflare token) or the zero-config cert broker
	// at PartyParty.party (per-install hostname + DNS-01 cert).
	// Cached-cert activation above is local-only and does not wait for this loop.
	// Online refresh keeps DNS and the cert current without changing stream mode.
	if cfg.CertFile == "" && mtx != nil && applyActivation != nil {
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
					log.Printf("activate: LAN address changed to %s - refreshing the secure guest link now", netinfo.PrimaryLanIP())
				case <-timer.C:
				}
			}
			for {
				broker := os.Getenv("PARTYPARTY_BROKER")
				if broker == "" {
					broker = "https://partyparty.party"
				}
				res := activate.TryBroker(broker, netinfo.PrimaryLanIP(), log.Printf)
				// A broker failure does not answer the local question. Recheck the
				// cached hostname against this network before deciding between the
				// offline domain path and the guarded IP fallback. This also prevents
				// a previous venue's resolver result surviving a same-IP move.
				if !res.ResolverObserved {
					host := res.Host
					if host == "" {
						host = activationHost()
					}
					if cached, ok := activate.CachedCertReady(host); ok {
						if res.CertReady {
							cached.OK = res.OK
							cached.DNSPublished = res.DNSPublished
							cached.ReasonCode = res.ReasonCode
							cached.Reason = res.Reason
						} else if res.ReasonCode == "" {
							cached.Reason = res.Reason
						}
						res = cached
					}
				}
				if res.ExpectedIP == "" {
					// Preserve the current LAN identity even when the broker is
					// unreachable. The server uses an IP fallback only after its
					// own state machine has also established that the network is
					// offline and the secure hostname cannot resolve.
					res.ExpectedIP = netinfo.PrimaryLanIP()
				}
				handler.SetActivationResult(res)
				// OK now means the certificate is usable - apply it ONCE so the
				// HTTPS listener + Go Live work everywhere, even where this Wi-Fi
				// blocks LAN routing. Re-running Try/TryBroker each cycle also
				// re-publishes the current LAN IP (the self-healing DNS refresh).
				engaged := isActivationEngagedFor(res.Host)
				if res.OK && !engaged {
					engaged = applyActivationResult(res, "online refresh")
				}
				// Long refresh only when the WHOLE LAN chain is proven for this
				// network; otherwise keep repairing DNS/resolver on the short
				// backoff instead of sleeping until the next scheduled refresh.
				if engaged && res.DNSPublished && res.ResolverMatches && res.ReasonCode == "" {
					retryIn = 15 * time.Second
					waitForRefresh(30 * time.Minute)
					continue
				}
				if !engaged {
					if res.Reason == "" {
						res.Reason = "local activation apply failed"
					}
					handler.SetActivationPending(humanizeActivation(res.Reason))
					log.Printf("activate: secure link not ready - %s (retrying in %s)", res.Reason, retryIn)
				} else {
					log.Printf("activate: LAN not fully ready on this network - %s (retrying in %s)", res.Reason, retryIn)
				}
				waitForRefresh(retryIn)
				if retryIn *= 2; retryIn > 4*time.Minute {
					retryIn = 4 * time.Minute
				}
			}
		}()
	}

	fmt.Println()
	fmt.Println("  PartyParty is running")
	fmt.Println("  ───────────────────────────────────────────────")
	fmt.Printf("  DJ console :  http://localhost:%d/dj\n", cfg.Port)
	fmt.Println("  Guests     :  secure venue-Wi-Fi link shown in the console")
	fmt.Println("  ───────────────────────────────────────────────")
	fmt.Println("  Open the DJ console, choose a capture source, hit Start.")
	host := activationHost()
	if host == "" {
		host = ip
	}
	fmt.Printf("  Low-latency: LL-HLS at https://%s:%d/live/%s/index.m3u8\n", host, cfg.TLSPort, cfg.StreamPath)
	fmt.Println()

	// Open the DJ console automatically (skip for headless test-tone runs and when
	// the native shell hosts the admin in its own window, which passes --no-open).
	if !cfg.Tone && !cfg.NoOpen {
		_ = exec.Command("open", fmt.Sprintf("http://localhost:%d/dj", cfg.Port)).Start()
	}

	if cfg.Tone {
		bc.Start("test", "Test tone (440 Hz)", broadcast.Options{})
	}

	// Room snapshots into the diagnostics log: every 60s while live, who's
	// listening and how well (latency/buffer/stalls) - the after-party answer
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
		// A finished set is the moment the log matters most - ship it the
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
					diagLog.Printf("broadcast ended (state=%s)", st)
					liveStart = time.Time{}
				}
				wasActive = active
			}
		}()
		// Go-live health: a few seconds after the broadcast reports "live", ask
		// MediaMTX's own manifest whether the guest stream actually landed.
		// ffmpeg's -progress only proves the encoder runs - the recording tee leg
		// alone keeps it "live" - NOT that the RTSP publish reached MediaMTX. This
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
					if live && !lastLive {
						// The warning contract: never scare falsely. One sample
						// proved able to brand a healthy set dead (a stream that
						// came up moments after the old one-shot check fired
						// stayed accused). So: confirm a bad verdict on TWO
						// consecutive checks before showing anything, keep
						// checking while live, and the instant a check comes
						// back healthy the warning clears itself.
						time.Sleep(5 * time.Second) // let LL-HLS parts+segments accumulate
						badStreak, warned := 0, false
						for attempt := 0; attempt < 40 && bc.Status().State == "live"; attempt++ {
							before, _ := bc.ProgressSnapshot()
							time.Sleep(2 * time.Second)
							if bc.Status().State != "live" {
								break
							}
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
							diagLog.Printf("go-live health: attempt=%d verdict=%s capture=%s(out_time_us=%d size=%d) mtx=%s(http=%d body=%q) guests=%d path=%s port=%d",
								attempt, verdict, word(capFlowing, "flowing", "STALLED"), after, size,
								word(pub, "publishing", "NO-PUBLISHER"), code, body, len(ls.Roster()), cfg.StreamPath, cfg.HLSPort)
							if verdict == "HEALTHY" {
								handler.SetStreamHealth("")
								break // proven audible; the part-cadence heartbeat watches from here
							}
							badStreak++
							if badStreak >= 2 && !warned {
								warned = true
								diagLog.MarkUrgent()
								if verdict == "CAPTURE-DEAD" {
									handler.SetStreamHealth("Guests can’t hear anything - no audio is being captured. Check that music is playing and the right source is selected, or Stop and Go Live again.")
								} else {
									handler.SetStreamHealth("Guests can’t hear anything - the audio engine isn’t receiving the stream. Stop and Go Live again.")
								}
							}
							time.Sleep(4 * time.Second)
						}
					}
					lastLive = live
				}
			}()
			// Part-cadence heartbeat: while live, sample the LL-HLS media
			// playlist's tip once a second and log when NEW MEDIA stops being
			// emitted. The 2026-07-13 party showed 2-3 phones on different IPs
			// stalling within ~1s of each other with nothing in the server log
			// to attribute it - a production hiccup (capture/encoder/MediaMTX)
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
					if bc.Status().State != "live" {
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
	}

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	<-sig
	stopPeers()
	stopRelay()
	if peerDirectory != nil {
		peerDirectory.Close()
	}

	if diagLog != nil {
		diagLog.Printf("shutting down (signal)")
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

// humanizeActivation turns raw activation errors into console-worthy English.
// The DJ saw "certificate: ACME register: 503 : 503 Service Unavailable" in
// the field - accurate, useless, and scary. The retry loop is automatic; the
// message's only job is to say WHO is being waited on.
func humanizeActivation(reason string) string {
	r := strings.ToLower(reason)
	switch {
	case strings.Contains(r, "link this mac") || strings.Contains(r, "account link"):
		return "link this Mac to your PartyParty account before secure low-latency setup can finish"
	case strings.Contains(r, "acme") || strings.Contains(r, "letsencrypt") || strings.Contains(r, "let's encrypt"):
		return "the free certificate service (Let's Encrypt) isn't answering right now - retrying automatically, this usually clears in a few minutes"
	case strings.Contains(r, "register") || strings.Contains(r, "broker") || strings.Contains(r, "partyparty.party"):
		return "can't reach the PartyParty setup service - check the internet connection; retrying automatically"
	case strings.Contains(r, "resolve") || strings.Contains(r, "dns"):
		return "waiting for the new address to become reachable (DNS) - retrying automatically"
	case strings.Contains(r, "no lan") || strings.Contains(r, "network"):
		return "no network connection - join the venue Wi-Fi network"
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
		log.Printf("reaped %d mediamtx orphan(s) after readiness failure - retrying", n)
		return mtx.EnsureReady(rtspPort, hlsPort, 6*time.Second)
	}
	return err
}
