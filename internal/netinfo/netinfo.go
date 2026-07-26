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

// score prefers Wi-Fi, then other private venue-LAN addresses.
func score(iface Iface) int {
	if iface.Iface == "en0" {
		return 0
	}
	ip := iface.Address
	if strings.HasPrefix(ip, "192.168.") || strings.HasPrefix(ip, "10.") || strings.HasPrefix(ip, "172.") {
		return 1
	}
	return 9
}

func PrimaryLanIP() string {
	list := LanInterfaces()
	if len(list) == 0 {
		return "127.0.0.1"
	}
	sort.SliceStable(list, func(i, j int) bool { return score(list[i]) < score(list[j]) })
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
