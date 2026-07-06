// Command pp-port80 is a minimal privileged LaunchDaemon (installed via
// SMAppService, runs as root) whose job is to install captive-network pf
// redirects via a scoped anchor and, while captive mode is active, bring up the
// Mac's own Internet Sharing hotspot.
//
// Security posture: it takes NO input (the rule is compiled in — no args, no
// IPC, no injection surface) and is NOT network-facing (it runs pfctl and idles).
// The LAN-facing web/DNS servers stay unprivileged; only the in-kernel redirects
// are privileged. On stop (SIGTERM from launchd unregister) it flushes only its
// own anchor and releases only its own pf enable-reference.
package main

import (
	"bytes"
	"errors"
	"fmt"
	"log"
	"net"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
	"time"
)

// Scoped sub-anchor under the "com.apple/*" wildcard that /etc/pf.conf already
// evaluates — so the rule takes effect without ever editing the system ruleset.
const anchor = "com.apple/net.ramine.partyparty"

const pfctl = "/sbin/pfctl"

const (
	networksetup = "/usr/sbin/networksetup"
	plistBuddy   = "/usr/libexec/PlistBuddy"
	plutil       = "/usr/bin/plutil"
	launchctl    = "/bin/launchctl"
	natPlist     = "/Library/Preferences/SystemConfiguration/com.apple.nat.plist"
	adhocService = "partyparty-adhoc"
)

type sharingState struct {
	natWasEnabled       bool
	natPlistExisted     bool
	natPlistSnapshot    []byte
	adhocServiceExisted bool
	adhocServiceCreated bool
	configured          bool
}

func main() {
	log.SetPrefix("pp-port80: ")
	sharing := enableSharing()
	token := loadRule()

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGTERM, syscall.SIGINT)
	<-sig
	disableSharing(sharing)
	teardown(token)
}

// loadRule installs the rdr rule into our anchor and reference-count-enables pf,
// returning the enable token to release later. Never uses bare -e / -f pf.conf
// (which would clobber Internet Sharing / VPNs / other pf users).
func loadRule() string {
	iface, _ := bridgeIP()
	if iface == "" {
		iface = "bridge100"
		log.Printf("pf: no active bridge detected; falling back to %s", iface)
	} else {
		log.Printf("pf: redirecting captive traffic on %s", iface)
	}
	c := loggedCommand(pfctl, "-a", anchor, "-f", "-")
	c.Stdin = strings.NewReader(pfRule(iface))
	out, err := c.CombinedOutput()
	logResult(pfctl, out, err)
	if err != nil {
		log.Printf("load anchor failed: %v: %s", err, out)
	}
	out, err = run(pfctl, "-E")
	if err != nil {
		log.Printf("pf enable failed: %v: %s", err, out)
	}
	if m := regexp.MustCompile(`Token\s*:\s*(\d+)`).FindStringSubmatch(string(out)); len(m) == 2 {
		return m[1]
	}
	return ""
}

func pfRule(iface string) string {
	return fmt.Sprintf(
		"rdr pass on %s inet proto tcp from any to any port 80 -> 127.0.0.1 port 8000\n"+
			"rdr pass on %s inet proto udp from any to any port 53 -> 127.0.0.1 port 5354\n",
		iface, iface,
	)
}

func teardown(token string) {
	if out, err := run(pfctl, "-a", anchor, "-F", "all"); err != nil {
		log.Printf("flush anchor failed: %v: %s", err, out)
	}
	if token != "" {
		if out, err := run(pfctl, "-X", token); err != nil {
			log.Printf("pf disable-ref failed: %v: %s", err, out)
		}
	}
}

func enableSharing() *sharingState {
	st := &sharingState{}
	if os.Geteuid() != 0 {
		log.Printf("hotspot: not root; skipping Internet Sharing enable")
		return st
	}

	st.natPlistExisted = fileExists(natPlist)
	if st.natPlistExisted {
		b, err := os.ReadFile(natPlist)
		if err != nil {
			log.Printf("hotspot: cannot snapshot %s: %v; skipping Internet Sharing enable", natPlist, err)
			return st
		}
		st.natPlistSnapshot = append([]byte(nil), b...)
	}

	var err error
	st.natWasEnabled, err = natEnabled()
	if err != nil {
		log.Printf("hotspot: cannot read NAT state: %v; skipping Internet Sharing enable", err)
		return st
	}
	if st.natWasEnabled {
		log.Printf("hotspot: Internet Sharing/NAT already enabled; leaving user's sharing configuration untouched")
		return st
	}

	services, err := networkServices()
	if err != nil {
		log.Printf("hotspot: cannot list network services: %v; skipping Internet Sharing enable", err)
		return st
	}
	st.adhocServiceExisted = serviceExists(services, adhocService)
	if !st.adhocServiceExisted {
		if _, err := run(networksetup, "-createnetworkservice", adhocService, "lo0"); err != nil {
			log.Printf("hotspot: create %q service failed: %v", adhocService, err)
			return st
		}
		st.adhocServiceCreated = true
		if _, err := run(networksetup, "-setmanual", adhocService, "10.10.10.1", "255.255.255.255"); err != nil {
			log.Printf("hotspot: configure %q service failed: %v", adhocService, err)
			rollbackSharing(st)
			return st
		}
	} else {
		log.Printf("hotspot: network service %q already exists; not modifying it", adhocService)
	}

	wifi, err := wifiDevice()
	if err != nil {
		log.Printf("hotspot: cannot identify Wi-Fi device: %v", err)
		rollbackSharing(st)
		return st
	}
	log.Printf("hotspot: using Wi-Fi device %s as NAT SharingDevices target", wifi)

	if err := ensureNatPlist(); err != nil {
		log.Printf("hotspot: cannot prepare NAT plist: %v", err)
		rollbackSharing(st)
		return st
	}
	if err := configureNat(wifi); err != nil {
		log.Printf("hotspot: configure NAT plist failed: %v", err)
		rollbackSharing(st)
		return st
	}
	if _, err := run(launchctl, "kickstart", "-k", "system/com.apple.InternetSharing"); err != nil {
		log.Printf("hotspot: InternetSharing kickstart failed: %v; trying launchctl load fallback", err)
		if _, err := run(launchctl, "load", "-w", "/System/Library/LaunchDaemons/com.apple.InternetSharing.plist"); err != nil {
			log.Printf("hotspot: InternetSharing load fallback failed: %v", err)
			rollbackSharing(st)
			return st
		}
	}

	st.configured = true
	logBridgeResult(8 * time.Second)
	return st
}

func disableSharing(st *sharingState) {
	if st == nil || st.natWasEnabled {
		if st != nil && st.natWasEnabled {
			log.Printf("hotspot: prior Internet Sharing/NAT was enabled; no partyparty sharing state to restore")
		}
		return
	}
	if !st.configured && !st.adhocServiceCreated {
		return
	}

	if _, err := run(plistBuddy, "-c", "Set :NAT:Enabled 0", natPlist); err != nil {
		log.Printf("hotspot: disabling NAT flag failed: %v", err)
	}
	if _, err := run(launchctl, "kill", "TERM", "system/com.apple.InternetSharing"); err != nil {
		log.Printf("hotspot: launchctl kill InternetSharing failed: %v; trying stop", err)
		if _, err := run(launchctl, "stop", "system/com.apple.InternetSharing"); err != nil {
			log.Printf("hotspot: launchctl stop InternetSharing failed: %v", err)
		}
	}
	restoreNatPlist(st)
	if st.adhocServiceCreated {
		if _, err := run(networksetup, "-removenetworkservice", adhocService); err != nil {
			log.Printf("hotspot: remove %q service failed: %v", adhocService, err)
		}
	}
}

func rollbackSharing(st *sharingState) {
	log.Printf("hotspot: rolling back partial Internet Sharing changes")
	if _, err := run(plistBuddy, "-c", "Set :NAT:Enabled 0", natPlist); err != nil {
		log.Printf("hotspot: rollback NAT disable failed: %v", err)
	}
	if _, err := run(launchctl, "kill", "TERM", "system/com.apple.InternetSharing"); err != nil {
		log.Printf("hotspot: rollback InternetSharing kill failed: %v", err)
	}
	restoreNatPlist(st)
	if st.adhocServiceCreated {
		if _, err := run(networksetup, "-removenetworkservice", adhocService); err != nil {
			log.Printf("hotspot: rollback remove %q service failed: %v", adhocService, err)
		}
		st.adhocServiceCreated = false
	}
}

func restoreNatPlist(st *sharingState) {
	if st.natPlistExisted {
		if err := os.WriteFile(natPlist, st.natPlistSnapshot, 0o644); err != nil {
			log.Printf("hotspot: restore NAT plist snapshot failed: %v", err)
		} else {
			log.Printf("hotspot: restored NAT plist snapshot")
		}
		return
	}
	if err := os.Remove(natPlist); err != nil && !errors.Is(err, os.ErrNotExist) {
		log.Printf("hotspot: remove generated NAT plist failed: %v", err)
	} else {
		log.Printf("hotspot: removed generated NAT plist")
	}
}

func natEnabled() (bool, error) {
	if !fileExists(natPlist) {
		return false, nil
	}
	out, err := run(plistBuddy, "-c", "Print :NAT:Enabled", natPlist)
	if err != nil {
		if strings.Contains(string(out), "Does Not Exist") || strings.Contains(string(out), "Entry, \":NAT") {
			return false, nil
		}
		return false, fmt.Errorf("%w: %s", err, strings.TrimSpace(string(out)))
	}
	v := strings.TrimSpace(string(out))
	return v == "1" || strings.EqualFold(v, "true") || strings.EqualFold(v, "yes"), nil
}

func networkServices() ([]string, error) {
	out, err := run(networksetup, "-listallnetworkservices")
	if err != nil {
		return nil, fmt.Errorf("%w: %s", err, strings.TrimSpace(string(out)))
	}
	return parseNetworkServices(string(out)), nil
}

func parseNetworkServices(out string) []string {
	var services []string
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "An asterisk") {
			continue
		}
		services = append(services, strings.TrimPrefix(line, "*"))
	}
	return services
}

func serviceExists(services []string, name string) bool {
	for _, svc := range services {
		if svc == name {
			return true
		}
	}
	return false
}

func wifiDevice() (string, error) {
	out, err := run(networksetup, "-listallhardwareports")
	if err != nil {
		return "", fmt.Errorf("%w: %s", err, strings.TrimSpace(string(out)))
	}
	return parseWifiDevice(string(out))
}

func parseWifiDevice(out string) (string, error) {
	var isWifiBlock bool
	for _, raw := range strings.Split(out, "\n") {
		line := strings.TrimSpace(raw)
		if strings.HasPrefix(line, "Hardware Port:") {
			port := strings.TrimSpace(strings.TrimPrefix(line, "Hardware Port:"))
			isWifiBlock = port == "Wi-Fi" || port == "AirPort"
			continue
		}
		if isWifiBlock && strings.HasPrefix(line, "Device:") {
			dev := strings.TrimSpace(strings.TrimPrefix(line, "Device:"))
			if dev != "" {
				return dev, nil
			}
		}
	}
	return "", errors.New("Wi-Fi hardware port not found")
}

func ensureNatPlist() error {
	if err := os.MkdirAll(filepath.Dir(natPlist), 0o755); err != nil {
		return err
	}
	if !fileExists(natPlist) {
		if _, err := run(plutil, "-create", "xml1", natPlist); err != nil {
			return err
		}
	}
	if err := ensurePlistDict(":NAT"); err != nil {
		return err
	}
	if err := ensurePlistDict(":NAT:PrimaryInterface"); err != nil {
		return err
	}
	if err := ensurePlistDict(":NAT:AirPort"); err != nil {
		return err
	}
	return nil
}

func configureNat(wifi string) error {
	steps := [][]string{
		{"Set :NAT:PrimaryInterface:Device lo0", "Add :NAT:PrimaryInterface:Device string lo0"},
		{"Set :NAT:PrimaryInterface:Enabled 1", "Add :NAT:PrimaryInterface:Enabled integer 1"},
		{"Set :NAT:AirPort:Enabled 1", "Add :NAT:AirPort:Enabled integer 1"},
	}
	for _, step := range steps {
		if err := setOrAdd(step[0], step[1]); err != nil {
			return err
		}
	}
	if err := replaceSharingDevices(wifi); err != nil {
		return err
	}
	return setOrAdd("Set :NAT:Enabled 1", "Add :NAT:Enabled integer 1")
}

func ensurePlistDict(path string) error {
	if _, err := run(plistBuddy, "-c", "Print "+path, natPlist); err == nil {
		return nil
	}
	_, err := run(plistBuddy, "-c", "Add "+path+" dict", natPlist)
	return err
}

func setOrAdd(setCmd, addCmd string) error {
	if _, err := run(plistBuddy, "-c", setCmd, natPlist); err == nil {
		return nil
	}
	_, err := run(plistBuddy, "-c", addCmd, natPlist)
	return err
}

func replaceSharingDevices(wifi string) error {
	if _, err := run(plistBuddy, "-c", "Delete :NAT:SharingDevices", natPlist); err != nil {
		log.Printf("hotspot: NAT SharingDevices did not exist or could not be cleared before setting Wi-Fi target: %v", err)
	}
	if _, err := run(plistBuddy, "-c", "Add :NAT:SharingDevices array", natPlist); err != nil {
		return err
	}
	_, err := run(plistBuddy, "-c", "Add :NAT:SharingDevices:0 string "+wifi, natPlist)
	return err
}

func logBridgeResult(timeout time.Duration) {
	deadline := time.Now().Add(timeout)
	for {
		if name, ip := bridgeIP(); ip != "" {
			log.Printf("hotspot: Internet Sharing bridge up: %s %s", name, ip)
			return
		}
		if time.Now().After(deadline) {
			log.Printf("hotspot: no bridge interface with IPv4 after %s", timeout)
			return
		}
		time.Sleep(500 * time.Millisecond)
	}
}

func bridgeIP() (string, string) {
	ifaces, err := net.Interfaces()
	if err != nil {
		log.Printf("hotspot: cannot list interfaces for bridge verification: %v", err)
		return "", ""
	}
	for _, ifc := range ifaces {
		if !strings.HasPrefix(ifc.Name, "bridge") || ifc.Flags&net.FlagUp == 0 {
			continue
		}
		addrs, _ := ifc.Addrs()
		for _, a := range addrs {
			ip := addrIP(a)
			if ip4 := ip.To4(); ip4 != nil && !ip4.IsLoopback() && !ip4.IsLinkLocalUnicast() {
				return ifc.Name, ip4.String()
			}
		}
	}
	return "", ""
}

func addrIP(a net.Addr) net.IP {
	switch v := a.(type) {
	case *net.IPNet:
		return v.IP
	case *net.IPAddr:
		return v.IP
	default:
		return nil
	}
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func loggedCommand(name string, args ...string) *exec.Cmd {
	log.Printf("run: %s", commandString(name, args...))
	return exec.Command(name, args...)
}

func run(name string, args ...string) ([]byte, error) {
	c := loggedCommand(name, args...)
	out, err := c.CombinedOutput()
	logResult(name, out, err)
	return out, err
}

func logResult(name string, out []byte, err error) {
	trimmed := strings.TrimSpace(string(out))
	if trimmed == "" {
		log.Printf("result: %s: err=%v", filepath.Base(name), err)
	} else {
		log.Printf("result: %s: err=%v output=%q", filepath.Base(name), err, trimmed)
	}
}

func commandString(name string, args ...string) string {
	var b bytes.Buffer
	b.WriteString(shellQuote(name))
	for _, a := range args {
		b.WriteByte(' ')
		b.WriteString(shellQuote(a))
	}
	return b.String()
}

func shellQuote(s string) string {
	if s == "" {
		return "''"
	}
	if strings.IndexFunc(s, func(r rune) bool {
		return !(r == '/' || r == '.' || r == '-' || r == '_' || r == ':' || r == '=' ||
			r >= '0' && r <= '9' || r >= 'A' && r <= 'Z' || r >= 'a' && r <= 'z')
	}) == -1 {
		return s
	}
	return "'" + strings.ReplaceAll(s, "'", "'\\''") + "'"
}
