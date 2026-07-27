# Multi-DJ LAN switching

PartyParty Macs on the same venue Wi-Fi discover one another automatically.
This feature has no cloud directory and no audio relay.

## Production topology

- Each Mac advertises `_partyparty._tcp.local.` with only its install ID,
  certificate-backed hostname, and HTTPS port.
- Each Mac browses the same Bonjour service and verifies candidates through
  `GET /api/peer` over the candidate's normal trusted HTTPS origin.
- `GET /api/status` includes only currently reachable peers. A failed HTTPS
  probe removes a peer from the UI; discovery continues so it can return.
- The scanned Mac serves the listener page and DJ directory. Audio for a
  selected peer goes directly from that peer Mac to the phone.
- The guest's entry gesture warms every live peer stream. There is intentionally
  no arbitrary DJ count cap; parties are expected to have a small roster.
- Apple clients use native HLS for foreground, lock-screen, and background
  playback. Other clients use one hls.js controller per warm peer.
- Switching mutes the old native media element and unmutes the already-running
  selected element. It does not seek, relay, restart the room, or re-encode on
  behalf of another DJ.

## Permissions

The macOS app declares `NSLocalNetworkUsageDescription` and
`NSBonjourServices = _partyparty._tcp`. Store builds already have sandbox
client and server network entitlements. macOS presents the standard Local
Network consent prompt; no administrator, network reconfiguration, or
multicast entitlement is required.

## Physical acceptance

Use two released PartyParty Macs on the same ordinary venue Wi-Fi.

1. Allow Local Network access on both Macs and start PartyParty.
2. Start a different continuous track on each Mac.
3. Confirm each DJ appears as `live` in the other Mac's Guests panel within
   five seconds.
4. Scan either QR with two iPhones and enter the party normally.
5. Confirm both DJs appear on both phones without refreshing.
6. Switch repeatedly in both directions, including while each phone is locked.
7. Confirm switching is immediate after warming, selected audio remains stable,
   and the phone talks directly to the selected Mac.
8. Stop one DJ. Confirm it changes to unavailable within a few seconds and the
   phone does not remain stuck on a dead stream.
9. Restart that DJ. Confirm it reappears and can be selected without rescanning.
10. Review both diagnostics logs for `dj-switch`, media errors, and stalls.
