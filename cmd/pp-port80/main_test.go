package main

import "testing"

func TestParseWifiDevice(t *testing.T) {
	out := `Hardware Port: Ethernet
Device: en7
Ethernet Address: 00:11:22:33:44:55

Hardware Port: Wi-Fi
Device: en0
Ethernet Address: aa:bb:cc:dd:ee:ff
`
	got, err := parseWifiDevice(out)
	if err != nil {
		t.Fatal(err)
	}
	if got != "en0" {
		t.Fatalf("parseWifiDevice() = %q, want en0", got)
	}
}

func TestParseWifiDeviceAcceptsAirPort(t *testing.T) {
	out := `Hardware Port: AirPort
Device: en1
Ethernet Address: aa:bb:cc:dd:ee:ff
`
	got, err := parseWifiDevice(out)
	if err != nil {
		t.Fatal(err)
	}
	if got != "en1" {
		t.Fatalf("parseWifiDevice() = %q, want en1", got)
	}
}

func TestParseNetworkServices(t *testing.T) {
	out := `An asterisk (*) denotes that a network service is disabled.
Wi-Fi
*USB 10/100/1000 LAN
partyparty-adhoc
`
	got := parseNetworkServices(out)
	want := []string{"Wi-Fi", "USB 10/100/1000 LAN", "partyparty-adhoc"}
	if len(got) != len(want) {
		t.Fatalf("parseNetworkServices() = %#v, want %#v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("parseNetworkServices()[%d] = %q, want %q", i, got[i], want[i])
		}
	}
	if !serviceExists(got, adhocService) {
		t.Fatalf("serviceExists(%#v, %q) = false", got, adhocService)
	}
}

func TestCommandStringQuotesSpaces(t *testing.T) {
	got := commandString(networksetup, "-createnetworkservice", adhocService, "lo0")
	want := "/usr/sbin/networksetup -createnetworkservice partyparty-adhoc lo0"
	if got != want {
		t.Fatalf("commandString() = %q, want %q", got, want)
	}

	got = commandString(plistBuddy, "-c", "Set :NAT:PrimaryInterface:Device lo0", natPlist)
	want = "/usr/libexec/PlistBuddy -c 'Set :NAT:PrimaryInterface:Device lo0' /Library/Preferences/SystemConfiguration/com.apple.nat.plist"
	if got != want {
		t.Fatalf("commandString() = %q, want %q", got, want)
	}
}
