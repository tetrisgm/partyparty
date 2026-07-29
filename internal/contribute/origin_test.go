package contribute

import (
	"strings"
	"testing"
)

// TestOriginServesTheSameStreamShape: a relayed guest must not receive a
// different stream from a direct guest. Same geometry, same low-latency variant.
func TestOriginServesTheSameStreamShape(t *testing.T) {
	yml := OriginYAML(OriginConfig{
		RTSPPort: 8554, HLSPort: 8888,
		CertPath: "/etc/pp/fullchain.pem", KeyPath: "/etc/pp/privkey.pem",
		SegCount: 48, SegDur: "500ms", PartDur: "150ms", Path: "room",
	}, "publisher", "s3cret")

	for _, want := range []string{
		"hlsVariant: lowLatency",
		"hlsSegmentCount: 48",
		"hlsSegmentDuration: 500ms",
		"hlsPartDuration: 150ms",
		"rtspTransports: [tcp]",
	} {
		if !strings.Contains(yml, want) {
			t.Fatalf("origin config missing %q:\n%s", want, yml)
		}
	}
}

// TestOriginRequiresPublishCredentialsButNeverGatesGuests pins both halves of
// the security model: only this Mac may publish, and a guest never needs an
// account to listen.
func TestOriginRequiresPublishCredentialsButNeverGatesGuests(t *testing.T) {
	yml := OriginYAML(OriginConfig{Path: "room"}, "publisher", "s3cret")
	publish := strings.Index(yml, "- user: publisher")
	read := strings.Index(yml, "- user: any")
	if publish < 0 || read < 0 {
		t.Fatalf("origin config is missing an auth block:\n%s", yml)
	}
	if !strings.Contains(yml[publish:read], "action: publish") {
		t.Fatalf("the credentialed user must be the publisher:\n%s", yml)
	}
	if !strings.Contains(yml[read:], "action: read") {
		t.Fatalf("guests must be able to read without an account:\n%s", yml)
	}
	if strings.Contains(yml[read:], "action: publish") {
		t.Fatalf("anonymous publish would let anyone hijack the room:\n%s", yml)
	}
}

// TestOriginBindsPublicly: the Mac binds MediaMTX to loopback because only its
// own proxy talks to it. The origin exists to be reached, so a loopback bind
// there would silently serve nobody.
func TestOriginBindsPublicly(t *testing.T) {
	yml := OriginYAML(OriginConfig{RTSPPort: 8554, HLSPort: 8888, Path: "room"}, "u", "p")
	if strings.Contains(yml, "127.0.0.1") {
		t.Fatalf("origin must not bind to loopback:\n%s", yml)
	}
	for _, want := range []string{"rtspAddress: :8554", "hlsAddress: :8888"} {
		if !strings.Contains(yml, want) {
			t.Fatalf("origin config missing %q:\n%s", want, yml)
		}
	}
}
