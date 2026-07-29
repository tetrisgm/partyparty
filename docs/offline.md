# Offline and LAN behavior

In direct mode, guests connect to the Mac over venue Wi-Fi. The Mac serves the
player, LL-HLS stream, active-room feed, uploads, reactions, comments, and
requests. Guest routes are unauthenticated and continue to work without
internet.

The HTTPS hostname uses a publicly trusted certificate and resolves to the Mac's
current private LAN address. The anonymous installation receives a stable
two-party-word hostname and credential. Initial hostname and certificate
provisioning need internet; the valid certificate is cached so later parties can
run when the venue's internet uplink disappears.

On an online network, the QR opens an unguessable public bootstrap that probes
the Mac's direct HTTPS address. The browser reports the result and the Mac
selects one mode for the room:

- **Direct:** the public bootstrap redirects to the Mac. Guest traffic stays on
  venue Wi-Fi.
- **Relay:** one authenticated outbound WebSocket from the Mac carries the live
  guest HTTP and LL-HLS surface through Cloudflare. This is used only when a
  phone proves that the venue isolates nearby devices.

Network verdicts are keyed without storing the Wi-Fi name and expire after 24
hours. A changed LAN address immediately returns the Mac to checking. This
prevents an old venue result from silently controlling a new network.

Relay mode does not store an event, replay, recording, post, or upload. Rolling
HLS media parts and relayed still photos may be cached for up to 60 seconds to
avoid uploading identical bytes once per listener.

Live music is the hard priority in relay mode. `/live/` responses use the
priority queue. Guest photos use a capped, throttled secondary path. Videos are
rejected before their bodies enter the tunnel. Text posts, reactions, event
artwork, DJ profiles, and track artwork continue. Direct mode keeps full photo
and video support.

If the setup service is unavailable at launch but the cached certificate is
valid, the QR uses the direct address. That preserves offline travel-router and
venue operation.

The console must distinguish:

- **Checking:** the public bootstrap is waiting for a phone to prove the path.
- **Direct:** guests are reaching the Mac on venue Wi-Fi.
- **Relay:** the Wi-Fi limits nearby-device connections and the live internet
  relay is active or reconnecting.
