package server

import (
	"context"
	"net"
	"os/exec"
	"strings"
	"time"

	"partyparty/internal/activate"
	"partyparty/internal/netinfo"
)

const (
	networkSituationSharedWifiReady = "shared_wifi_ready"
	networkSituationEthernetCanHost = "ethernet_can_host"
	networkSituationWifiNoInternet  = "wifi_no_internet"
	networkSituationNoNetwork       = "no_network"
	networkSituationHotspotActive   = "hotspot_active"
)

type networkSituation struct {
	Situation   string `json:"situation"`
	OnWifi      bool   `json:"onWifi"`
	OnEthernet  bool   `json:"onEthernet"`
	HasInternet bool   `json:"hasInternet"`
	Resolves    bool   `json:"resolves"`
	Hotspotting bool   `json:"hotspotting"`
	LanIP       string `json:"lanIP"`
	PrimaryURL  string `json:"primaryUrl"`
	// The permanent guest-facing link (<handle>.partyparty.party) when it can
	// work — same rules as urls().Public. The console prefers it for the QR.
	PublicURL  string `json:"publicUrl,omitempty"`
	GuestCount int    `json:"guestCount"`
}

func (s *srv) networkSituation() networkSituation {
	lanIP := netinfo.PrimaryLanIP()
	if lanIP == "127.0.0.1" {
		lanIP = ""
	}

	ctx, cancel := context.WithTimeout(context.Background(), 1100*time.Millisecond)
	defer cancel()

	onWifi, onEthernet := detectDefaultNetwork(ctx)
	hasInternet := internetReachable(ctx)
	hotspotting := bridge100Up()
	resolves := false
	if host := s.guestDNSHost(); host != "" && lanIP != "" {
		resCtx, resCancel := context.WithTimeout(context.Background(), 1100*time.Millisecond)
		resolves = activate.VerifyResolves(resCtx, host, lanIP) == nil
		resCancel()
	}

	primaryURL := ""
	publicURL := ""
	if lanIP != "" {
		u := s.urls()
		primaryURL = u.Primary
		publicURL = u.Public
	}
	guestCount := 0
	if s.Listeners != nil {
		guestCount = s.Listeners.Active()
	}

	ns := networkSituation{
		OnWifi:      onWifi,
		OnEthernet:  onEthernet,
		HasInternet: hasInternet,
		Resolves:    resolves,
		Hotspotting: hotspotting,
		LanIP:       lanIP,
		PrimaryURL:  primaryURL,
		PublicURL:   publicURL,
		GuestCount:  guestCount,
	}
	ns.Situation = deriveNetworkSituation(ns)
	return ns
}

func deriveNetworkSituation(ns networkSituation) string {
	switch {
	case ns.LanIP == "":
		return networkSituationNoNetwork
	case ns.Hotspotting:
		return networkSituationHotspotActive
	case ns.OnWifi && ns.HasInternet && ns.Resolves:
		return networkSituationSharedWifiReady
	case ns.OnEthernet && ns.HasInternet:
		return networkSituationEthernetCanHost
	case ns.OnWifi && !ns.HasInternet:
		return networkSituationWifiNoInternet
	case ns.OnWifi && ns.Resolves:
		return networkSituationSharedWifiReady
	default:
		return networkSituationNoNetwork
	}
}

func (s *srv) guestDNSHost() string {
	if h := strings.TrimSpace(s.Config.LiveHost); h != "" {
		return h
	}
	if h := strings.TrimSpace(s.Config.Domain); h != "" {
		return h
	}
	s.actMu.Lock()
	actDomain := strings.TrimSpace(s.actDomain)
	lastHost := strings.TrimSpace(s.actLast.Host)
	s.actMu.Unlock()
	if actDomain != "" {
		return actDomain
	}
	if lastHost != "" {
		return lastHost
	}
	return activate.BrokerHost()
}

func detectDefaultNetwork(ctx context.Context) (bool, bool) {
	iface := defaultRouteInterface(ctx)
	if iface == "" {
		return false, false
	}
	ports := hardwarePorts(ctx)
	port := ports[iface]
	onWifi := isWifiPort(port)
	onEthernet := isUsableSharingUpstream(iface, port, onWifi)
	return onWifi, onEthernet
}

func defaultRouteInterface(ctx context.Context) string {
	out, err := exec.CommandContext(ctx, "route", "-n", "get", "default").Output()
	if err != nil {
		return ""
	}
	for _, line := range strings.Split(string(out), "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "interface:") {
			return strings.TrimSpace(strings.TrimPrefix(line, "interface:"))
		}
	}
	return ""
}

func hardwarePorts(ctx context.Context) map[string]string {
	out, err := exec.CommandContext(ctx, "networksetup", "-listallhardwareports").Output()
	if err != nil {
		return nil
	}
	return parseHardwarePorts(string(out))
}

func parseHardwarePorts(out string) map[string]string {
	ports := make(map[string]string)
	port := ""
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		switch {
		case strings.HasPrefix(line, "Hardware Port:"):
			port = strings.TrimSpace(strings.TrimPrefix(line, "Hardware Port:"))
		case strings.HasPrefix(line, "Device:") && port != "":
			device := strings.TrimSpace(strings.TrimPrefix(line, "Device:"))
			if device != "" {
				ports[device] = port
			}
		case line == "":
			port = ""
		}
	}
	return ports
}

func isWifiPort(port string) bool {
	p := strings.ToLower(port)
	return strings.Contains(p, "wi-fi") || strings.Contains(p, "wifi") || strings.Contains(p, "airport")
}

func isUsableSharingUpstream(iface, port string, onWifi bool) bool {
	if iface == "" || onWifi {
		return false
	}
	name := strings.ToLower(iface)
	for _, prefix := range []string{"lo", "bridge", "awdl", "llw", "utun", "tun", "tap", "ppp", "ipsec", "wg", "gif", "stf"} {
		if strings.HasPrefix(name, prefix) {
			return false
		}
	}
	p := strings.ToLower(port)
	return !strings.Contains(p, "thunderbolt bridge")
}

func internetReachable(ctx context.Context) bool {
	var d net.Dialer
	conn, err := d.DialContext(ctx, "tcp", "1.1.1.1:443")
	if err != nil {
		return false
	}
	_ = conn.Close()
	return true
}

func bridge100Up() bool {
	ifc, err := net.InterfaceByName("bridge100")
	if err != nil {
		return false
	}
	return ifc.Flags&net.FlagUp != 0
}
