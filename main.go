package main

import (
	"bytes"
	"context"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"partyparty/internal/activate"
	"partyparty/internal/broadcast"
	"partyparty/internal/config"
	"partyparty/internal/mediamtx"
	"partyparty/internal/netinfo"
	"partyparty/internal/server"
	"partyparty/internal/stats"
)

//go:embed all:web
var webFS embed.FS

// appVersion is stamped by the build (-ldflags "-X main.appVersion=..."). It is
// shown in the UIs and broadcast to clients so stale player pages refresh
// themselves after an update instead of running old logic forever.
var appVersion = "dev"

// telemetryLoop ships /api/status snapshots to the cloud while broadcasting.
func telemetryLoop(port int, bc *broadcast.Broadcaster) {
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
	var reconfigureLL func(partDur, segDur string, segCount int) error
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
		mtx = mediamtx.NewServer(mtxBinPath, cfgPath, bc.ExternalWriter())
		// The DJ's latency modes map to LL-HLS part durations; applying one
		// rewrites mediamtx.yml and bounces MediaMTX (a few seconds of guest
		// rebuffer — the console warns that changing it restarts the broadcast).
		reconfigureLL = func(partDur, segDur string, segCount int) error {
			mtx.Stop()
			if err := writeMTXConfig(partDur, segDur, segCount); err != nil {
				return err
			}
			return mtx.EnsureReady(cfg.RTSPPort, 6*time.Second)
		}
		// Called by async activation: swap in the real cert and rewrite the
		// MediaMTX config (MediaMTX isn't running yet in plain-HLS mode).
		applyActivation = func(certFile, keyFile string) error {
			certPath, keyPath = certFile, keyFile
			return writeMTXConfig(cfg.PartDur, cfg.SegDur, cfg.SegCount)
		}
		if cfg.Delivery == "llhls" {
			if err := mtx.EnsureReady(cfg.RTSPPort, 6*time.Second); err != nil {
				log.Printf("mediamtx failed to start: %v — falling back to plain HLS", err)
				bc.SetDelivery("hls")
			}
		}
	} else if cfg.Delivery == "llhls" {
		bc.SetDelivery("hls")
	}
	handler := server.New(server.Deps{
		Config:           cfg,
		Broadcaster:      bc,
		Listeners:        ls,
		RunDir:           runDir,
		Web:              web,
		MTX:              mtx,
		ReconfigureLLHLS: reconfigureLL,
		Version:          appVersion,
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

	httpSrv := &http.Server{Handler: handler}
	go func() {
		if err := httpSrv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatal(err)
		}
	}()

	// Background low-latency activation (the Plex pattern) — the console is
	// already serving; this never blocks startup. Two paths, both fail-soft:
	// BYO (live-host + user's Cloudflare token) or the zero-config cert broker
	// at party.ramine.net (per-install wildcard cert, IP-encoded hostname).
	// On success we flip delivery to LL-HLS the moment the DJ is idle (never
	// mid-set); on failure we retry every 5 minutes (Wi-Fi comes and goes).
	if deliveryFlag != "hls" && cfg.Delivery == "hls" && cfg.CertFile == "" && mtx != nil && applyActivation != nil {
		go func() {
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
					handler.SetActivation(res.Host)
					// NOT auto-engaged. Sync architecture is "aligned start,
					// passive playback": every player parks at the playlist's
					// EXT-X-START and is never touched again — but a NATIVE
					// LL-HLS player chases its PART-HOLD-BACK (~1s) and cannot
					// be parked at the room target without a tug-of-war (field
					// disaster, twice). LL-HLS stays a manual/testing option
					// until all-LL rooms are designed.
					log.Printf("activate: low latency READY (%s) — manual option in the console (testing only)", res.Host)
					return
				}
				log.Printf("activate: low latency off — %s (retrying in 5 min)", res.Reason)
				time.Sleep(5 * time.Minute)
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

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	<-sig

	bc.Stop()
	if mtx != nil {
		mtx.Stop()
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	_ = httpSrv.Shutdown(ctx)
}
