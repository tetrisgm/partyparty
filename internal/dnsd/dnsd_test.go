package dnsd

import (
	"encoding/binary"
	"fmt"
	"net"
	"strings"
	"sync"
	"testing"
	"time"
)

type dnsResponse struct {
	rcode   uint16
	qd      uint16
	answers []dnsAnswer
}

type dnsAnswer struct {
	typ uint16
	ttl uint32
	ip  net.IP
}

func TestOwnedAQueryReturnsTarget(t *testing.T) {
	s := newTestServer(t, []string{"DJ.Ramine.Net"}, "192.168.2.44")

	resp := exchange(t, s, queryPacket(0x1001, "dj.ramine.net.", typeA))
	got := parseResponse(t, resp)
	if got.rcode != rcodeNoError {
		t.Fatalf("rcode = %d, want NOERROR", got.rcode)
	}
	if got.qd != 1 {
		t.Fatalf("qdcount = %d, want 1", got.qd)
	}
	if len(got.answers) != 1 {
		t.Fatalf("answers = %d, want 1", len(got.answers))
	}
	ans := got.answers[0]
	if ans.typ != typeA {
		t.Fatalf("answer type = %d, want A", ans.typ)
	}
	if ans.ttl != 5 {
		t.Fatalf("ttl = %d, want 5", ans.ttl)
	}
	if ans.ip.String() != "192.168.2.44" {
		t.Fatalf("ip = %s, want 192.168.2.44", ans.ip)
	}
}

func TestNonOwnedHostReturnsNoAnswers(t *testing.T) {
	s := newTestServer(t, []string{"dj.ramine.net"}, "192.168.2.44")

	resp := exchange(t, s, queryPacket(0x1002, "other.ramine.net", typeA))
	got := parseResponse(t, resp)
	if got.rcode != rcodeNoError {
		t.Fatalf("rcode = %d, want NOERROR", got.rcode)
	}
	if len(got.answers) != 0 {
		t.Fatalf("answers = %d, want 0", len(got.answers))
	}
}

func TestCatchAllAQueryReturnsTarget(t *testing.T) {
	s := newTestServerWithConfig(t, Config{
		Addr:     "127.0.0.1:0",
		Hosts:    []string{"dj.ramine.net"},
		TargetIP: "192.168.2.44",
		CatchAll: true,
	})

	resp := exchange(t, s, queryPacket(0x1006, "captive.apple.com", typeA))
	got := parseResponse(t, resp)
	if len(got.answers) != 1 {
		t.Fatalf("answers = %d, want 1", len(got.answers))
	}
	if got.answers[0].ip.String() != "192.168.2.44" {
		t.Fatalf("ip = %s, want 192.168.2.44", got.answers[0].ip)
	}
}

func TestOwnedAAAAQueryReturnsNoAnswers(t *testing.T) {
	s := newTestServer(t, []string{"dj.ramine.net"}, "192.168.2.44")

	resp := exchange(t, s, queryPacket(0x1003, "dj.ramine.net", typeAAAA))
	got := parseResponse(t, resp)
	if got.rcode != rcodeNoError {
		t.Fatalf("rcode = %d, want NOERROR", got.rcode)
	}
	if len(got.answers) != 0 {
		t.Fatalf("answers = %d, want 0", len(got.answers))
	}
}

func TestSetTargetChangesNextAnswer(t *testing.T) {
	s := newTestServer(t, []string{"dj.ramine.net"}, "192.168.2.44")
	s.SetTarget("192.168.2.45")

	resp := exchange(t, s, queryPacket(0x1004, "DJ.RAMINE.NET.", typeA))
	got := parseResponse(t, resp)
	if len(got.answers) != 1 {
		t.Fatalf("answers = %d, want 1", len(got.answers))
	}
	if got.answers[0].ip.String() != "192.168.2.45" {
		t.Fatalf("ip = %s, want 192.168.2.45", got.answers[0].ip)
	}
}

func TestOwnedAQueryLogsClientQuestionAndAnswer(t *testing.T) {
	var (
		mu   sync.Mutex
		logs []string
	)
	s := newTestServerWithConfig(t, Config{
		Addr:     "127.0.0.1:0",
		Hosts:    []string{"dj.ramine.net"},
		TargetIP: "192.168.2.44",
		Logf: func(format string, args ...any) {
			mu.Lock()
			defer mu.Unlock()
			logs = append(logs, fmt.Sprintf(format, args...))
		},
	})

	resp := exchange(t, s, queryPacket(0x1005, "dj.ramine.net", typeA))
	got := parseResponse(t, resp)
	if len(got.answers) != 1 {
		t.Fatalf("answers = %d, want 1", len(got.answers))
	}

	mu.Lock()
	defer mu.Unlock()
	if len(logs) != 1 {
		t.Fatalf("logs = %d, want 1: %#v", len(logs), logs)
	}
	if want := "dns: 127.0.0.1 asked dj.ramine.net -> 192.168.2.44"; logs[0] != want {
		t.Fatalf("log = %q, want %q", logs[0], want)
	}
}

func TestGarbagePacketDoesNotCrashServer(t *testing.T) {
	s := newTestServer(t, []string{"dj.ramine.net"}, "192.168.2.44")

	conn, err := net.Dial("udp", s.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if _, err := conn.Write([]byte{0x01, 0x02, 0x03}); err != nil {
		t.Fatal(err)
	}

	resp := exchange(t, s, queryPacket(0x1005, "dj.ramine.net", typeA))
	got := parseResponse(t, resp)
	if len(got.answers) != 1 {
		t.Fatalf("answers after garbage = %d, want 1", len(got.answers))
	}
}

func newTestServer(t *testing.T, hosts []string, target string) *Server {
	t.Helper()

	return newTestServerWithConfig(t, Config{Addr: "127.0.0.1:0", Hosts: hosts, TargetIP: target})
}

func newTestServerWithConfig(t *testing.T, cfg Config) *Server {
	t.Helper()

	s := New(cfg)
	if err := s.Start(); err != nil {
		if strings.Contains(err.Error(), "operation not permitted") {
			t.Skipf("local UDP bind is not permitted in this environment: %v", err)
		}
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := s.Close(); err != nil {
			t.Fatal(err)
		}
	})
	if s.Addr() == nil {
		t.Fatal("server has nil address after Start")
	}
	return s
}

func exchange(t *testing.T, s *Server, pkt []byte) []byte {
	t.Helper()

	conn, err := net.Dial("udp", s.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if err := conn.SetDeadline(time.Now().Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Write(pkt); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, maxPacket)
	n, err := conn.Read(buf)
	if err != nil {
		t.Fatal(err)
	}
	return append([]byte(nil), buf[:n]...)
}

func queryPacket(id uint16, name string, typ uint16) []byte {
	var pkt []byte
	pkt = binary.BigEndian.AppendUint16(pkt, id)
	pkt = binary.BigEndian.AppendUint16(pkt, 0x0100)
	pkt = binary.BigEndian.AppendUint16(pkt, 1)
	pkt = binary.BigEndian.AppendUint16(pkt, 0)
	pkt = binary.BigEndian.AppendUint16(pkt, 0)
	pkt = binary.BigEndian.AppendUint16(pkt, 0)
	for _, label := range strings.Split(strings.TrimSuffix(name, "."), ".") {
		pkt = append(pkt, byte(len(label)))
		pkt = append(pkt, label...)
	}
	pkt = append(pkt, 0)
	pkt = binary.BigEndian.AppendUint16(pkt, typ)
	pkt = binary.BigEndian.AppendUint16(pkt, classIN)
	return pkt
}

func parseResponse(t *testing.T, pkt []byte) dnsResponse {
	t.Helper()
	if len(pkt) < dnsHeaderLen {
		t.Fatalf("short response: %d", len(pkt))
	}
	flags := binary.BigEndian.Uint16(pkt[2:4])
	if flags&0x8000 == 0 {
		t.Fatal("response QR bit is not set")
	}
	if flags&0x0080 != 0 {
		t.Fatal("response RA bit is set")
	}
	qd := binary.BigEndian.Uint16(pkt[4:6])
	an := binary.BigEndian.Uint16(pkt[6:8])
	off := dnsHeaderLen
	for i := 0; i < int(qd); i++ {
		if _, err := readName(pkt, &off, 0); err != nil {
			t.Fatal(err)
		}
		if off+4 > len(pkt) {
			t.Fatal("short response question")
		}
		off += 4
	}

	got := dnsResponse{rcode: flags & 0x000f, qd: qd}
	for i := 0; i < int(an); i++ {
		if _, err := readName(pkt, &off, 0); err != nil {
			t.Fatal(err)
		}
		if off+10 > len(pkt) {
			t.Fatal("short answer header")
		}
		typ := binary.BigEndian.Uint16(pkt[off : off+2])
		ttl := binary.BigEndian.Uint32(pkt[off+4 : off+8])
		rdlen := int(binary.BigEndian.Uint16(pkt[off+8 : off+10]))
		rdata := off + 10
		if rdata+rdlen > len(pkt) {
			t.Fatal("short answer rdata")
		}
		ans := dnsAnswer{typ: typ, ttl: ttl}
		if typ == typeA && rdlen == 4 {
			ans.ip = net.IP(pkt[rdata : rdata+rdlen]).To4()
		}
		got.answers = append(got.answers, ans)
		off = rdata + rdlen
	}
	return got
}
