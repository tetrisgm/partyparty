// Package relay provides the isolated-Wi-Fi fallback. The Mac always owns the
// room mode. In direct mode guests use the certificate-backed LAN URL. In relay
// mode one authenticated outbound WebSocket carries the existing guest HTTP
// surface through Cloudflare without changing the HLS stream or audio engine.
package relay

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"

	"partyparty/internal/activate"
	"partyparty/internal/netinfo"
)

const (
	ModeChecking = "checking"
	ModeDirect   = "direct"
	ModeRelay    = "relay"

	binaryIDBytes       = 36
	maxChunkBytes       = 64 << 10
	maxVerdicts         = 32
	responseWindowBytes = 512 << 10

	lanPollInterval             = 2 * time.Second
	registrationRefreshInterval = 30 * time.Second
	registrationRetryInterval   = 15 * time.Second
	relayReconnectInterval      = 2 * time.Second
	verdictMaxAge               = 24 * time.Hour
)

// Status is the one authoritative room connection state exposed to the Mac
// console and menu bar.
type Status struct {
	Mode           string `json:"mode"`
	JoinURL        string `json:"joinUrl,omitempty"`
	DirectURL      string `json:"directUrl,omitempty"`
	KnownNetwork   bool   `json:"knownNetwork"`
	RelayConnected bool   `json:"relayConnected"`
	Message        string `json:"message"`
}

// Config contains only local runtime details. Install authentication remains in
// the activation state directory and is never exposed through /api/status.
type Config struct {
	BrokerURL string
	OriginURL string
	Version   string
	Logf      func(format string, args ...any)
}

type registration struct {
	activate.RelayRegistration
	InstallID string
	Secret    string
}

type verdict struct {
	Mode      string `json:"mode"`
	UpdatedAt int64  `json:"updatedAt"`
}

type verdictFile struct {
	Networks map[string]verdict `json:"networks"`
}

// Manager supervises registration, network verdict persistence, and the
// outbound relay connection.
type Manager struct {
	cfg Config

	mu        sync.RWMutex
	status    Status
	reg       registration
	verdicts  map[string]verdict
	directURL string

	regChanged   chan struct{}
	stateChanged chan struct{}
}

// New creates a manager. Start must be called after the guest-only loopback
// origin is listening.
func New(cfg Config) *Manager {
	if cfg.Logf == nil {
		cfg.Logf = func(string, ...any) {}
	}
	m := &Manager{
		cfg:          cfg,
		verdicts:     loadVerdicts(),
		regChanged:   make(chan struct{}, 1),
		stateChanged: make(chan struct{}, 1),
		status: Status{
			Mode:    ModeChecking,
			Message: checkingMessage,
		},
	}
	return m
}

const (
	checkingMessage = "Checking whether guests can connect directly on this Wi-Fi. Scan the QR code once to finish the check."
	directMessage   = "Guests are connecting directly to this Mac on the venue Wi-Fi."
	relayMessage    = "This Wi-Fi limits connections between nearby devices. PartyParty is using an internet connection so guests can keep listening. This may increase the delay between the DJ and listeners."
	offlineMessage  = "The internet is unavailable. Guests will connect directly on this Wi-Fi."
)

// Start runs until ctx is canceled.
func (m *Manager) Start(ctx context.Context) {
	go m.registrationLoop(ctx)
	go m.connectionLoop(ctx)
}

// SetDirectURL supplies the currently activated certificate-backed LAN URL.
func (m *Manager) SetDirectURL(directURL string) {
	directURL = strings.TrimSpace(directURL)
	m.mu.Lock()
	if m.directURL == directURL {
		m.mu.Unlock()
		return
	}
	previousDirectURL := m.directURL
	m.directURL = directURL
	m.status.DirectURL = directURL
	if m.status.Mode == ModeDirect {
		if m.status.JoinURL == previousDirectURL {
			m.status.JoinURL = directURL
		} else if m.reg.JoinURL == "" || m.status.RelayConnected {
			m.status.JoinURL = m.joinURLLocked()
		}
	}
	m.mu.Unlock()
	m.signal(m.stateChanged)
}

// Snapshot returns a consistent copy for /api/status.
func (m *Manager) Snapshot() Status {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.status
}

func (m *Manager) registrationLoop(ctx context.Context) {
	var lastIP string
	lanIP := netinfo.PrimaryLanIP()
	for {
		if lastIP != "" && lanIP != lastIP {
			m.noteNetworkTransition()
		}
		lastIP = lanIP
		if !usableLANIP(lanIP) {
			var ok bool
			lanIP, ok = waitForRegistrationRefresh(ctx, lastIP, lanPollInterval)
			if !ok {
				return
			}
			continue
		}

		attemptCtx, cancel := context.WithTimeout(ctx, 6*time.Second)
		registered, err := activate.RegisterRelay(attemptCtx, m.brokerURL(), lanIP, m.cfg.Logf)
		cancel()
		if currentIP := netinfo.PrimaryLanIP(); currentIP != lanIP {
			lanIP = currentIP
			continue
		}
		nextDelay := registrationRefreshInterval
		if err != nil {
			m.noteRegistrationFailure()
			m.cfg.Logf("relay: registration unavailable: %v", err)
			nextDelay = registrationRetryInterval
		} else {
			id, secret := activate.InstallCreds()
			if id == "" || secret == "" {
				m.noteRegistrationFailure()
				nextDelay = 5 * time.Second
			} else {
				m.applyRegistration(registration{
					RelayRegistration: registered,
					InstallID:         id,
					Secret:            secret,
				})
			}
		}

		var ok bool
		lanIP, ok = waitForRegistrationRefresh(ctx, lastIP, nextDelay)
		if !ok {
			return
		}
	}
}

func usableLANIP(value string) bool {
	ip := net.ParseIP(strings.TrimSpace(value))
	return ip != nil && ip.To4() != nil && !ip.IsLoopback() && !ip.IsLinkLocalUnicast()
}

func waitForRegistrationRefresh(ctx context.Context, currentIP string, maximum time.Duration) (string, bool) {
	timer := time.NewTimer(maximum)
	ticker := time.NewTicker(lanPollInterval)
	defer timer.Stop()
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return "", false
		case <-timer.C:
			return netinfo.PrimaryLanIP(), true
		case <-ticker.C:
			if nextIP := netinfo.PrimaryLanIP(); nextIP != currentIP {
				return nextIP, true
			}
		}
	}
}

func (m *Manager) noteNetworkTransition() {
	m.mu.Lock()
	m.status.Mode = ModeChecking
	m.status.KnownNetwork = false
	m.status.JoinURL = ""
	m.status.DirectURL = m.directURL
	m.status.Message = checkingMessage
	m.mu.Unlock()
	m.signal(m.stateChanged)
}

func (m *Manager) brokerURL() string {
	if strings.TrimSpace(m.cfg.BrokerURL) != "" {
		return strings.TrimRight(strings.TrimSpace(m.cfg.BrokerURL), "/")
	}
	return "https://partyparty.party"
}

func (m *Manager) applyRegistration(next registration) {
	m.mu.Lock()
	previousConnect := m.reg.ConnectURL
	networkChanged := m.reg.NetworkKey != next.NetworkKey
	m.reg = next
	if networkChanged {
		if cached, ok := m.verdicts[next.NetworkKey]; ok &&
			time.Since(time.UnixMilli(cached.UpdatedAt)) <= verdictMaxAge &&
			validMode(cached.Mode) && cached.Mode != ModeChecking {
			m.status.Mode = cached.Mode
			m.status.KnownNetwork = true
		} else {
			delete(m.verdicts, next.NetworkKey)
			m.status.Mode = ModeChecking
			m.status.KnownNetwork = false
		}
	}
	m.status.DirectURL = m.directURL
	if networkChanged {
		m.status.JoinURL = ""
	} else if m.status.RelayConnected {
		m.status.JoinURL = m.joinURLLocked()
	}
	m.status.Message = messageForMode(m.status.Mode)
	m.mu.Unlock()

	m.signal(m.stateChanged)
	if previousConnect != next.ConnectURL {
		m.signal(m.regChanged)
	}
}

func (m *Manager) noteRegistrationFailure() {
	m.mu.Lock()
	if m.directURL != "" && (m.status.JoinURL == "" || m.status.Mode == ModeDirect) {
		m.status.Mode = ModeDirect
		m.status.JoinURL = m.directURL
		m.status.DirectURL = m.directURL
		m.status.KnownNetwork = false
		m.status.Message = offlineMessage
	}
	m.mu.Unlock()
	m.signal(m.stateChanged)
}

func (m *Manager) joinURLLocked() string {
	if m.reg.JoinURL != "" {
		return m.reg.JoinURL
	}
	return m.directURL
}

func (m *Manager) applyProbe(networkKey string, reachable bool) {
	m.mu.Lock()
	if networkKey == "" || networkKey != m.reg.NetworkKey {
		m.mu.Unlock()
		return
	}
	mode := ModeRelay
	if reachable && m.directURL != "" {
		mode = ModeDirect
	}
	m.status.Mode = mode
	m.status.KnownNetwork = true
	m.status.JoinURL = m.joinURLLocked()
	m.status.Message = messageForMode(mode)
	m.verdicts[networkKey] = verdict{Mode: mode, UpdatedAt: time.Now().UnixMilli()}
	copyForSave := cloneVerdicts(m.verdicts)
	m.mu.Unlock()

	saveVerdicts(copyForSave)
	m.cfg.Logf("relay: this network is now %s", mode)
	m.signal(m.stateChanged)
}

func messageForMode(mode string) string {
	switch mode {
	case ModeDirect:
		return directMessage
	case ModeRelay:
		return relayMessage
	default:
		return checkingMessage
	}
}

func validMode(mode string) bool {
	return mode == ModeChecking || mode == ModeDirect || mode == ModeRelay
}

func (m *Manager) signal(ch chan struct{}) {
	select {
	case ch <- struct{}{}:
	default:
	}
}

func (m *Manager) currentRegistration() registration {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.reg
}

func (m *Manager) stateMessage() controlMessage {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return controlMessage{
		Type:       "state",
		Mode:       m.status.Mode,
		DirectURL:  m.directURL,
		NetworkKey: m.reg.NetworkKey,
		Version:    m.cfg.Version,
	}
}

func (m *Manager) setRelayConnected(connected bool) {
	m.mu.Lock()
	if m.status.RelayConnected == connected {
		m.mu.Unlock()
		return
	}
	m.status.RelayConnected = connected
	m.mu.Unlock()
	m.signal(m.stateChanged)
}

func (m *Manager) confirmRelayState(networkKey string) {
	m.mu.Lock()
	if networkKey == "" || networkKey != m.reg.NetworkKey {
		m.mu.Unlock()
		return
	}
	changed := !m.status.RelayConnected || m.status.JoinURL == ""
	m.status.RelayConnected = true
	m.status.JoinURL = m.joinURLLocked()
	m.mu.Unlock()
	if changed {
		m.signal(m.stateChanged)
	}
}

func (m *Manager) connectionLoop(ctx context.Context) {
	for {
		reg := m.currentRegistration()
		if reg.ConnectURL == "" {
			timer := time.NewTimer(lanPollInterval)
			select {
			case <-ctx.Done():
				timer.Stop()
				return
			case <-m.regChanged:
				timer.Stop()
				continue
			case <-timer.C:
				continue
			}
		}

		sessionCtx, cancel := context.WithCancel(ctx)
		done := make(chan error, 1)
		go func() { done <- m.runSession(sessionCtx, reg) }()
		select {
		case <-ctx.Done():
			cancel()
			<-done
			return
		case <-m.regChanged:
			cancel()
			<-done
			m.setRelayConnected(false)
		case err := <-done:
			cancel()
			m.setRelayConnected(false)
			if err != nil && !errors.Is(err, context.Canceled) {
				m.cfg.Logf("relay: connection ended: %v", err)
			}
			timer := time.NewTimer(relayReconnectInterval)
			select {
			case <-ctx.Done():
				timer.Stop()
				return
			case <-m.regChanged:
				timer.Stop()
			case <-timer.C:
			}
		}
	}
}

type controlMessage struct {
	Type       string              `json:"type"`
	ID         string              `json:"id,omitempty"`
	Method     string              `json:"method,omitempty"`
	Path       string              `json:"path,omitempty"`
	Host       string              `json:"host,omitempty"`
	ClientIP   string              `json:"clientIp,omitempty"`
	Headers    map[string][]string `json:"headers,omitempty"`
	HasBody    bool                `json:"hasBody,omitempty"`
	Status     int                 `json:"status,omitempty"`
	Error      string              `json:"error,omitempty"`
	Mode       string              `json:"mode,omitempty"`
	DirectURL  string              `json:"directUrl,omitempty"`
	NetworkKey string              `json:"networkKey,omitempty"`
	Version    string              `json:"version,omitempty"`
	Reachable  *bool               `json:"reachable,omitempty"`
	Bytes      int                 `json:"bytes,omitempty"`
}

type outgoing struct {
	kind websocket.MessageType
	data []byte
}

type requestBody struct {
	writer      *io.PipeWriter
	cancel      context.CancelFunc
	responseAck chan int
}

type session struct {
	manager *Manager
	conn    *websocket.Conn
	ctx     context.Context
	client  *http.Client
	send    chan outgoing
	audio   chan outgoing

	mu       sync.Mutex
	requests map[string]requestBody
}

func (m *Manager) runSession(ctx context.Context, reg registration) error {
	headers := http.Header{}
	headers.Set("X-PartyParty-Install", reg.InstallID)
	headers.Set("X-PartyParty-Secret", reg.Secret)
	conn, response, err := websocket.Dial(ctx, reg.ConnectURL, &websocket.DialOptions{
		HTTPHeader:      headers,
		CompressionMode: websocket.CompressionDisabled,
	})
	if err != nil {
		if response != nil {
			return fmt.Errorf("connect: %s", response.Status)
		}
		return err
	}
	defer conn.CloseNow()
	conn.SetReadLimit(2 << 20)

	sessionCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	s := &session{
		manager: m,
		conn:    conn,
		ctx:     sessionCtx,
		client: &http.Client{Transport: &http.Transport{
			Proxy:                 http.ProxyFromEnvironment,
			MaxIdleConns:          64,
			MaxIdleConnsPerHost:   64,
			IdleConnTimeout:       90 * time.Second,
			DisableCompression:    true,
			ResponseHeaderTimeout: 40 * time.Second,
		}},
		send:     make(chan outgoing, 128),
		audio:    make(chan outgoing, 128),
		requests: make(map[string]requestBody),
	}

	initialState, err := json.Marshal(m.stateMessage())
	if err != nil {
		return err
	}
	initialWriteCtx, initialWriteCancel := context.WithTimeout(sessionCtx, 20*time.Second)
	err = conn.Write(initialWriteCtx, websocket.MessageText, initialState)
	initialWriteCancel()
	if err != nil {
		return err
	}
	incoming := make(chan outgoing, 32)
	readErr := make(chan error, 1)
	go func() {
		for {
			kind, data, readError := conn.Read(sessionCtx)
			if readError != nil {
				readErr <- readError
				return
			}
			select {
			case incoming <- outgoing{kind: kind, data: data}:
			case <-sessionCtx.Done():
				return
			}
		}
	}()

	heartbeat := time.NewTicker(20 * time.Second)
	defer heartbeat.Stop()
	defer s.cancelRequests()

	for {
		select {
		case message := <-s.audio:
			if err := s.writeOutgoing(sessionCtx, message); err != nil {
				return err
			}
			continue
		default:
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case err := <-readErr:
			return err
		case message := <-incoming:
			if err := s.handleIncoming(message); err != nil {
				return err
			}
		case message := <-s.audio:
			if err := s.writeOutgoing(sessionCtx, message); err != nil {
				return err
			}
		case message := <-s.send:
			if err := s.writeOutgoing(sessionCtx, message); err != nil {
				return err
			}
		case <-m.stateChanged:
			s.queueJSON(m.stateMessage())
		case <-heartbeat.C:
			pingCtx, pingCancel := context.WithTimeout(sessionCtx, 10*time.Second)
			err := conn.Ping(pingCtx)
			pingCancel()
			if err != nil {
				return err
			}
		}
	}
}

func (s *session) writeOutgoing(ctx context.Context, message outgoing) error {
	writeCtx, writeCancel := context.WithTimeout(ctx, 20*time.Second)
	defer writeCancel()
	return s.conn.Write(writeCtx, message.kind, message.data)
}

func (s *session) handleIncoming(in outgoing) error {
	if in.kind == websocket.MessageBinary {
		if len(in.data) < binaryIDBytes {
			return errors.New("relay: short binary message")
		}
		id := string(in.data[:binaryIDBytes])
		s.mu.Lock()
		req, ok := s.requests[id]
		s.mu.Unlock()
		if !ok || req.writer == nil {
			return nil
		}
		if _, err := req.writer.Write(in.data[binaryIDBytes:]); err != nil && !errors.Is(err, io.ErrClosedPipe) {
			req.cancel()
		}
		return nil
	}
	if in.kind != websocket.MessageText {
		return nil
	}
	var message controlMessage
	if err := json.Unmarshal(in.data, &message); err != nil {
		return errors.New("relay: invalid control message")
	}
	switch message.Type {
	case "request":
		return s.startRequest(message)
	case "request_end":
		s.finishRequestBody(message.ID)
	case "request_cancel":
		s.cancelRequest(message.ID)
	case "probe":
		if message.Reachable != nil {
			s.manager.applyProbe(message.NetworkKey, *message.Reachable)
		}
	case "state_ack":
		s.manager.confirmRelayState(message.NetworkKey)
	case "response_ack":
		s.ackResponse(message.ID, message.Bytes)
	}
	return nil
}

func (s *session) startRequest(message controlMessage) error {
	if len(message.ID) != binaryIDBytes || !safeRequestPath(message.Path) {
		return errors.New("relay: invalid request")
	}
	method := strings.ToUpper(message.Method)
	switch method {
	case http.MethodGet, http.MethodHead, http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete, http.MethodOptions:
	default:
		s.queueJSON(controlMessage{Type: "response_error", ID: message.ID, Error: "method not allowed"})
		return nil
	}

	requestCtx, cancel := context.WithCancel(s.ctx)
	var reader io.Reader
	active := requestBody{
		cancel:      cancel,
		responseAck: make(chan int, 1),
	}
	if message.HasBody {
		pipeReader, pipeWriter := io.Pipe()
		reader = pipeReader
		active.writer = pipeWriter
	}
	s.mu.Lock()
	if _, exists := s.requests[message.ID]; exists {
		s.mu.Unlock()
		cancel()
		if active.writer != nil {
			active.writer.Close()
		}
		return errors.New("relay: duplicate request")
	}
	s.requests[message.ID] = active
	s.mu.Unlock()

	go s.serveRequest(requestCtx, cancel, message, reader, active.responseAck)
	return nil
}

func safeRequestPath(path string) bool {
	if path == "" || !strings.HasPrefix(path, "/") || strings.HasPrefix(path, "//") {
		return false
	}
	parsed, err := url.ParseRequestURI(path)
	return err == nil && parsed.IsAbs() == false && parsed.Host == ""
}

func (s *session) serveRequest(
	ctx context.Context,
	cancel context.CancelFunc,
	message controlMessage,
	body io.Reader,
	responseAck <-chan int,
) {
	defer cancel()
	defer s.completeRequest(message.ID)
	target, err := url.Parse(strings.TrimRight(s.manager.cfg.OriginURL, "/") + message.Path)
	if err != nil {
		s.queueJSON(controlMessage{Type: "response_error", ID: message.ID, Error: "bad origin URL"})
		return
	}
	req, err := http.NewRequestWithContext(ctx, message.Method, target.String(), body)
	if err != nil {
		s.queueJSON(controlMessage{Type: "response_error", ID: message.ID, Error: "bad request"})
		return
	}
	copyRequestHeaders(req.Header, message.Headers)
	req.Header.Set("X-PartyParty-Relay", "1")
	if net.ParseIP(message.ClientIP) != nil {
		req.Header.Set("X-PartyParty-Client-IP", message.ClientIP)
	}
	if message.Host != "" {
		req.Host = message.Host
	}

	response, err := s.client.Do(req)
	if err != nil {
		s.queueJSONForPath(message.Path, controlMessage{Type: "response_error", ID: message.ID, Error: "Mac guest server unavailable"})
		return
	}
	defer response.Body.Close()
	s.queueJSONForPath(message.Path, controlMessage{
		Type:    "response",
		ID:      message.ID,
		Status:  response.StatusCode,
		Headers: responseHeaders(response.Header),
	})
	buffer := make([]byte, maxChunkBytes)
	windowRemaining := responseWindowBytes
	for {
		n, readErr := response.Body.Read(buffer)
		if n > 0 {
			frame := make([]byte, binaryIDBytes+n)
			copy(frame, message.ID)
			copy(frame[binaryIDBytes:], buffer[:n])
			if !s.queueForPath(message.Path, outgoing{kind: websocket.MessageBinary, data: frame}) {
				return
			}
			windowRemaining -= n
			for windowRemaining <= 0 {
				select {
				case acknowledged := <-responseAck:
					if acknowledged > 0 {
						windowRemaining += acknowledged
					}
				case <-ctx.Done():
					return
				}
			}
		}
		if readErr != nil {
			if readErr != io.EOF {
				s.queueJSONForPath(message.Path, controlMessage{Type: "response_error", ID: message.ID, Error: "response interrupted"})
				return
			}
			break
		}
	}
	s.queueJSONForPath(message.Path, controlMessage{Type: "response_end", ID: message.ID})
}

func (s *session) ackResponse(id string, bytes int) {
	if bytes <= 0 {
		return
	}
	s.mu.Lock()
	req, ok := s.requests[id]
	s.mu.Unlock()
	if !ok {
		return
	}
	select {
	case req.responseAck <- bytes:
	default:
	}
}

func copyRequestHeaders(dst http.Header, src map[string][]string) {
	for name, values := range src {
		if !allowedRequestHeader(name) {
			continue
		}
		for _, value := range values {
			dst.Add(name, value)
		}
	}
}

func allowedRequestHeader(name string) bool {
	switch strings.ToLower(strings.TrimSpace(name)) {
	case "accept", "accept-language", "cache-control", "content-type",
		"if-modified-since", "if-none-match", "range", "user-agent", "x-pp-name":
		return true
	default:
		return false
	}
}

func responseHeaders(src http.Header) map[string][]string {
	out := make(map[string][]string)
	for name, values := range src {
		switch strings.ToLower(name) {
		case "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
			"te", "trailer", "transfer-encoding", "upgrade":
			continue
		}
		out[name] = append([]string(nil), values...)
	}
	return out
}

func (s *session) finishRequestBody(id string) {
	s.mu.Lock()
	req, ok := s.requests[id]
	writer := req.writer
	if ok && req.writer != nil {
		req.writer = nil
		s.requests[id] = req
	}
	s.mu.Unlock()
	if ok && writer != nil {
		writer.Close()
	}
}

func (s *session) completeRequest(id string) {
	s.mu.Lock()
	req, ok := s.requests[id]
	if ok {
		delete(s.requests, id)
	}
	s.mu.Unlock()
	if ok && req.writer != nil {
		req.writer.Close()
	}
}

func (s *session) cancelRequest(id string) {
	s.mu.Lock()
	req, ok := s.requests[id]
	if ok {
		delete(s.requests, id)
	}
	s.mu.Unlock()
	if ok {
		if req.writer != nil {
			req.writer.CloseWithError(context.Canceled)
		}
		req.cancel()
	}
}

func (s *session) cancelRequests() {
	s.mu.Lock()
	requests := s.requests
	s.requests = make(map[string]requestBody)
	s.mu.Unlock()
	for _, req := range requests {
		if req.writer != nil {
			req.writer.CloseWithError(context.Canceled)
		}
		req.cancel()
	}
}

func (s *session) queueJSON(message controlMessage) bool {
	data, err := json.Marshal(message)
	if err != nil {
		return false
	}
	return s.queue(outgoing{kind: websocket.MessageText, data: data})
}

func (s *session) queueJSONForPath(path string, message controlMessage) bool {
	data, err := json.Marshal(message)
	if err != nil {
		return false
	}
	return s.queueForPath(path, outgoing{kind: websocket.MessageText, data: data})
}

func (s *session) queueForPath(path string, message outgoing) bool {
	if relayAudioPath(path) {
		select {
		case s.audio <- message:
			return true
		case <-s.ctx.Done():
			return false
		}
	}
	return s.queue(message)
}

func relayAudioPath(path string) bool {
	parsed, err := url.ParseRequestURI(path)
	return err == nil && strings.HasPrefix(parsed.Path, "/live/")
}

func (s *session) queue(message outgoing) bool {
	select {
	case s.send <- message:
		return true
	case <-s.ctx.Done():
		return false
	}
}

func verdictPath() string {
	dir, err := activate.StateDir()
	if err != nil {
		return ""
	}
	return filepath.Join(dir, "network-verdicts.json")
}

func loadVerdicts() map[string]verdict {
	out := make(map[string]verdict)
	path := verdictPath()
	if path == "" {
		return out
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return out
	}
	var file verdictFile
	if json.Unmarshal(data, &file) != nil {
		return out
	}
	cutoff := time.Now().Add(-verdictMaxAge).UnixMilli()
	for key, item := range file.Networks {
		if key != "" && item.UpdatedAt >= cutoff && (item.Mode == ModeDirect || item.Mode == ModeRelay) {
			out[key] = item
		}
	}
	return out
}

func saveVerdicts(networks map[string]verdict) {
	path := verdictPath()
	if path == "" {
		return
	}
	type entry struct {
		key string
		verdict
	}
	items := make([]entry, 0, len(networks))
	for key, item := range networks {
		items = append(items, entry{key: key, verdict: item})
	}
	sort.Slice(items, func(i, j int) bool { return items[i].UpdatedAt > items[j].UpdatedAt })
	if len(items) > maxVerdicts {
		items = items[:maxVerdicts]
	}
	trimmed := make(map[string]verdict, len(items))
	for _, item := range items {
		trimmed[item.key] = item.verdict
	}
	data, err := json.Marshal(verdictFile{Networks: trimmed})
	if err != nil {
		return
	}
	tmp := path + ".tmp"
	if os.WriteFile(tmp, append(data, '\n'), 0o600) == nil {
		_ = os.Rename(tmp, path)
	}
}

func cloneVerdicts(src map[string]verdict) map[string]verdict {
	out := make(map[string]verdict, len(src))
	for key, item := range src {
		out[key] = item
	}
	return out
}

// BinaryFrame is exported only for protocol tests.
func BinaryFrame(id string, body []byte) []byte {
	return append(append(make([]byte, 0, binaryIDBytes+len(body)), []byte(id)...), body...)
}

// DecodeBinaryFrame is exported only for protocol tests.
func DecodeBinaryFrame(frame []byte) (string, []byte, bool) {
	if len(frame) < binaryIDBytes {
		return "", nil, false
	}
	return string(frame[:binaryIDBytes]), bytes.Clone(frame[binaryIDBytes:]), true
}
