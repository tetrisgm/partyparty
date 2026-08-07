package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func testConfig(url string) config {
	return config{
		outboxURL: url, outboxKey: "key", host: "smtp.example", port: "587",
		user: "u", pass: "p", from: "parties@partyparty.party", fromName: "PartyParty",
	}
}

func TestBuildMessageCarriesUnsubscribeAndRefusesInjection(t *testing.T) {
	cfg := testConfig("")
	raw, err := buildMessage(cfg, message{
		To:       "guest@example.com",
		Subject:  "Sundaze: a night",
		BodyText: "Doors at ten\nBring a coat",
		Headers: `{"List-Unsubscribe":"<https://partyparty.party/m/abc?stop=1>",` +
			`"List-Unsubscribe-Post":"List-Unsubscribe=One-Click"}`,
	})
	if err != nil {
		t.Fatal(err)
	}
	text := string(raw)
	// One-click unsubscribe in a mail client is these two headers or nothing.
	if !strings.Contains(text, "List-Unsubscribe: <https://partyparty.party/m/abc?stop=1>") {
		t.Fatalf("unsubscribe header missing:\n%s", text)
	}
	if !strings.Contains(text, "List-Unsubscribe-Post: List-Unsubscribe=One-Click") {
		t.Fatalf("one-click header missing:\n%s", text)
	}
	if !strings.Contains(text, "Doors at ten\r\nBring a coat") {
		t.Fatalf("body line endings must be CRLF:\n%s", text)
	}

	// A newline in a stored value is an attempt to add headers of its own.
	injected, err := buildMessage(cfg, message{
		To:      "guest@example.com",
		Subject: "Fine",
		Headers: `{"X-Bad":"one\r\nBcc: someone@example.com"}`,
	})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(injected), "Bcc:") {
		t.Fatalf("a smuggled header was written:\n%s", injected)
	}

	if _, err := buildMessage(cfg, message{To: "not-an-address"}); err == nil {
		t.Fatal("a malformed recipient must be refused, not sent")
	}
}

type recordingSender struct {
	sent []string
	fail map[string]bool
}

func (r *recordingSender) send(cfg config, m message) error {
	if r.fail[m.ID] {
		return errors.New("mailbox full")
	}
	r.sent = append(r.sent, m.ID)
	return nil
}

func TestRunOnceReportsWhatHappenedWithTheNextRequest(t *testing.T) {
	var seen []drainRequest
	batches := [][]message{
		{{ID: "m1", To: "a@example.com"}, {ID: "m2", To: "b@example.com"}},
		{},
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body drainRequest
		_ = json.NewDecoder(r.Body).Decode(&body)
		seen = append(seen, body)
		batch := []message{}
		if len(seen) <= len(batches) {
			batch = batches[len(seen)-1]
		}
		_ = json.NewEncoder(w).Encode(drainResponse{Messages: batch})
	}))
	defer server.Close()

	cfg := testConfig(server.URL)
	out := &recordingSender{fail: map[string]bool{"m2": true}}
	client := server.Client()

	sent, failed := runOnce(context.Background(), client, cfg, out, nil, nil)
	if len(sent) != 1 || sent[0] != "m1" {
		t.Fatalf("sent = %v", sent)
	}
	if len(failed) != 1 || failed[0].ID != "m2" {
		t.Fatalf("failed = %v", failed)
	}

	// The results ride along with the NEXT request rather than a separate one:
	// a sender that reports separately can die in between and send twice.
	runOnce(context.Background(), client, cfg, out, sent, failed)
	if len(seen) != 2 {
		t.Fatalf("expected two requests, got %d", len(seen))
	}
	if len(seen[1].Sent) != 1 || seen[1].Sent[0] != "m1" {
		t.Fatalf("second request did not report the send: %+v", seen[1])
	}
	if len(seen[1].Failed) != 1 || seen[1].Failed[0].Error != "mailbox full" {
		t.Fatalf("second request did not report the failure: %+v", seen[1])
	}
}

func TestUnreportedResultsSurviveAnUnreachableOutbox(t *testing.T) {
	cfg := testConfig("http://127.0.0.1:1/nope")
	out := &recordingSender{}
	sent, failed := runOnce(context.Background(), &http.Client{}, cfg, out,
		[]string{"m9"}, []failure{{ID: "m8", Error: "x"}})
	// Losing these would mean re-sending a message that already went out.
	if len(sent) != 1 || sent[0] != "m9" || len(failed) != 1 {
		t.Fatalf("results were dropped: sent=%v failed=%v", sent, failed)
	}
}

func TestConfigNamesWhatIsMissing(t *testing.T) {
	t.Setenv("PP_OUTBOX_URL", "")
	if _, err := loadConfig(); err == nil || !strings.Contains(err.Error(), "PP_OUTBOX_URL") {
		t.Fatalf("expected the missing variable to be named, got %v", err)
	}
}
