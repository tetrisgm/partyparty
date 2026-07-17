package main

import (
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
)

type fakeWebPostAdder struct {
	calls  int
	failAt int
}

func (f *fakeWebPostAdder) AddWebPost(string, string, string, string, int64) (bool, error) {
	f.calls++
	if f.calls == f.failAt {
		return false, errors.New("journal full")
	}
	return true, nil
}

func liveAckResponse(status int, body string) *http.Response {
	return &http.Response{
		StatusCode:    status,
		Status:        http.StatusText(status),
		Body:          io.NopCloser(strings.NewReader(body)),
		ContentLength: int64(len(body)),
	}
}

func TestDecodeLiveAckRejectsMalformedAndOversizeBodies(t *testing.T) {
	valid := liveAckResponse(http.StatusOK, `{"webListeners":2,"webPosts":[]}`)
	ack, err := decodeLiveAck(valid)
	if err != nil || ack.WebListeners != 2 {
		t.Fatalf("valid ack = (%+v, %v)", ack, err)
	}

	for _, tc := range []struct {
		name string
		resp *http.Response
	}{
		{"non-200", liveAckResponse(http.StatusBadGateway, `{}`)},
		{"malformed", liveAckResponse(http.StatusOK, `{"webListeners":`)},
		{"trailing garbage", liveAckResponse(http.StatusOK, `{"webListeners":2} garbage`)},
		{"oversize", liveAckResponse(http.StatusOK, strings.Repeat("x", maxLiveAckBytes+1))},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := decodeLiveAck(tc.resp); err == nil {
				t.Fatal("decodeLiveAck unexpectedly accepted response")
			}
		})
	}
}

func TestIngestLiveAckDoesNotAdvancePastJournalFailure(t *testing.T) {
	var ack liveAck
	for i, ts := range []int64{10, 20, 30} {
		wp := struct {
			ID     string `json:"id"`
			Author string `json:"author"`
			Emoji  string `json:"emoji"`
			Text   string `json:"text"`
			TS     int64  `json:"ts"`
		}{ID: string(rune('a' + i)), Text: "post", TS: ts}
		ack.WebPosts = append(ack.WebPosts, wp)
	}
	posts := &fakeWebPostAdder{failAt: 2}
	webSince := int64(0)
	var logs []string
	ingestLiveAck(ack, posts, nil, &webSince, func(format string, _ ...any) {
		logs = append(logs, format)
	})
	if posts.calls != 2 {
		t.Fatalf("AddWebPost calls = %d, want stop at failed second post", posts.calls)
	}
	if webSince != 10 {
		t.Fatalf("webSince = %d, want last successfully persisted timestamp 10", webSince)
	}
	if len(logs) != 2 || logs[1] != "web post inject failed: %v" {
		t.Fatalf("logs = %v, want success then journal failure", logs)
	}
}

func TestRecordLiveCheckinFailureThrottlesRepeatedLogs(t *testing.T) {
	failures := 0
	logs := 0
	for range 20 {
		recordLiveCheckinFailure(&failures, nil, func(string, ...any) { logs++ }, errors.New("offline"))
	}
	if failures != 20 || logs != 3 {
		t.Fatalf("failures/logs = %d/%d, want 20 failures but only beats 1, 10, and 20 logged", failures, logs)
	}
}
