package server

import "testing"

func TestDeriveNetworkSituation(t *testing.T) {
	base := networkSituation{LanIP: "192.168.1.42"}
	cases := []struct {
		name string
		in   networkSituation
		want string
	}{
		{
			name: "no lan ip",
			in:   networkSituation{},
			want: networkSituationNoNetwork,
		},
		{
			name: "wifi internet resolves",
			in: networkSituation{
				LanIP:       base.LanIP,
				OnWifi:      true,
				HasInternet: true,
				Resolves:    true,
			},
			want: networkSituationSharedWifiReady,
		},
		{
			name: "ethernet internet can host",
			in: networkSituation{
				LanIP:       base.LanIP,
				OnEthernet:  true,
				HasInternet: true,
			},
			want: networkSituationEthernetCanHost,
		},
		{
			name: "wifi no internet",
			in: networkSituation{
				LanIP:       base.LanIP,
				OnWifi:      true,
				HasInternet: false,
			},
			want: networkSituationWifiNoInternet,
		},
		{
			name: "wifi no internet wins over resolves",
			in: networkSituation{
				LanIP:    base.LanIP,
				OnWifi:   true,
				Resolves: true,
			},
			want: networkSituationWifiNoInternet,
		},
		{
			name: "no usable path",
			in:   base,
			want: networkSituationNoNetwork,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := deriveNetworkSituation(tc.in); got != tc.want {
				t.Fatalf("deriveNetworkSituation(%+v) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

func TestParseHardwarePorts(t *testing.T) {
	out := `
Hardware Port: Ethernet Adapter (en4)
Device: en4
Ethernet Address: 8a:4f:55:b6:ac:5a

Hardware Port: Wi-Fi
Device: en0
Ethernet Address: ac:07:75:03:1d:b3

VLAN Configurations
===================
`
	ports := parseHardwarePorts(out)
	if ports["en0"] != "Wi-Fi" {
		t.Fatalf("en0 port = %q, want Wi-Fi", ports["en0"])
	}
	if ports["en4"] != "Ethernet Adapter (en4)" {
		t.Fatalf("en4 port = %q, want Ethernet Adapter (en4)", ports["en4"])
	}
}
