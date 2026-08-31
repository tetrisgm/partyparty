package relay

import (
	"fmt"
	"reflect"
	"testing"
)

func TestRegistrationNotifiesTargetBeforePushAndOnTokenRotation(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	var events []string
	var manager *Manager
	manager = New(Config{
		OnTarget: func(originURL, publishToken string) {
			// OnTarget is production wiring, so it must run after the registration
			// is visible and without the relay lock held.
			gotOrigin, gotToken := manager.Relay()
			if gotOrigin != originURL || gotToken != publishToken {
				t.Errorf("callback target = (%q, %q), relay snapshot = (%q, %q)", originURL, publishToken, gotOrigin, gotToken)
			}
			events = append(events, fmt.Sprintf("target:%s:%s", originURL, publishToken))
		},
		OnPush: func(enabled bool) {
			events = append(events, fmt.Sprintf("push:%t", enabled))
		},
	})

	first := registration{RelayRegistration: activateRegistration(
		"https://join.partyparty.party/",
		"https://origin-one.partyparty.party/room/",
		"network-one",
	)}
	first.PublishToken = "token-one"
	manager.applyRegistration(first)

	tokenRotation := first
	tokenRotation.PublishToken = "token-two"
	manager.applyRegistration(tokenRotation)

	roomRotation := tokenRotation
	roomRotation.RelayURL = "https://origin-two.partyparty.party/room/"
	roomRotation.PublishToken = "token-three"
	manager.applyRegistration(roomRotation)
	manager.applyRegistration(roomRotation) // identical refresh is not a rotation

	want := []string{
		"target:https://origin-one.partyparty.party/room/:token-one",
		"push:false",
		"target:https://origin-one.partyparty.party/room/:token-two",
		"target:https://origin-two.partyparty.party/room/:token-three",
	}
	if !reflect.DeepEqual(events, want) {
		t.Fatalf("registration events = %v, want %v", events, want)
	}
}
