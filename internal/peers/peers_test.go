package peers

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/grandcat/zeroconf"
)

func TestTXTValues(t *testing.T) {
	got := txtValues([]string{"id=abc", "host=two-step.party.partyparty.party", "invalid"})
	if got["id"] != "abc" || got["host"] != "two-step.party.partyparty.party" {
		t.Fatalf("txtValues = %#v", got)
	}
	if _, ok := got["invalid"]; ok {
		t.Fatalf("invalid TXT field was retained: %#v", got)
	}
}

func TestBonjourAdvertisement(t *testing.T) {
	if os.Getenv("PP_TEST_MDNS") != "1" {
		t.Skip("set PP_TEST_MDNS=1 for a physical multicast round trip")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	d, err := New(ctx, "roundtrip-test", "roundtrip.local", 18443)
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()

	resolver, err := zeroconf.NewResolver(nil)
	if err != nil {
		t.Fatal(err)
	}
	entries := make(chan *zeroconf.ServiceEntry)
	go func() { _ = resolver.Browse(ctx, service, "local.", entries) }()
	for {
		select {
		case <-ctx.Done():
			t.Fatal("Bonjour advertisement was not discovered")
		case entry := <-entries:
			if txtValues(entry.Text)["id"] == "roundtrip-test" {
				return
			}
		}
	}
}

func TestProbeKeepsOnlyVerifiedPeer(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/peer" {
			http.NotFound(w, r)
			return
		}
		_ = json.NewEncoder(w).Encode(Peer{ID: "other", Name: "Seth", Live: true, Ready: true, StreamURL: serverURL(r) + "/live/party/index.m3u8"})
	}))
	defer server.Close()

	d := &Directory{
		selfID:     "self",
		client:     server.Client(),
		candidates: map[string]candidate{"other": {id: "other", roomURL: server.URL, seen: time.Now()}},
		peers:      make(map[string]Peer),
	}
	d.probe(context.Background())
	got := d.Peers()
	if len(got) != 1 || got[0].ID != "other" || got[0].RoomURL != server.URL || !got[0].Ready {
		t.Fatalf("peers = %#v", got)
	}
}

func serverURL(r *http.Request) string {
	return "https://" + r.Host
}
