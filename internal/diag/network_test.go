package diag

import (
	"go/parser"
	"go/token"
	"io/fs"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// The session log never leaves the Mac, and this is what makes that a fact
// rather than a comment.
//
// The log contains guest IP addresses, reverse-DNS device names and guest
// cids. Until 2026-09-11 this package's own documentation described an upload
// loop in detail: the file "gzipped and shipped to the cloud periodically,
// keyed by install id", MarkUrgent as the nudge for it, TailIfDirty as "the
// upload loop's fuel". None of it existed. TailIfDirty has never had a caller
// and the Worker exposes no ingest route.
//
// That is a worse failure than a missing feature. A session reading those
// comments would reasonably conclude the uploader had regressed and rebuild it
// from the documented API, and would thereby start transferring guest personal
// data to a third party, in contradiction of the published privacy policy,
// with nothing in the build to notice. So the absence is asserted here: adding
// a transport to this package now fails a test, which makes shipping one a
// deliberate act with a conversation attached rather than a plumbing change.
func TestDiagHasNoNetworkTransport(t *testing.T) {
	// Anything that could move bytes off this machine.
	banned := []string{
		"net", "net/http", "net/url", "net/smtp", "net/rpc",
		"crypto/tls", "os/exec", "golang.org/x/net",
	}

	fset := token.NewFileSet()
	pkgs, err := parser.ParseDir(fset, ".", func(fi fs.FileInfo) bool {
		// The package's own source, not this test or any other _test file.
		return strings.HasSuffix(fi.Name(), ".go") && !strings.HasSuffix(fi.Name(), "_test.go")
	}, parser.ImportsOnly)
	if err != nil {
		t.Fatalf("parsing internal/diag: %v", err)
	}
	if len(pkgs) == 0 {
		t.Fatal("no package parsed; this test has stopped checking anything")
	}

	checked := 0
	for _, pkg := range pkgs {
		for name, file := range pkg.Files {
			checked++
			for _, imp := range file.Imports {
				path, err := strconv.Unquote(imp.Path.Value)
				if err != nil {
					continue
				}
				for _, bad := range banned {
					if path == bad || strings.HasPrefix(path, bad+"/") {
						t.Errorf("%s imports %q. The session log holds guest IP addresses, "+
							"device names and cids, and it does not leave the Mac. If an uploader "+
							"is genuinely wanted, that is a privacy decision needing the owner's ask "+
							"and a policy that describes it, not a new import.",
							filepath.Base(name), path)
					}
				}
			}
		}
	}
	if checked == 0 {
		t.Fatal("no source files were examined; this test has stopped checking anything")
	}
}
