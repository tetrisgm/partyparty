package activate

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

const (
	certificateManifestName = "live-pair.json"
	certificatePairsDirName = "live-pairs"
	certificateCurrentAlias = "live-current.pem"
	legacyCertificateName   = "live-cert.pem"
	legacyPrivateKeyName    = "live-key.pem"
)

type certificateManifest struct {
	Current  string `json:"current"`
	Previous string `json:"previous,omitempty"`
}

var certificateStateGate = func() chan struct{} {
	gate := make(chan struct{}, 1)
	gate <- struct{}{}
	return gate
}()

var certificateFetchGate = func() chan struct{} {
	gate := make(chan struct{}, 1)
	gate <- struct{}{}
	return gate
}()

// writeFileAtomic replaces path only after the complete new contents have been
// written and flushed in the same directory. Readers therefore see either the
// old file or the new file, never an in-place truncation.
func writeFileAtomic(path string, data []byte, mode os.FileMode) error {
	tmp, err := prepareAtomicFile(path, data, mode)
	if err != nil {
		return err
	}
	defer os.Remove(tmp)
	if err := os.Rename(tmp, path); err != nil {
		return err
	}
	syncParentDirectory(path)
	return nil
}

func prepareAtomicFile(path string, data []byte, mode os.FileMode) (tmpPath string, err error) {
	f, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+".tmp-*")
	if err != nil {
		return "", err
	}
	tmpPath = f.Name()
	defer func() {
		if f != nil {
			_ = f.Close()
		}
		if err != nil {
			_ = os.Remove(tmpPath)
		}
	}()
	if err = f.Chmod(mode); err != nil {
		return "", err
	}
	var n int
	if n, err = f.Write(data); err != nil {
		return "", err
	}
	if n != len(data) {
		return "", io.ErrShortWrite
	}
	if err = f.Sync(); err != nil {
		return "", err
	}
	if err = f.Close(); err != nil {
		return "", err
	}
	f = nil
	return tmpPath, nil
}

func lockCertificateState(ctx context.Context, dir string) (*os.File, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-certificateStateGate:
	}
	lockFile, err := os.OpenFile(filepath.Join(dir, ".certificate.lock"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		certificateStateGate <- struct{}{}
		return nil, err
	}
	if err := lockFile.Chmod(0o600); err != nil {
		_ = lockFile.Close()
		certificateStateGate <- struct{}{}
		return nil, err
	}
	for {
		err = syscall.Flock(int(lockFile.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
		if err == nil {
			return lockFile, nil
		}
		if !errors.Is(err, syscall.EWOULDBLOCK) && !errors.Is(err, syscall.EAGAIN) {
			_ = lockFile.Close()
			certificateStateGate <- struct{}{}
			return nil, err
		}
		timer := time.NewTimer(10 * time.Millisecond)
		select {
		case <-ctx.Done():
			if !timer.Stop() {
				<-timer.C
			}
			_ = lockFile.Close()
			certificateStateGate <- struct{}{}
			return nil, ctx.Err()
		case <-timer.C:
		}
	}
}

func unlockCertificateState(lockFile *os.File) {
	_ = syscall.Flock(int(lockFile.Fd()), syscall.LOCK_UN)
	_ = lockFile.Close()
	certificateStateGate <- struct{}{}
}

func lockCertificateFetch(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-certificateFetchGate:
		return nil
	}
}

func unlockCertificateFetch() { certificateFetchGate <- struct{}{} }

// installCertificatePair publishes a complete versioned PEM bundle and then
// moves one durable manifest. The previous manifest generation remains
// addressable, so a crash can leave only an unreferenced complete file; it can
// never expose half of a certificate/key replacement.
func installCertificatePair(certFile, keyFile string, certPEM, keyPEM []byte) error {
	if filepath.Dir(certFile) != filepath.Dir(keyFile) {
		return errors.New("certificate and private key must share a state directory")
	}
	dir := filepath.Dir(certFile)
	lockFile, err := lockCertificateState(context.Background(), dir)
	if err != nil {
		return err
	}
	defer unlockCertificateState(lockFile)
	cleanupCertificateTempsLocked(dir)
	_, err = publishCertificatePairLocked(dir, certPEM, keyPEM)
	return err
}

func publishCertificatePairLocked(dir string, certPEM, keyPEM []byte) (string, error) {
	if _, err := parseCertificatePair(certPEM, keyPEM); err != nil {
		return "", fmt.Errorf("invalid certificate/key pair: %w", err)
	}
	combined := make([]byte, 0, len(certPEM)+len(keyPEM)+1)
	combined = append(combined, certPEM...)
	if len(combined) > 0 && combined[len(combined)-1] != '\n' {
		combined = append(combined, '\n')
	}
	combined = append(combined, keyPEM...)
	digest := sha256.Sum256(combined)
	generation := hex.EncodeToString(digest[:])

	pairsDir := filepath.Join(dir, certificatePairsDirName)
	if err := os.MkdirAll(pairsDir, 0o700); err != nil {
		return "", err
	}
	_ = os.Chmod(pairsDir, 0o700)
	pairPath := filepath.Join(pairsDir, generation+".pem")
	if existing, err := os.ReadFile(pairPath); err == nil {
		if !bytes.Equal(existing, combined) {
			return "", errors.New("certificate generation digest collision")
		}
		repairPrivateRegularFile(pairPath)
	} else if !errors.Is(err, os.ErrNotExist) {
		return "", err
	} else if err := writeFileAtomic(pairPath, combined, 0o600); err != nil {
		return "", err
	}

	manifestPath := filepath.Join(dir, certificateManifestName)
	previousManifest, _ := readCertificateManifestLocked(manifestPath)
	if previousManifest.Current != generation {
		next := certificateManifest{Current: generation, Previous: previousManifest.Current}
		manifestData, err := json.Marshal(next)
		if err != nil {
			return "", err
		}
		if err := writeFileAtomic(manifestPath, manifestData, 0o600); err != nil {
			return "", err
		}
	} else {
		repairPrivateRegularFile(manifestPath)
	}
	if err := updateLegacyCertificateAliasesLocked(dir, generation); err != nil {
		return "", err
	}
	return pairPath, nil
}

func cachedCertificateSnapshot(ctx context.Context, dir, host string, minRemaining time.Duration) (string, error) {
	lockFile, err := lockCertificateState(ctx, dir)
	if err != nil {
		return "", err
	}
	defer unlockCertificateState(lockFile)
	cleanupCertificateTempsLocked(dir)
	path, cert, err := currentCertificatePairLocked(dir)
	if err != nil {
		return "", err
	}
	if !certificateValid(cert, host, minRemaining) {
		return "", errors.New("cached certificate is not usable")
	}
	return path, nil
}

func currentCertificatePairLocked(dir string) (string, *x509.Certificate, error) {
	manifestPath := filepath.Join(dir, certificateManifestName)
	manifest, err := readCertificateManifestLocked(manifestPath)
	if errors.Is(err, os.ErrNotExist) {
		return migrateLegacyCertificatePairLocked(dir)
	}
	if err != nil {
		return "", nil, err
	}
	path, cert, currentErr := readCertificateGenerationLocked(dir, manifest.Current)
	if currentErr == nil {
		_ = updateLegacyCertificateAliasesLocked(dir, manifest.Current)
		return path, cert, nil
	}
	if manifest.Previous == "" {
		return "", nil, currentErr
	}
	previousPath, previousCert, previousErr := readCertificateGenerationLocked(dir, manifest.Previous)
	if previousErr != nil {
		return "", nil, fmt.Errorf("current certificate generation: %v; previous generation: %w", currentErr, previousErr)
	}
	// A corrupt/missing current generation is repaired by atomically pointing
	// back to the retained complete predecessor.
	repaired := certificateManifest{Current: manifest.Previous}
	data, marshalErr := json.Marshal(repaired)
	if marshalErr != nil {
		return "", nil, marshalErr
	}
	if err := writeFileAtomic(manifestPath, data, 0o600); err != nil {
		return "", nil, err
	}
	if err := updateLegacyCertificateAliasesLocked(dir, repaired.Current); err != nil {
		return "", nil, err
	}
	return previousPath, previousCert, nil
}

func migrateLegacyCertificatePairLocked(dir string) (string, *x509.Certificate, error) {
	certPEM, certErr := os.ReadFile(filepath.Join(dir, legacyCertificateName))
	keyPEM, keyErr := os.ReadFile(filepath.Join(dir, legacyPrivateKeyName))
	if certErr != nil {
		return "", nil, certErr
	}
	if keyErr != nil {
		return "", nil, keyErr
	}
	cert, err := parseCertificatePair(certPEM, keyPEM)
	if err != nil {
		return "", nil, err
	}
	repairPrivateRegularFile(filepath.Join(dir, legacyCertificateName))
	repairPrivateRegularFile(filepath.Join(dir, legacyPrivateKeyName))
	path, err := publishCertificatePairLocked(dir, certPEM, keyPEM)
	if err != nil {
		return "", nil, err
	}
	return path, cert, nil
}

func readCertificateManifestLocked(path string) (certificateManifest, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return certificateManifest{}, err
	}
	if !info.Mode().IsRegular() {
		return certificateManifest{}, errors.New("certificate manifest is not a regular file")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return certificateManifest{}, err
	}
	var manifest certificateManifest
	if err := json.Unmarshal(data, &manifest); err != nil {
		return certificateManifest{}, err
	}
	if !validCertificateGeneration(manifest.Current) ||
		(manifest.Previous != "" && !validCertificateGeneration(manifest.Previous)) {
		return certificateManifest{}, errors.New("certificate manifest contains an invalid generation")
	}
	repairPrivateRegularFile(path)
	return manifest, nil
}

func readCertificateGenerationLocked(dir, generation string) (string, *x509.Certificate, error) {
	if !validCertificateGeneration(generation) {
		return "", nil, errors.New("invalid certificate generation")
	}
	path := filepath.Join(dir, certificatePairsDirName, generation+".pem")
	info, err := os.Lstat(path)
	if err != nil {
		return "", nil, err
	}
	if !info.Mode().IsRegular() {
		return "", nil, errors.New("certificate generation is not a regular file")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "", nil, err
	}
	digest := sha256.Sum256(data)
	if hex.EncodeToString(digest[:]) != generation {
		return "", nil, errors.New("certificate generation digest mismatch")
	}
	cert, err := parseCertificatePair(data, data)
	if err != nil {
		return "", nil, err
	}
	repairPrivateRegularFile(path)
	return path, cert, nil
}

func validCertificateGeneration(value string) bool {
	if len(value) != sha256.Size*2 || value != strings.ToLower(value) {
		return false
	}
	_, err := hex.DecodeString(value)
	return err == nil
}

func updateLegacyCertificateAliasesLocked(dir, generation string) error {
	if !validCertificateGeneration(generation) {
		return errors.New("invalid certificate generation")
	}
	if err := atomicReplaceSymlink(
		filepath.Join(certificatePairsDirName, generation+".pem"),
		filepath.Join(dir, certificateCurrentAlias),
	); err != nil {
		return err
	}
	for _, name := range []string{legacyCertificateName, legacyPrivateKeyName} {
		if err := atomicReplaceSymlink(certificateCurrentAlias, filepath.Join(dir, name)); err != nil {
			return err
		}
	}
	return nil
}

func atomicReplaceSymlink(target, path string) error {
	if current, err := os.Readlink(path); err == nil && current == target {
		return nil
	}
	tmpFile, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+".tmp-*")
	if err != nil {
		return err
	}
	tmp := tmpFile.Name()
	if closeErr := tmpFile.Close(); closeErr != nil {
		_ = os.Remove(tmp)
		return closeErr
	}
	if err := os.Remove(tmp); err != nil {
		return err
	}
	defer os.Remove(tmp)
	if err := os.Symlink(target, tmp); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		return err
	}
	syncParentDirectory(path)
	return nil
}

func cleanupCertificateTempsLocked(dir string) {
	cleanupStaleAtomicTemps(dir, []string{
		"." + certificateManifestName + ".tmp-",
		"." + certificateCurrentAlias + ".tmp-",
		"." + legacyCertificateName + ".tmp-",
		"." + legacyPrivateKeyName + ".tmp-",
	}, time.Now(), time.Hour, 32)
	pairsDir := filepath.Join(dir, certificatePairsDirName)
	entries, err := os.ReadDir(pairsDir)
	if err != nil {
		return
	}
	cutoff := time.Now().Add(-time.Hour)
	removed := 0
	for inspected, entry := range entries {
		if inspected >= 512 || removed >= 32 {
			break
		}
		name := entry.Name()
		if !strings.HasPrefix(name, ".") || !strings.Contains(name, ".pem.tmp-") {
			continue
		}
		base := strings.TrimPrefix(strings.SplitN(name, ".pem.tmp-", 2)[0], ".")
		if !validCertificateGeneration(base) {
			continue
		}
		path := filepath.Join(pairsDir, name)
		info, err := os.Lstat(path)
		if err != nil || !info.Mode().IsRegular() || info.Mode().Perm() != 0o600 || !info.ModTime().Before(cutoff) {
			continue
		}
		if os.Remove(path) == nil {
			removed++
		}
	}
}

func cleanupStaleAtomicTemps(dir string, prefixes []string, now time.Time, olderThan time.Duration, limit int) {
	if limit <= 0 {
		return
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	cutoff := now.Add(-olderThan)
	removed := 0
	for inspected, entry := range entries {
		if inspected >= 512 || removed >= limit {
			return
		}
		matched := false
		for _, prefix := range prefixes {
			if strings.HasPrefix(entry.Name(), prefix) {
				matched = true
				break
			}
		}
		if !matched {
			continue
		}
		path := filepath.Join(dir, entry.Name())
		info, err := os.Lstat(path)
		if err != nil || !info.Mode().IsRegular() || info.Mode().Perm() != 0o600 || !info.ModTime().Before(cutoff) {
			continue
		}
		if os.Remove(path) == nil {
			removed++
		}
	}
}

func repairPrivateRegularFile(path string) {
	info, err := os.Lstat(path)
	if err == nil && info.Mode().IsRegular() && info.Mode().Perm() != 0o600 {
		_ = os.Chmod(path, 0o600)
	}
}

func syncParentDirectory(path string) {
	if dir, err := os.Open(filepath.Dir(path)); err == nil {
		_ = dir.Sync()
		_ = dir.Close()
	}
}
