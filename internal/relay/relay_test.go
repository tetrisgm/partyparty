package relay

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"partyparty/internal/activate"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) {
	return f(r)
}

func TestBinaryFrameRoundTrip(t *testing.T) {
	id := "12345678-1234-1234-1234-123456789abc"
	frame := BinaryFrame(id, []byte("audio bytes"))
	gotID, body, ok := DecodeBinaryFrame(frame)
	if !ok || gotID != id || string(body) != "audio bytes" {
		t.Fatalf("decoded frame = %q %q %v", gotID, body, ok)
	}
	if _, _, ok := DecodeBinaryFrame([]byte("short")); ok {
		t.Fatal("short frame was accepted")
	}
}

func TestSessionStreamsRequestAndResponseBodies(t *testing.T) {
	id := "12345678-1234-1234-1234-123456789abc"
	manager := New(Config{OriginURL: "http://relay-origin.invalid"})
	sessionCtx, cancel := context.WithCancel(context.Background())
	defer cancel()
	s := &session{
		manager:  manager,
		ctx:      sessionCtx,
		send:     make(chan outgoing, 16),
		requests: map[string]requestBody{},
		client: &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
			body, err := io.ReadAll(request.Body)
			if err != nil {
				return nil, err
			}
			if string(body) != "guest comment" {
				t.Errorf("origin request body = %q", body)
			}
			if request.Header.Get("X-PartyParty-Relay") != "1" {
				t.Error("origin request is missing the relay marker")
			}
			if request.Header.Get("Content-Type") != "application/json" {
				t.Errorf("content type = %q", request.Header.Get("Content-Type"))
			}
			if request.Header.Get("Cookie") != "cookieCheck=1; hlsSession=session-1" {
				t.Errorf("cookie = %q", request.Header.Get("Cookie"))
			}
			if got := request.Header.Get("Accept-Encoding"); got != "" {
				t.Errorf("accept encoding reached origin = %q", got)
			}
			return &http.Response{
				StatusCode: http.StatusCreated,
				Header:     http.Header{"Content-Type": {"application/json"}},
				Body:       io.NopCloser(strings.NewReader(`{"ok":true}`)),
			}, nil
		})},
	}

	err := s.startRequest(controlMessage{
		Type:    "request",
		ID:      id,
		Method:  http.MethodPost,
		Path:    "/api/comment",
		HasBody: true,
		Headers: map[string][]string{
			"Accept-Encoding": {"gzip"},
			"Content-Type":    {"application/json"},
			"Cookie":          {"cookieCheck=1; hlsSession=session-1"},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := s.handleIncoming(outgoing{
		kind: websocket.MessageBinary,
		data: BinaryFrame(id, []byte("guest comment")),
	}); err != nil {
		t.Fatal(err)
	}
	if err := s.handleIncoming(outgoing{
		kind: websocket.MessageText,
		data: []byte(`{"type":"request_end","id":"` + id + `"}`),
	}); err != nil {
		t.Fatal(err)
	}

	var status int
	var response bytes.Buffer
	for {
		message := <-s.send
		if message.kind == websocket.MessageBinary {
			gotID, body, ok := DecodeBinaryFrame(message.data)
			if !ok || gotID != id {
				t.Fatalf("bad response frame for %q", gotID)
			}
			response.Write(body)
			continue
		}
		var control controlMessage
		if err := jsonUnmarshal(message.data, &control); err != nil {
			t.Fatal(err)
		}
		switch control.Type {
		case "response":
			status = control.Status
		case "response_end":
			if status != http.StatusCreated || response.String() != `{"ok":true}` {
				t.Fatalf("response = status %d body %q", status, response.String())
			}
			return
		case "response_error":
			t.Fatalf("response error: %s", control.Error)
		}
	}
}

func TestOriginClientPreservesHLSCookieRedirect(t *testing.T) {
	requests := 0
	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		requests++
		w.Header().Set("Location", "/live/party/index.m3u8?cookieCheck=1")
		w.Header().Add("Set-Cookie", "cookieCheck=1; HttpOnly; Secure; SameSite=None")
		w.WriteHeader(http.StatusFound)
	}))
	defer origin.Close()

	client := newOriginClient()
	defer client.CloseIdleConnections()
	response, err := client.Get(origin.URL + "/live/party/index.m3u8")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()

	if response.StatusCode != http.StatusFound {
		t.Fatalf("status = %d, want %d", response.StatusCode, http.StatusFound)
	}
	if requests != 1 {
		t.Fatalf("origin requests = %d, redirect was followed", requests)
	}
	if got := response.Header.Get("Location"); got != "/live/party/index.m3u8?cookieCheck=1" {
		t.Fatalf("location = %q", got)
	}
	if got := response.Header.Get("Set-Cookie"); !strings.Contains(got, "cookieCheck=1") {
		t.Fatalf("set-cookie = %q", got)
	}
}

func TestSessionBackpressuresLargeResponses(t *testing.T) {
	id := "12345678-1234-1234-1234-123456789abc"
	payload := bytes.Repeat([]byte("x"), responseWindowBytes+123)
	manager := New(Config{OriginURL: "http://relay-origin.invalid"})
	sessionCtx, cancel := context.WithCancel(context.Background())
	defer cancel()
	s := &session{
		manager:  manager,
		ctx:      sessionCtx,
		send:     make(chan outgoing, 16),
		requests: map[string]requestBody{},
		client: &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
			return &http.Response{
				StatusCode: http.StatusOK,
				Header:     http.Header{"Content-Type": {"application/octet-stream"}},
				Body:       io.NopCloser(bytes.NewReader(payload)),
			}, nil
		})},
	}

	if err := s.startRequest(controlMessage{
		Type:   "request",
		ID:     id,
		Method: http.MethodGet,
		Path:   "/event-cover",
	}); err != nil {
		t.Fatal(err)
	}

	total := 0
	acknowledged := false
	timeout := time.NewTimer(2 * time.Second)
	defer timeout.Stop()
	for {
		select {
		case message := <-s.send:
			if message.kind == websocket.MessageBinary {
				gotID, body, ok := DecodeBinaryFrame(message.data)
				if !ok || gotID != id {
					t.Fatalf("bad response frame for %q", gotID)
				}
				total += len(body)
				if total >= responseWindowBytes && !acknowledged {
					acknowledged = true
					ack, _ := json.Marshal(controlMessage{
						Type:  "response_ack",
						ID:    id,
						Bytes: responseWindowBytes,
					})
					if err := s.handleIncoming(outgoing{kind: websocket.MessageText, data: ack}); err != nil {
						t.Fatal(err)
					}
				}
				continue
			}
			var control controlMessage
			if json.Unmarshal(message.data, &control) != nil {
				continue
			}
			if control.Type == "response_end" {
				if !acknowledged || total != len(payload) {
					t.Fatalf("large response = %d bytes, acknowledged=%v", total, acknowledged)
				}
				return
			}
		case <-timeout.C:
			t.Fatal("large relayed response did not finish")
		}
	}
}

func TestSessionQueuesLiveAudioAheadOfSecondaryResponses(t *testing.T) {
	sessionCtx, cancel := context.WithCancel(context.Background())
	defer cancel()
	s := &session{
		ctx:   sessionCtx,
		send:  make(chan outgoing, 2),
		audio: make(chan outgoing, 2),
	}
	page := outgoing{kind: websocket.MessageText, data: []byte("page")}
	part := outgoing{kind: websocket.MessageBinary, data: []byte("part")}
	if !s.queueForPath("/event-cover", page) {
		t.Fatal("secondary response was not queued")
	}
	if !s.queueForPath("/live/party/part0001.m4s", part) {
		t.Fatal("audio response was not queued")
	}
	if got := <-s.audio; string(got.data) != "part" {
		t.Fatalf("audio queue = %q", got.data)
	}
	if got := <-s.send; string(got.data) != "page" {
		t.Fatalf("secondary queue = %q", got.data)
	}
}

func TestRunSessionProxiesARequestOverWebSocket(t *testing.T) {
	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/api/status" {
			http.NotFound(w, request)
			return
		}
		if request.Header.Get("X-PartyParty-Relay") != "1" {
			http.Error(w, "missing relay marker", http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"mode":"relay"}`)
	}))
	defer origin.Close()

	type result struct {
		status int
		body   string
		err    error
	}
	protocolDone := make(chan result, 1)
	holdSocket := make(chan struct{})
	socketServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		if request.Header.Get("X-PartyParty-Install") != "install-id" ||
			request.Header.Get("X-PartyParty-Secret") != "install-secret" {
			protocolDone <- result{err: fmt.Errorf("relay credentials were not sent")}
			return
		}
		conn, err := websocket.Accept(w, request, nil)
		if err != nil {
			protocolDone <- result{err: err}
			return
		}
		defer conn.CloseNow()
		readCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()

		var initialState controlMessage
		for {
			kind, data, readErr := conn.Read(readCtx)
			if readErr != nil {
				protocolDone <- result{err: readErr}
				return
			}
			if kind != websocket.MessageText {
				continue
			}
			if json.Unmarshal(data, &initialState) == nil && initialState.Type == "state" {
				break
			}
		}
		ack, _ := json.Marshal(controlMessage{
			Type:       "state_ack",
			Mode:       initialState.Mode,
			NetworkKey: initialState.NetworkKey,
		})
		if err := conn.Write(readCtx, websocket.MessageText, ack); err != nil {
			protocolDone <- result{err: err}
			return
		}

		id := "12345678-1234-1234-1234-123456789abc"
		requestMessage, _ := json.Marshal(controlMessage{
			Type:     "request",
			ID:       id,
			Method:   http.MethodGet,
			Path:     "/api/status",
			ClientIP: "203.0.113.45",
		})
		if err := conn.Write(readCtx, websocket.MessageText, requestMessage); err != nil {
			protocolDone <- result{err: err}
			return
		}

		var status int
		var responseBody bytes.Buffer
		for {
			kind, data, readErr := conn.Read(readCtx)
			if readErr != nil {
				protocolDone <- result{err: readErr}
				return
			}
			if kind == websocket.MessageBinary {
				gotID, body, ok := DecodeBinaryFrame(data)
				if !ok || gotID != id {
					protocolDone <- result{err: fmt.Errorf("unexpected binary response for %q", gotID)}
					return
				}
				responseBody.Write(body)
				continue
			}
			var response controlMessage
			if json.Unmarshal(data, &response) != nil || response.ID != id {
				continue
			}
			switch response.Type {
			case "response":
				status = response.Status
			case "response_end":
				protocolDone <- result{status: status, body: responseBody.String()}
				<-holdSocket
				return
			case "response_error":
				protocolDone <- result{err: fmt.Errorf("relay response failed: %s", response.Error)}
				return
			}
		}
	}))
	defer socketServer.Close()

	manager := New(Config{OriginURL: origin.URL, Version: "test"})
	connectURL := "ws" + strings.TrimPrefix(socketServer.URL, "http")
	sessionRegistration := registration{
		RelayRegistration: activateRegistration(
			"https://r-room.partyparty.party/",
			connectURL,
			"network-1",
		),
		InstallID: "install-id",
		Secret:    "install-secret",
	}
	manager.mu.Lock()
	isolated := false
	manager.netTried, manager.internetOK, manager.probe = true, true, &isolated
	manager.reg = sessionRegistration
	manager.mu.Unlock()
	ctx, cancel := context.WithCancel(context.Background())
	sessionDone := make(chan error, 1)
	go func() {
		sessionDone <- manager.runSession(ctx, sessionRegistration)
	}()

	select {
	case got := <-protocolDone:
		if got.err != nil {
			t.Fatal(got.err)
		}
		if got.status != http.StatusOK || got.body != `{"mode":"relay"}` {
			t.Fatalf("relayed response = status %d body %q", got.status, got.body)
		}
		status := manager.Snapshot()
		if !status.RelayConnected || status.JoinURL != "https://r-room.partyparty.party/" {
			t.Fatalf("acknowledged relay status = %+v", status)
		}
	case <-time.After(6 * time.Second):
		t.Fatal("relay protocol timed out")
	}
	cancel()
	close(holdSocket)
	select {
	case <-sessionDone:
	case <-time.After(2 * time.Second):
		t.Fatal("relay session did not stop")
	}
}

func TestManagerOwnsOneModeForTheNetwork(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	manager := New(Config{})
	manager.mu.Lock()
	manager.reg = registration{RelayRegistration: activateRegistration(
		"https://r-room.partyparty.party/",
		"wss://partyparty.party/connect",
		"network-1",
	)}
	manager.directURL = "https://disco.party.partyparty.party:8443/"
	manager.netTried, manager.internetOK, manager.resolverOK = true, true, true
	manager.status = Status{Mode: ModeChecking}
	manager.mu.Unlock()

	manager.applyProbe("another-network", false)
	if got := manager.Snapshot().Mode; got != ModeChecking {
		t.Fatalf("wrong network changed mode to %q", got)
	}
	manager.applyProbe("network-1", false)
	status := manager.Snapshot()
	if status.Mode != ModeRelay || status.JoinURL != "https://r-room.partyparty.party/" || !status.KnownNetwork {
		t.Fatalf("relay status = %+v", status)
	}
	manager.applyProbe("network-1", true)
	status = manager.Snapshot()
	if status.Mode != ModeDirect || status.JoinURL != "https://r-room.partyparty.party/" {
		t.Fatalf("direct status = %+v", status)
	}
}

func TestNetworkTransitionReturnsToChecking(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	manager := New(Config{})
	manager.mu.Lock()
	manager.reg = registration{RelayRegistration: activateRegistration(
		"https://r-room.partyparty.party/",
		"wss://partyparty.party/connect",
		"network-1",
	)}
	manager.directURL = "https://disco.party.partyparty.party:8443/"
	manager.netTried, manager.internetOK, manager.resolverOK = true, true, true
	manager.status = Status{
		Mode:         ModeDirect,
		JoinURL:      "https://r-room.partyparty.party/",
		DirectURL:    manager.directURL,
		KnownNetwork: true,
		Message:      directMessage,
	}
	manager.mu.Unlock()

	manager.noteNetworkTransition()
	status := manager.Snapshot()
	if status.Mode != ModeChecking || status.KnownNetwork {
		t.Fatalf("transition status = %+v", status)
	}
	if status.JoinURL != "" || status.DirectURL != manager.directURL {
		t.Fatalf("transition URLs = %+v", status)
	}

	// Losing the broker is LOCAL, not a faked DIRECT: guests still get the direct
	// link, and the console says the internet is gone rather than implying the
	// cloud check passed.
	manager.noteRegistrationFailure()
	status = manager.Snapshot()
	if status.Mode != ModeLocal || status.JoinURL != manager.directURL {
		t.Fatalf("offline transition status = %+v", status)
	}
}

func TestDirectURLDoesNotBypassInitialCheck(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	manager := New(Config{})
	manager.SetDirectURL("https://disco.party.partyparty.party:8443/")
	status := manager.Snapshot()
	if status.Mode != ModeChecking || status.JoinURL != "" {
		t.Fatalf("initial status = %+v", status)
	}
}

func TestExpiredRelayVerdictIsRechecked(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	manager := New(Config{})
	manager.mu.Lock()
	manager.verdicts["network-1"] = verdict{
		Mode:      ModeRelay,
		UpdatedAt: time.Now().Add(-verdictMaxAge - time.Minute).UnixMilli(),
	}
	manager.mu.Unlock()

	manager.applyRegistration(registration{
		RelayRegistration: activateRegistration(
			"https://r-room.partyparty.party/",
			"wss://partyparty.party/connect",
			"network-1",
		),
	})
	status := manager.Snapshot()
	if status.Mode != ModeChecking || status.KnownNetwork {
		t.Fatalf("expired verdict status = %+v", status)
	}
}

func TestUsableLANIP(t *testing.T) {
	for _, value := range []string{"192.168.1.4", "10.0.0.2", "172.16.8.9"} {
		if !usableLANIP(value) {
			t.Fatalf("%q should be usable", value)
		}
	}
	for _, value := range []string{"", "127.0.0.1", "169.254.1.2", "::1", "invalid"} {
		if usableLANIP(value) {
			t.Fatalf("%q should not be usable", value)
		}
	}
}

func activateRegistration(join, connect, network string) activate.RelayRegistration {
	return activate.RelayRegistration{JoinURL: join, ConnectURL: connect, NetworkKey: network}
}

func jsonUnmarshal(data []byte, out any) error {
	return json.Unmarshal(data, out)
}
