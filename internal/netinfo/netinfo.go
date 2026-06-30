package netinfo

import (
	"net"
	"os"
	"sort"
	"strings"
)

type Iface struct {
	Iface   string `json:"iface"`
	Address string `json:"address"`
}

// VPN/tunnel interfaces a guest can never reach — exclude them from join URLs.
func isTunnel(name string) bool {
	for _, p := range []string{"utun", "tun", "tap", "ppp", "ipsec", "wg", "gif", "stf"} {
		if strings.HasPrefix(name, p) {
			return true
		}
	}
	return false
}

// LanInterfaces returns reachable, non-loopback, non-tunnel IPv4 addresses.
func LanInterfaces() []Iface {
	var out []Iface
	ifaces, err := net.Interfaces()
	if err != nil {
		return out
	}
	for _, ifc := range ifaces {
		if ifc.Flags&net.FlagUp == 0 || ifc.Flags&net.FlagLoopback != 0 {
			continue
		}
		if isTunnel(ifc.Name) {
			continue // skip VPN tunnels (e.g. WireGuard's utun) — guests can't reach them
		}
		addrs, _ := ifc.Addrs()
		for _, a := range addrs {
			var ip net.IP
			switch v := a.(type) {
			case *net.IPNet:
				ip = v.IP
			case *net.IPAddr:
				ip = v.IP
			}
			if ip == nil || ip.IsLoopback() || ip.IsLinkLocalUnicast() {
				continue // skip 169.254.x.x link-local too
			}
			if ip4 := ip.To4(); ip4 != nil {
				out = append(out, Iface{Iface: ifc.Name, Address: ip4.String()})
			}
		}
	}
	return out
}

// score: lower means more likely to be the AP/hotspot subnet guests join.
func score(ip string) int {
	switch {
	case strings.HasPrefix(ip, "192.168.2."):
		return 0 // macOS Internet Sharing default subnet
	case strings.HasPrefix(ip, "172.20.10."):
		return 0 // iPhone Personal Hotspot subnet
	case strings.HasPrefix(ip, "192.168."):
		return 1
	case strings.HasPrefix(ip, "10."):
		return 2
	case strings.HasPrefix(ip, "172."):
		return 3
	default:
		return 9
	}
}

func PrimaryLanIP() string {
	list := LanInterfaces()
	if len(list) == 0 {
		return "127.0.0.1"
	}
	sort.SliceStable(list, func(i, j int) bool { return score(list[i].Address) < score(list[j].Address) })
	return list[0].Address
}

func LocalHostname() string {
	h, err := os.Hostname()
	if err != nil || h == "" {
		h = "mac"
	}
	h = strings.TrimSuffix(h, ".")
	h = strings.TrimSuffix(h, ".local")
	return h + ".local"
}
