// Package dnsd provides a tiny local UDP DNS responder for owned hostnames.
package dnsd

import (
	"encoding/binary"
	"errors"
	"net"
	"strings"
	"sync"
	"time"
)

// LocalAddr is where the local DNS server listens. The privileged pf helper
// (cmd/pp-port80) redirects inbound udp/53 here when we are the network.
const LocalAddr = "127.0.0.1:5354"

const (
	defaultAddr  = "127.0.0.1:0"
	maxPacket    = 512
	dnsHeaderLen = 12

	typeA    = 1
	typeAAAA = 28
	classIN  = 1

	rcodeNoError = 0
	rcodeFormErr = 1
)

// Config controls a local DNS server.
type Config struct {
	Addr     string
	Hosts    []string
	TargetIP string
	TTL      time.Duration // A-record TTL (default 5s)
	CatchAll bool          // answer every A query with TargetIP (captive mode)
	Logf     func(format string, args ...any)
}

// Server answers A and AAAA DNS queries for a small set of local hostnames.
type Server struct {
	addr string
	ttl  uint32

	mu     sync.RWMutex
	hosts  map[string]struct{}
	target net.IP
	all    bool
	logf   func(format string, args ...any)

	runMu sync.Mutex
	conn  *net.UDPConn
	done  chan struct{}
}

// New returns a server configured from cfg.
func New(cfg Config) *Server {
	if cfg.Addr == "" {
		cfg.Addr = defaultAddr
	}
	ttl := uint32(cfg.TTL / time.Second)
	if ttl == 0 {
		ttl = 5
	}
	s := &Server{addr: cfg.Addr, ttl: ttl, logf: cfg.Logf}
	s.SetHosts(cfg.Hosts)
	s.SetTarget(cfg.TargetIP)
	s.SetCatchAll(cfg.CatchAll)
	return s
}

// Update replaces both the owned hostnames and the target IP in one call.
func (s *Server) Update(hosts []string, ip string) {
	s.SetHosts(hosts)
	s.SetTarget(ip)
}

// SetCatchAll changes whether the server answers A queries for every hostname.
func (s *Server) SetCatchAll(on bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.all = on
}

// SetTarget changes the IPv4 address returned by later A responses.
func (s *Server) SetTarget(ip string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.target = net.ParseIP(strings.TrimSpace(ip)).To4()
}

// SetHosts replaces the owned hostname set used by later queries.
func (s *Server) SetHosts(hosts []string) {
	next := make(map[string]struct{}, len(hosts))
	for _, host := range hosts {
		if host = normalizeHost(host); host != "" {
			next[host] = struct{}{}
		}
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	s.hosts = next
}

// Start binds the UDP socket and starts serving in a goroutine.
func (s *Server) Start() error {
	s.runMu.Lock()
	defer s.runMu.Unlock()
	if s.conn != nil {
		return errors.New("dnsd: server already started")
	}

	addr, err := net.ResolveUDPAddr("udp", s.addr)
	if err != nil {
		return err
	}
	conn, err := net.ListenUDP("udp", addr)
	if err != nil {
		return err
	}

	s.conn = conn
	s.done = make(chan struct{})
	go s.serve(conn, s.done)
	return nil
}

// Addr returns the server's bound address, or nil before Start.
func (s *Server) Addr() net.Addr {
	s.runMu.Lock()
	defer s.runMu.Unlock()
	if s.conn == nil {
		return nil
	}
	return s.conn.LocalAddr()
}

// Close stops the server and closes its UDP socket.
func (s *Server) Close() error {
	s.runMu.Lock()
	conn := s.conn
	done := s.done
	s.conn = nil
	s.done = nil
	s.runMu.Unlock()

	if conn == nil {
		return nil
	}
	err := conn.Close()
	if done != nil {
		<-done
	}
	if errors.Is(err, net.ErrClosed) {
		return nil
	}
	return err
}

func (s *Server) serve(conn *net.UDPConn, done chan<- struct{}) {
	defer close(done)

	buf := make([]byte, maxPacket)
	for {
		n, addr, err := conn.ReadFromUDP(buf)
		if err != nil {
			return
		}
		resp := s.handlePacket(buf[:n], addr)
		if len(resp) == 0 {
			continue
		}
		_, _ = conn.WriteToUDP(resp, addr)
	}
}

func (s *Server) handlePacket(pkt []byte, client *net.UDPAddr) []byte {
	q, err := parseQuery(pkt)
	if err != nil {
		if len(pkt) >= dnsHeaderLen {
			return formErr(pkt)
		}
		return nil
	}
	if q.flags&0x8000 != 0 || q.flags&0x7800 != 0 {
		return nil
	}

	if q.qclass != classIN || !s.owns(q.name) {
		return empty(q, rcodeNoError)
	}
	if q.qtype == typeAAAA {
		return empty(q, rcodeNoError)
	}
	if q.qtype != typeA {
		return empty(q, rcodeNoError)
	}

	ip := s.currentTarget()
	if ip == nil {
		return empty(q, rcodeNoError)
	}
	if s.logf != nil {
		clientIP := ""
		if client != nil {
			clientIP = client.IP.String()
		}
		s.logf("dns: %s asked %s -> %s", clientIP, q.name, ip.String())
	}
	return answerA(q, ip, s.ttl)
}

func (s *Server) owns(name string) bool {
	name = normalizeHost(name)
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.all {
		return true
	}
	_, ok := s.hosts[name]
	return ok
}

func (s *Server) currentTarget() net.IP {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.target == nil {
		return nil
	}
	return append(net.IP(nil), s.target...)
}

type query struct {
	id       uint16
	flags    uint16
	name     string
	qtype    uint16
	qclass   uint16
	question []byte
}

func parseQuery(pkt []byte) (query, error) {
	if len(pkt) < dnsHeaderLen || len(pkt) > maxPacket {
		return query{}, errors.New("bad query length")
	}
	if binary.BigEndian.Uint16(pkt[4:6]) != 1 {
		return query{}, errors.New("bad question count")
	}

	off := dnsHeaderLen
	name, err := readName(pkt, &off, 0)
	if err != nil {
		return query{}, err
	}
	if off+4 > len(pkt) {
		return query{}, errors.New("short question")
	}

	return query{
		id:       binary.BigEndian.Uint16(pkt[0:2]),
		flags:    binary.BigEndian.Uint16(pkt[2:4]),
		name:     name,
		qtype:    binary.BigEndian.Uint16(pkt[off : off+2]),
		qclass:   binary.BigEndian.Uint16(pkt[off+2 : off+4]),
		question: append([]byte(nil), pkt[dnsHeaderLen:off+4]...),
	}, nil
}

func readName(pkt []byte, off *int, depth int) (string, error) {
	if depth > 8 {
		return "", errors.New("compression loop")
	}

	var labels []string
	for {
		if *off >= len(pkt) {
			return "", errors.New("name overflow")
		}

		l := int(pkt[*off])
		*off = *off + 1
		switch {
		case l == 0:
			return strings.Join(labels, "."), nil
		case l&0xc0 == 0xc0:
			if *off >= len(pkt) {
				return "", errors.New("short compression pointer")
			}
			ptr := ((l & 0x3f) << 8) | int(pkt[*off])
			*off = *off + 1
			if ptr >= len(pkt) {
				return "", errors.New("bad compression pointer")
			}
			next := ptr
			tail, err := readName(pkt, &next, depth+1)
			if err != nil {
				return "", err
			}
			if tail != "" {
				labels = append(labels, tail)
			}
			return strings.Join(labels, "."), nil
		case l&0xc0 != 0 || l > 63:
			return "", errors.New("bad label")
		case *off+l > len(pkt):
			return "", errors.New("short label")
		default:
			labels = append(labels, string(pkt[*off:*off+l]))
			*off += l
		}
	}
}

func answerA(q query, ip net.IP, ttl uint32) []byte {
	resp := header(q, 1, rcodeNoError)
	resp = append(resp, q.question...)
	resp = append(resp, 0xc0, 0x0c)
	resp = appendU16(resp, typeA)
	resp = appendU16(resp, classIN)
	resp = appendU32(resp, ttl)
	resp = appendU16(resp, 4)
	resp = append(resp, ip.To4()...)
	if len(resp) > maxPacket {
		return nil
	}
	return resp
}

func empty(q query, rcode uint16) []byte {
	resp := header(q, 0, rcode)
	resp = append(resp, q.question...)
	if len(resp) > maxPacket {
		return nil
	}
	return resp
}

func formErr(pkt []byte) []byte {
	resp := make([]byte, dnsHeaderLen)
	copy(resp[0:2], pkt[0:2])
	binary.BigEndian.PutUint16(resp[2:4], 0x8000|rcodeFormErr)
	return resp
}

func header(q query, answers uint16, rcode uint16) []byte {
	resp := make([]byte, dnsHeaderLen)
	binary.BigEndian.PutUint16(resp[0:2], q.id)
	binary.BigEndian.PutUint16(resp[2:4], 0x8000|(q.flags&0x0100)|(rcode&0x000f))
	binary.BigEndian.PutUint16(resp[4:6], 1)
	binary.BigEndian.PutUint16(resp[6:8], answers)
	return resp
}

func appendU16(b []byte, v uint16) []byte {
	var tmp [2]byte
	binary.BigEndian.PutUint16(tmp[:], v)
	return append(b, tmp[:]...)
}

func appendU32(b []byte, v uint32) []byte {
	var tmp [4]byte
	binary.BigEndian.PutUint32(tmp[:], v)
	return append(b, tmp[:]...)
}

func normalizeHost(host string) string {
	host = strings.TrimSpace(strings.ToLower(host))
	for strings.HasSuffix(host, ".") {
		host = strings.TrimSuffix(host, ".")
	}
	return host
}
