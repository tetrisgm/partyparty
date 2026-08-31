package activate

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"
)

func TestConcurrentFirstUseRegistersOnlyOnce(t *testing.T) {
	dir := setupStateDir(t)
	var registerCalls atomic.Int32
	requestStarted := make(chan struct{})
	releaseRequest := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/broker/register" {
			http.NotFound(w, r)
			return
		}
		if registerCalls.Add(1) == 1 {
			close(requestStarted)
		}
		<-releaseRequest
		_, _ = w.Write([]byte(`{"id":"one-install","secret":"one-secret","base":"127.0.0.1","hostLabel":"disco42"}`))
	}))
	defer server.Close()

	const callers = 16
	start := make(chan struct{})
	results := make(chan *brokerClient, callers)
	errs := make(chan error, callers)
	for range callers {
		go func() {
			<-start
			b, err := loadOrRegisterInstall(context.Background(), server.URL, dir, nil)
			results <- b
			errs <- err
		}()
	}
	close(start)
	<-requestStarted
	close(releaseRequest)

	for range callers {
		if err := <-errs; err != nil {
			t.Fatalf("loadOrRegisterInstall: %v", err)
		}
		if b := <-results; b == nil || b.id != "one-install" || b.secret != "one-secret" {
			t.Fatalf("loadOrRegisterInstall returned %+v", b)
		}
	}
	if got := registerCalls.Load(); got != 1 {
		t.Fatalf("registration calls = %d, want 1", got)
	}
	assertPrivateCompleteInstallRecord(t, filepath.Join(dir, "install.json"), "one-install")
}

func TestInstallStateWaitHonorsContextCancellation(t *testing.T) {
	dir := setupStateDir(t)
	requestStarted := make(chan struct{})
	releaseRequest := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(requestStarted)
		<-releaseRequest
		_, _ = w.Write([]byte(`{"id":"one-install","secret":"one-secret","base":"127.0.0.1","hostLabel":"disco42"}`))
	}))
	defer server.Close()

	firstDone := make(chan error, 1)
	go func() {
		_, err := loadOrRegisterInstall(context.Background(), server.URL, dir, nil)
		firstDone <- err
	}()
	<-requestStarted

	ctx, cancel := context.WithCancel(context.Background())
	secondDone := make(chan error, 1)
	go func() {
		_, err := loadOrRegisterInstall(ctx, server.URL, dir, nil)
		secondDone <- err
	}()
	cancel()
	if err := <-secondDone; !errors.Is(err, context.Canceled) {
		t.Fatalf("waiting loadOrRegisterInstall error = %v, want context cancellation", err)
	}
	close(releaseRequest)
	if err := <-firstDone; err != nil {
		t.Fatalf("first loadOrRegisterInstall: %v", err)
	}
}

func TestInstallStateWaitHonorsExternalFileLock(t *testing.T) {
	dir := setupStateDir(t)
	external, err := os.OpenFile(filepath.Join(dir, ".install.lock"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	defer external.Close()
	if err := syscall.Flock(int(external.Fd()), syscall.LOCK_EX); err != nil {
		t.Fatal(err)
	}
	defer syscall.Flock(int(external.Fd()), syscall.LOCK_UN)

	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Millisecond)
	defer cancel()
	lockFile, err := lockInstallState(ctx, dir)
	if lockFile != nil {
		unlockInstallState(lockFile)
	}
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("lockInstallState error = %v, want context deadline while another process lock is held", err)
	}
}

func TestRememberHostWaitHonorsContext(t *testing.T) {
	dir := setupStateDir(t)
	rec := installRecord{ID: "install", Secret: "secret", Base: "old.example.test", HostLabel: "name"}
	if err := writeInstallRecord(filepath.Join(dir, "install.json"), rec); err != nil {
		t.Fatal(err)
	}
	lockFile, err := lockInstallState(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	defer unlockInstallState(lockFile)

	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Millisecond)
	defer cancel()
	err = brokerFromRecord("https://example.test", rec).rememberHost(ctx, dir, "name.new.example.test")
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("rememberHost error = %v, want context deadline", err)
	}
}

func TestInstallLoggingRunsAfterFileLockReleased(t *testing.T) {
	dir := setupStateDir(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"id":"install","secret":"secret","base":"127.0.0.1","hostLabel":"name"}`))
	}))
	defer server.Close()

	var logCalls atomic.Int32
	logf := func(string, ...any) {
		logCalls.Add(1)
		ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
		defer cancel()
		lockFile, err := lockInstallState(ctx, dir)
		if err != nil {
			t.Errorf("logger ran while install lock was held: %v", err)
			return
		}
		unlockInstallState(lockFile)
	}
	if _, err := loadOrRegisterInstall(context.Background(), server.URL, dir, logf); err != nil {
		t.Fatal(err)
	}
	if logCalls.Load() == 0 {
		t.Fatal("registration produced no deferred log entry")
	}
}

func TestConcurrentUnknownInstallRecoveryRegistersOnlyOnce(t *testing.T) {
	dir := setupStateDir(t)
	path := filepath.Join(dir, "install.json")
	staleRecord := installRecord{ID: "stale-install", Secret: "stale-secret", Base: "127.0.0.1", HostLabel: "oldname"}
	if err := writeInstallRecord(path, staleRecord); err != nil {
		t.Fatal(err)
	}

	var registerCalls atomic.Int32
	requestStarted := make(chan struct{})
	releaseRequest := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/broker/register" {
			http.NotFound(w, r)
			return
		}
		if registerCalls.Add(1) == 1 {
			close(requestStarted)
		}
		<-releaseRequest
		_, _ = w.Write([]byte(`{"id":"fresh-install","secret":"fresh-secret","base":"127.0.0.1","hostLabel":"newname"}`))
	}))
	defer server.Close()
	stale := brokerFromRecord(server.URL, staleRecord)

	const callers = 12
	start := make(chan struct{})
	results := make(chan *brokerClient, callers)
	errs := make(chan error, callers)
	for range callers {
		go func() {
			<-start
			b, err := recoverUnknownInstall(context.Background(), server.URL, dir, stale, nil)
			results <- b
			errs <- err
		}()
	}
	close(start)
	<-requestStarted
	close(releaseRequest)

	for range callers {
		if err := <-errs; err != nil {
			t.Fatalf("recoverUnknownInstall: %v", err)
		}
		if b := <-results; b == nil || b.id != "fresh-install" || b.secret != "fresh-secret" {
			t.Fatalf("recoverUnknownInstall returned %+v", b)
		}
	}
	if got := registerCalls.Load(); got != 1 {
		t.Fatalf("replacement registration calls = %d, want 1", got)
	}
	assertPrivateCompleteInstallRecord(t, path, "fresh-install")
}

func TestUnknownInstallRecoveryFailurePreservesCredentials(t *testing.T) {
	dir := setupStateDir(t)
	path := filepath.Join(dir, "install.json")
	staleRecord := installRecord{ID: "stale-install", Secret: "stale-secret", Base: "127.0.0.1", HostLabel: "keepname"}
	if err := writeInstallRecord(path, staleRecord); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, `{"error":"temporarily unavailable"}`, http.StatusServiceUnavailable)
	}))
	defer server.Close()
	stale := brokerFromRecord(server.URL, staleRecord)
	if _, err := recoverUnknownInstall(context.Background(), server.URL, dir, stale, nil); err == nil {
		t.Fatal("recoverUnknownInstall succeeded, want broker failure")
	}
	after, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("stale credentials disappeared after failed replacement: %v", err)
	}
	if !bytes.Equal(after, before) {
		t.Fatalf("failed replacement changed install.json\n before: %s\n  after: %s", before, after)
	}
}

func TestCanonicalInstallRecordIsNotRewrittenOnLoad(t *testing.T) {
	dir := setupStateDir(t)
	path := filepath.Join(dir, "install.json")
	rec := installRecord{ID: "stable-install", Secret: "stable-secret", Base: "127.0.0.1", HostLabel: "stable-name"}
	if err := writeInstallRecord(path, rec); err != nil {
		t.Fatal(err)
	}
	past := time.Unix(1_700_000_000, 0)
	if err := os.Chtimes(path, past, past); err != nil {
		t.Fatal(err)
	}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("unexpected broker request: %s", r.URL.Path)
		http.Error(w, "unexpected", http.StatusInternalServerError)
	}))
	defer server.Close()
	b, err := loadOrRegisterInstall(context.Background(), server.URL, dir, nil)
	if err != nil {
		t.Fatal(err)
	}
	if b.id != rec.ID || b.secret != rec.Secret {
		t.Fatalf("loaded broker = %+v, want record %+v", b, rec)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if !info.ModTime().Equal(past) {
		t.Fatalf("canonical install.json was rewritten: mtime = %s, want %s", info.ModTime(), past)
	}
}

func TestRememberHostCannotOverwriteReplacementIdentity(t *testing.T) {
	dir := setupStateDir(t)
	path := filepath.Join(dir, "install.json")
	fresh := installRecord{ID: "fresh-install", Secret: "fresh-secret", Base: "party.example.net", HostLabel: "newname"}
	if err := writeInstallRecord(path, fresh); err != nil {
		t.Fatal(err)
	}
	stale := &brokerClient{id: "stale-install", secret: "stale-secret", base: "old.example.net", hostLabel: "oldname"}
	if err := stale.rememberHost(context.Background(), dir, "oldname.party.example.net"); err == nil {
		t.Fatal("stale broker client overwrote a replacement identity")
	}
	assertPrivateCompleteInstallRecord(t, path, fresh.ID)
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var got installRecord
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatal(err)
	}
	if got != fresh {
		t.Fatalf("install.json = %+v, want replacement record %+v", got, fresh)
	}
}

func TestHostBearingFailureCannotCommitAfterFinalGenerationCheck(t *testing.T) {
	dir := setupStateDir(t)
	path := filepath.Join(dir, "install.json")
	staleRecord := installRecord{ID: "stale-install", Secret: "stale-secret", Base: "old.example.test", HostLabel: "oldname"}
	stale := brokerFromRecord("https://example.test", staleRecord)
	if err := writeInstallRecord(path, staleRecord); err != nil {
		t.Fatal(err)
	}
	result := stale.result(Result{
		Host:       "oldname.old.example.test",
		ReasonCode: ReasonCert,
		Reason:     "wildcard certificate unavailable",
	})
	// This is the producer's last check. The deterministic replacement below
	// models the previously unguarded window before main applied the result.
	if err := requireCurrentInstall(context.Background(), dir, stale); err != nil {
		t.Fatalf("final generation check: %v", err)
	}
	freshRecord := installRecord{ID: "fresh-install", Secret: "fresh-secret", Base: "new.example.test", HostLabel: "newname"}
	if err := writeInstallRecord(path, freshRecord); err != nil {
		t.Fatal(err)
	}

	called := false
	committed, err := CommitResult(context.Background(), result, func() { called = true })
	if err != nil {
		t.Fatal(err)
	}
	if committed || called {
		t.Fatalf("stale host-bearing failure committed=%v callback=%v", committed, called)
	}
}

func TestRelayRegistrationCommitsCredentialsFromSameSnapshot(t *testing.T) {
	dir := setupStateDir(t)
	path := filepath.Join(dir, "install.json")
	rec := installRecord{ID: "response-install", Secret: "response-secret", Base: "127.0.0.1", HostLabel: "name"}
	if err := writeInstallRecord(path, rec); err != nil {
		t.Fatal(err)
	}
	registration := RelayRegistration{
		JoinURL:    "https://x.partyparty.party/j/room",
		NetworkKey: "network",
		install:    snapshotFromRecord(rec),
	}
	var gotID, gotSecret string
	committed, err := CommitRelayRegistration(context.Background(), registration, func(id, secret string) {
		gotID, gotSecret = id, secret
	})
	if err != nil || !committed {
		t.Fatalf("CommitRelayRegistration = (%v, %v)", committed, err)
	}
	if gotID != rec.ID || gotSecret != rec.Secret {
		t.Fatalf("callback credentials = (%q, %q), want response snapshot", gotID, gotSecret)
	}

	fresh := installRecord{ID: "replacement-install", Secret: "replacement-secret", Base: "127.0.0.1", HostLabel: "newname"}
	if err := writeInstallRecord(path, fresh); err != nil {
		t.Fatal(err)
	}
	called := false
	committed, err = CommitRelayRegistration(context.Background(), registration, func(string, string) { called = true })
	if err != nil {
		t.Fatal(err)
	}
	if committed || called {
		t.Fatalf("stale relay registration committed=%v callback=%v", committed, called)
	}
}

func TestTryBrokerRejectsResponseFromReplacedIdentity(t *testing.T) {
	dir := setupStateDir(t)
	staleRecord := installRecord{ID: "stale-install", Secret: "stale-secret", Base: "127.0.0.1", HostLabel: "oldname"}
	if err := writeInstallRecord(filepath.Join(dir, "install.json"), staleRecord); err != nil {
		t.Fatal(err)
	}
	aRequestStarted := make(chan struct{})
	releaseARequest := make(chan struct{})
	var wildcardCalls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/broker/a":
			close(aRequestStarted)
			<-releaseARequest
			_, _ = w.Write([]byte(`{"ok":true,"host":"oldname.127.0.0.1","ip":"192.168.1.44","verified":true}`))
		case "/api/broker/register":
			_, _ = w.Write([]byte(`{"id":"fresh-install","secret":"fresh-secret","base":"127.0.0.1","hostLabel":"newname"}`))
		case "/api/broker/wildcard-cert":
			wildcardCalls.Add(1)
			http.Error(w, "stale activation fetched a certificate", http.StatusInternalServerError)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	resultCh := make(chan Result, 1)
	go func() {
		resultCh <- TryBroker(server.URL, "192.168.1.44", nil)
	}()
	<-aRequestStarted
	_, recoveryErr := recoverUnknownInstall(context.Background(), server.URL, dir, brokerFromRecord(server.URL, staleRecord), nil)
	close(releaseARequest)
	if recoveryErr != nil {
		t.Fatalf("recoverUnknownInstall: %v", recoveryErr)
	}
	res := <-resultCh
	if res.OK || res.Host != "" || !strings.Contains(res.Reason, errInstallChanged.Error()) {
		t.Fatalf("TryBroker returned stale activation result: %+v", res)
	}
	if got := wildcardCalls.Load(); got != 0 {
		t.Fatalf("stale activation made %d wildcard fetches, want 0", got)
	}
}

func TestRegisterRelayRejectsResponseFromReplacedIdentity(t *testing.T) {
	dir := setupStateDir(t)
	staleRecord := installRecord{ID: "stale-install", Secret: "stale-secret", Base: "127.0.0.1", HostLabel: "oldname"}
	if err := writeInstallRecord(filepath.Join(dir, "install.json"), staleRecord); err != nil {
		t.Fatal(err)
	}
	relayRequestStarted := make(chan struct{})
	releaseRelayRequest := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/broker/relay/register":
			close(relayRequestStarted)
			<-releaseRelayRequest
			_, _ = w.Write([]byte(`{"joinUrl":"https://x.partyparty.party/j/old","networkKey":"old-network"}`))
		case "/api/broker/register":
			_, _ = w.Write([]byte(`{"id":"fresh-install","secret":"fresh-secret","base":"127.0.0.1","hostLabel":"newname"}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	type relayResult struct {
		registration RelayRegistration
		err          error
	}
	resultCh := make(chan relayResult, 1)
	go func() {
		registration, err := RegisterRelay(context.Background(), server.URL, "192.168.1.44", "https://direct", "party", nil)
		resultCh <- relayResult{registration: registration, err: err}
	}()
	<-relayRequestStarted
	_, recoveryErr := recoverUnknownInstall(context.Background(), server.URL, dir, brokerFromRecord(server.URL, staleRecord), nil)
	close(releaseRelayRequest)
	if recoveryErr != nil {
		t.Fatalf("recoverUnknownInstall: %v", recoveryErr)
	}
	result := <-resultCh
	if !errors.Is(result.err, errInstallChanged) {
		t.Fatalf("RegisterRelay error = %v, want %v", result.err, errInstallChanged)
	}
	if result.registration != (RelayRegistration{}) {
		t.Fatalf("RegisterRelay returned stale registration: %+v", result.registration)
	}
}

func TestAtomicInstallRecordReadersSeeOnlyCompleteJSON(t *testing.T) {
	dir := setupStateDir(t)
	path := filepath.Join(dir, "install.json")
	records := []installRecord{
		{ID: "install-a", Secret: strings.Repeat("a", 64*1024), Base: "example.test", HostLabel: "alpha"},
		{ID: "install-b", Secret: strings.Repeat("b", 64*1024), Base: "example.test", HostLabel: "bravo"},
	}
	if err := writeInstallRecord(path, records[0]); err != nil {
		t.Fatal(err)
	}

	done := make(chan struct{})
	errCh := make(chan error, 1)
	var readers sync.WaitGroup
	for range 6 {
		readers.Add(1)
		go func() {
			defer readers.Done()
			for {
				select {
				case <-done:
					return
				default:
				}
				data, err := os.ReadFile(path)
				if err != nil {
					reportTestError(errCh, fmt.Errorf("read install.json: %w", err))
					return
				}
				var got installRecord
				if err := json.Unmarshal(data, &got); err != nil {
					reportTestError(errCh, fmt.Errorf("decode install.json: %w", err))
					return
				}
				if got != records[0] && got != records[1] {
					reportTestError(errCh, fmt.Errorf("partial or mixed install record: id=%q secret length=%d", got.ID, len(got.Secret)))
					return
				}
			}
		}()
	}
	for i := range 80 {
		if err := writeInstallRecord(path, records[i%len(records)]); err != nil {
			close(done)
			readers.Wait()
			t.Fatal(err)
		}
	}
	close(done)
	readers.Wait()
	select {
	case err := <-errCh:
		t.Fatal(err)
	default:
	}
	assertNoAtomicTemps(t, dir)
}

func TestCachedCertificateRequiresMatchingPrivateKey(t *testing.T) {
	dir := setupStateDir(t)
	host := "dj.example.net"
	certPEM, _ := makeLiveCertPair(t, host, renewWindow+24*time.Hour)
	_, wrongKeyPEM := makeLiveCertPair(t, host, renewWindow+24*time.Hour)
	if err := os.WriteFile(filepath.Join(dir, "live-cert.pem"), certPEM, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "live-key.pem"), wrongKeyPEM, 0o600); err != nil {
		t.Fatal(err)
	}

	if certFile, keyFile, ok := CachedCert(); ok {
		t.Fatalf("CachedCert accepted mismatched files %q and %q", certFile, keyFile)
	}
	if res, ok := CachedCertReady(host); ok || res.CertReady {
		t.Fatalf("CachedCertReady accepted mismatched pair: %+v", res)
	}
}

func TestInvalidWildcardPairDoesNotReplaceUsableCache(t *testing.T) {
	dir := setupStateDir(t)
	host := "dj.example.net"
	certFile := filepath.Join(dir, "live-cert.pem")
	keyFile := filepath.Join(dir, "live-key.pem")
	oldCert, oldKey := makeLiveCertPair(t, host, renewWindow-time.Hour)
	if err := installCertificatePair(certFile, keyFile, oldCert, oldKey); err != nil {
		t.Fatal(err)
	}
	manifestPath := filepath.Join(dir, certificateManifestName)
	manifestBefore, err := os.ReadFile(manifestPath)
	if err != nil {
		t.Fatal(err)
	}
	newCert, _ := makeLiveCertPair(t, host, renewWindow+24*time.Hour)
	_, wrongKey := makeLiveCertPair(t, host, renewWindow+24*time.Hour)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]string{"cert": string(newCert), "key": string(wrongKey)})
	}))
	defer server.Close()
	b := &brokerClient{url: server.URL, id: "install", secret: "secret"}
	if _, _, fetched, err := ensureWildcardCertificate(context.Background(), b, dir, host); err == nil || fetched {
		t.Fatalf("ensureWildcardCertificate = (%v, %v), want rejected response", fetched, err)
	}
	assertFileEquals(t, manifestPath, manifestBefore)
	if !certificatePairValid(certFile, keyFile, host, time.Hour) {
		t.Fatal("failed refresh destroyed the previously usable cached pair")
	}
}

func TestConcurrentWildcardRefreshFetchesAndInstallsOnce(t *testing.T) {
	dir := setupStateDir(t)
	host := "dj.example.net"
	certFile := filepath.Join(dir, "live-cert.pem")
	keyFile := filepath.Join(dir, "live-key.pem")
	certPEM, keyPEM := makeLiveCertPair(t, host, renewWindow+24*time.Hour)
	var fetchCalls atomic.Int32
	requestStarted := make(chan struct{})
	releaseRequest := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if fetchCalls.Add(1) == 1 {
			close(requestStarted)
		}
		<-releaseRequest
		_ = json.NewEncoder(w).Encode(map[string]string{"cert": string(certPEM), "key": string(keyPEM)})
	}))
	defer server.Close()
	b := &brokerClient{url: server.URL, id: "install", secret: "secret"}

	const callers = 12
	start := make(chan struct{})
	fetchedResults := make(chan bool, callers)
	errs := make(chan error, callers)
	for range callers {
		go func() {
			<-start
			_, _, fetched, err := ensureWildcardCertificate(context.Background(), b, dir, host)
			fetchedResults <- fetched
			errs <- err
		}()
	}
	close(start)
	<-requestStarted
	close(releaseRequest)

	fetchedCount := 0
	for range callers {
		if err := <-errs; err != nil {
			t.Fatalf("ensureWildcardCertificate: %v", err)
		}
		if <-fetchedResults {
			fetchedCount++
		}
	}
	if got := fetchCalls.Load(); got != 1 {
		t.Fatalf("wildcard fetch calls = %d, want 1", got)
	}
	if fetchedCount != 1 {
		t.Fatalf("callers reporting a fetch = %d, want 1", fetchedCount)
	}
	if !certificatePairValid(certFile, keyFile, host, renewWindow) {
		t.Fatal("installed wildcard pair is not usable")
	}
	assertPrivateFile(t, certFile)
	assertPrivateFile(t, keyFile)
	assertNoAtomicTemps(t, dir)
}

func TestCertificateStateWaitHonorsExternalFileLock(t *testing.T) {
	dir := setupStateDir(t)
	external, err := os.OpenFile(filepath.Join(dir, ".certificate.lock"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	defer external.Close()
	if err := syscall.Flock(int(external.Fd()), syscall.LOCK_EX); err != nil {
		t.Fatal(err)
	}
	defer syscall.Flock(int(external.Fd()), syscall.LOCK_UN)

	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Millisecond)
	defer cancel()
	lockFile, err := lockCertificateState(ctx, dir)
	if lockFile != nil {
		unlockCertificateState(lockFile)
	}
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("lockCertificateState error = %v, want context deadline", err)
	}
}

func TestCertificateFetchGateWaitHonorsContext(t *testing.T) {
	<-certificateFetchGate
	defer func() { certificateFetchGate <- struct{}{} }()
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Millisecond)
	defer cancel()
	if err := lockCertificateFetch(ctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("lockCertificateFetch error = %v, want context deadline", err)
	}
}

func TestCertificateManifestRetainsPreviousCompleteGeneration(t *testing.T) {
	dir := setupStateDir(t)
	host := "dj.example.net"
	firstCert, firstKey := makeLiveCertPair(t, host, renewWindow+24*time.Hour)
	secondCert, secondKey := makeLiveCertPair(t, host, renewWindow+48*time.Hour)
	certFile := filepath.Join(dir, legacyCertificateName)
	keyFile := filepath.Join(dir, legacyPrivateKeyName)
	if err := installCertificatePair(certFile, keyFile, firstCert, firstKey); err != nil {
		t.Fatal(err)
	}
	firstManifest := readManifestForTest(t, dir)
	if err := installCertificatePair(certFile, keyFile, secondCert, secondKey); err != nil {
		t.Fatal(err)
	}
	secondManifest := readManifestForTest(t, dir)
	if secondManifest.Current == firstManifest.Current || secondManifest.Previous != firstManifest.Current {
		t.Fatalf("second manifest = %+v, want previous %q", secondManifest, firstManifest.Current)
	}
	for _, generation := range []string{secondManifest.Current, secondManifest.Previous} {
		path, cert, err := readCertificateGenerationForTest(dir, generation)
		if err != nil || cert == nil {
			t.Fatalf("generation %q at %q is incomplete: %v", generation, path, err)
		}
	}
	if target, err := os.Readlink(filepath.Join(dir, legacyCertificateName)); err != nil || target != certificateCurrentAlias {
		t.Fatalf("legacy cert alias = %q, %v", target, err)
	}
	if target, err := os.Readlink(filepath.Join(dir, legacyPrivateKeyName)); err != nil || target != certificateCurrentAlias {
		t.Fatalf("legacy key alias = %q, %v", target, err)
	}
}

func TestCertificateManifestCrashBoundaryIgnoresUnpublishedGeneration(t *testing.T) {
	dir := setupStateDir(t)
	host := "dj.example.net"
	firstCert, firstKey := makeLiveCertPair(t, host, renewWindow+24*time.Hour)
	secondCert, secondKey := makeLiveCertPair(t, host, renewWindow+48*time.Hour)
	if err := installCertificatePair(filepath.Join(dir, legacyCertificateName), filepath.Join(dir, legacyPrivateKeyName), firstCert, firstKey); err != nil {
		t.Fatal(err)
	}
	before := readManifestForTest(t, dir)
	orphan := writeUnpublishedGenerationForTest(t, dir, secondCert, secondKey)

	certPath, keyPath, ok := CachedCert()
	if !ok || certPath != keyPath || filepath.Base(certPath) != before.Current+".pem" {
		t.Fatalf("CachedCert after orphan = (%q, %q, %v), want old generation", certPath, keyPath, ok)
	}
	if got := readManifestForTest(t, dir); got != before {
		t.Fatalf("orphan changed manifest: got %+v want %+v", got, before)
	}

	after := certificateManifest{Current: orphan, Previous: before.Current}
	data, _ := json.Marshal(after)
	if err := writeFileAtomic(filepath.Join(dir, certificateManifestName), data, 0o600); err != nil {
		t.Fatal(err)
	}
	certPath, keyPath, ok = CachedCert()
	if !ok || certPath != keyPath || filepath.Base(certPath) != orphan+".pem" {
		t.Fatalf("CachedCert after manifest commit = (%q, %q, %v), want new generation", certPath, keyPath, ok)
	}
}

func TestCertificateManifestFallsBackToRetainedGeneration(t *testing.T) {
	dir := setupStateDir(t)
	host := "dj.example.net"
	firstCert, firstKey := makeLiveCertPair(t, host, renewWindow+24*time.Hour)
	secondCert, secondKey := makeLiveCertPair(t, host, renewWindow+48*time.Hour)
	certFile := filepath.Join(dir, legacyCertificateName)
	keyFile := filepath.Join(dir, legacyPrivateKeyName)
	if err := installCertificatePair(certFile, keyFile, firstCert, firstKey); err != nil {
		t.Fatal(err)
	}
	if err := installCertificatePair(certFile, keyFile, secondCert, secondKey); err != nil {
		t.Fatal(err)
	}
	manifest := readManifestForTest(t, dir)
	if err := os.WriteFile(filepath.Join(dir, certificatePairsDirName, manifest.Current+".pem"), []byte("torn"), 0o600); err != nil {
		t.Fatal(err)
	}
	certPath, keyPath, ok := CachedCert()
	if !ok || certPath != keyPath || filepath.Base(certPath) != manifest.Previous+".pem" {
		t.Fatalf("CachedCert fallback = (%q, %q, %v), want retained generation", certPath, keyPath, ok)
	}
	repaired := readManifestForTest(t, dir)
	if repaired.Current != manifest.Previous || repaired.Previous != "" {
		t.Fatalf("repaired manifest = %+v, want previous promoted", repaired)
	}
}

func TestStateRepairsPrivatePermissionsAndCleansOnlySafeStaleTemps(t *testing.T) {
	dir := setupStateDir(t)
	rec := installRecord{ID: "install", Secret: "secret", Base: "127.0.0.1", HostLabel: "name"}
	installPath := filepath.Join(dir, "install.json")
	data, _ := json.Marshal(rec)
	if err := os.WriteFile(installPath, data, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(installPath, 0o644); err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-2 * time.Hour)
	stalePrivate := filepath.Join(dir, ".install.json.tmp-stale")
	recentPrivate := filepath.Join(dir, ".install.json.tmp-recent")
	staleBroad := filepath.Join(dir, ".install.json.tmp-broad")
	for path, mode := range map[string]os.FileMode{stalePrivate: 0o600, recentPrivate: 0o600, staleBroad: 0o644} {
		if err := os.WriteFile(path, []byte("temp"), mode); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(path, mode); err != nil {
			t.Fatal(err)
		}
	}
	for _, path := range []string{stalePrivate, staleBroad} {
		if err := os.Chtimes(path, old, old); err != nil {
			t.Fatal(err)
		}
	}
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Error("unexpected broker request")
	}))
	defer server.Close()
	if _, err := loadOrRegisterInstall(context.Background(), server.URL, dir, nil); err != nil {
		t.Fatal(err)
	}
	assertPrivateFile(t, installPath)
	if _, err := os.Lstat(stalePrivate); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("safe stale temp still exists: %v", err)
	}
	for _, path := range []string{recentPrivate, staleBroad} {
		if _, err := os.Lstat(path); err != nil {
			t.Fatalf("unsafe temp %s was removed: %v", path, err)
		}
	}
}

func readManifestForTest(t *testing.T, dir string) certificateManifest {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(dir, certificateManifestName))
	if err != nil {
		t.Fatal(err)
	}
	var manifest certificateManifest
	if err := json.Unmarshal(data, &manifest); err != nil {
		t.Fatal(err)
	}
	return manifest
}

func readCertificateGenerationForTest(dir, generation string) (string, any, error) {
	lockFile, err := lockCertificateState(context.Background(), dir)
	if err != nil {
		return "", nil, err
	}
	defer unlockCertificateState(lockFile)
	path, cert, err := readCertificateGenerationLocked(dir, generation)
	return path, cert, err
}

func writeUnpublishedGenerationForTest(t *testing.T, dir string, certPEM, keyPEM []byte) string {
	t.Helper()
	combined := append(append([]byte(nil), certPEM...), keyPEM...)
	digest := sha256.Sum256(combined)
	generation := fmt.Sprintf("%x", digest[:])
	pairsDir := filepath.Join(dir, certificatePairsDirName)
	if err := os.MkdirAll(pairsDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := writeFileAtomic(filepath.Join(pairsDir, generation+".pem"), combined, 0o600); err != nil {
		t.Fatal(err)
	}
	return generation
}

func assertPrivateCompleteInstallRecord(t *testing.T, path, wantID string) {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var rec installRecord
	if err := json.Unmarshal(data, &rec); err != nil {
		t.Fatalf("install.json is not complete JSON: %v", err)
	}
	if rec.ID != wantID || rec.Secret == "" || rec.Base == "" || rec.label() == "" {
		t.Fatalf("install.json = %+v, want complete record for %q", rec, wantID)
	}
	assertPrivateFile(t, path)
	assertNoAtomicTemps(t, filepath.Dir(path))
}

func assertPrivateFile(t *testing.T, path string) {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := info.Mode().Perm(); got != 0o600 {
		t.Fatalf("%s mode = %#o, want 0600", path, got)
	}
}

func assertFileEquals(t *testing.T, path string, want []byte) {
	t.Helper()
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("%s changed unexpectedly", path)
	}
}

func assertNoAtomicTemps(t *testing.T, dir string) {
	t.Helper()
	matches, err := filepath.Glob(filepath.Join(dir, ".*.tmp-*"))
	if err != nil {
		t.Fatal(err)
	}
	if len(matches) != 0 {
		t.Fatalf("temporary files left behind: %v", matches)
	}
}

func reportTestError(ch chan<- error, err error) {
	select {
	case ch <- err:
	default:
	}
}
