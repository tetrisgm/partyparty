package main

import (
	"context"
	"embed"
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

	"partyparty/internal/broadcast"
	"partyparty/internal/config"
	"partyparty/internal/mediamtx"
	"partyparty/internal/netinfo"
	"partyparty/internal/server"
	"partyparty/internal/stats"
)

//go:embed all:web
var webFS embed.FS

//go:embed assets/ppcapture
var capBin []byte

//go:embed assets/mediamtx
var mediamtxBin []byte

//go:embed assets/ffmpeg
var ffmpegBin []byte

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

	// Extract the embedded ScreenCaptureKit helper to a stable path (so its
	// Screen Recording permission persists across runs).
	helperPath := ""
	if len(capBin) > 0 {
		helperPath = filepath.Join(runDir, "ppcapture")
		if err := os.WriteFile(helperPath, capBin, 0o755); err != nil {
			helperPath = ""
		}
	}

	// FFmpeg is bundled too; extract it unless the user pointed --ffmpeg elsewhere.
	if cfg.FFmpeg == "ffmpeg" && len(ffmpegBin) > 0 {
		p := filepath.Join(runDir, "ffmpeg")
		if err := os.WriteFile(p, ffmpegBin, 0o755); err == nil {
			cfg.FFmpeg = p
		}
	}

	// LL-HLS is served over HTTPS; without a real (publicly-trusted) cert the
	// self-signed cert on a bare LAN IP is rejected by iOS Safari, so guests would
	// get a stream they can't play. "auto" therefore picks LL-HLS only when a real
	// domain+cert is configured; otherwise plain HTTP HLS that plays everywhere.
	// Passing --delivery llhls explicitly still forces it (e.g. testing with a
	// trusted self-signed cert installed on the phone).
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

	// MediaMTX is bundled into the binary; extract it so LL-HLS always works.
	mtxBinPath := cfg.MediaMTXBin
	if mtxBinPath == "" {
		if len(mediamtxBin) > 0 {
			mtxBinPath = filepath.Join(runDir, "mediamtx")
			if err := os.WriteFile(mtxBinPath, mediamtxBin, 0o755); err != nil {
				log.Fatalf("failed to extract bundled mediamtx: %v", err)
			}
		} else if p, err := mediamtx.Find(""); err == nil {
			mtxBinPath = p // not bundled in this build; fall back to PATH
		}
	}

	var mtx *mediamtx.Server
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
		if err := mediamtx.WriteConfig(cfgPath, mediamtx.ConfigOpts{
			RTSPPort: cfg.RTSPPort, HLSPort: cfg.HLSPort, Path: cfg.StreamPath,
			CertPath: certPath, KeyPath: keyPath, SegDur: cfg.SegDur, PartDur: cfg.PartDur, SegCount: cfg.SegCount,
		}); err != nil {
			log.Fatalf("mediamtx config failed: %v", err)
		}
		mtx = mediamtx.NewServer(mtxBinPath, cfgPath, bc.ExternalWriter())
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
		Config:      cfg,
		Broadcaster: bc,
		Listeners:   ls,
		RunDir:      runDir,
		Web:         web,
		MTX:         mtx,
	})

	ln, err := net.Listen("tcp", fmt.Sprintf(":%d", cfg.Port))
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

	// Open the DJ console automatically (skip for headless test-tone runs).
	if !cfg.Tone {
		_ = exec.Command("open", fmt.Sprintf("http://localhost:%d/dj", cfg.Port)).Start()
	}

	if cfg.Tone {
		bc.Start("test", "Test tone (440 Hz)", broadcast.Options{})
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
