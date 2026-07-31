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
the Mac's direct HTTPS address, then sends the guest to whichever path works:

- **Direct:** straight to the Mac. Guest traffic stays on venue Wi-Fi.
- **Local:** the same LAN path with no internet involved anywhere. Requires this
  network's resolver to answer for the Mac's hostname, which the Mac checks and
  reports rather than assumes.
- **Relay:** the Mac pushes its LL-HLS to a relay origin that fans it out to
  guests. Used only when a phone proves the venue isolates nearby devices.
- **No path:** the secure hostname cannot be resolved and there is no internet.
  The console may offer an explicitly degraded HTTP link to the current LAN IP.
  It does not provide the hostname certificate, and locked-screen playback is
  not guaranteed.

Successful direct network verdicts are keyed without storing the Wi-Fi name and
expire after 24 hours. Failed probes are transient and are never remembered as
isolation. A changed LAN address immediately returns the Mac to checking. This
prevents an old venue result from silently controlling a new network.

Relay mode does not store an event, replay, recording, post, or upload. The
origin holds one party's live window in memory, bounded, and drops it when the
room goes quiet.

The Mac uploads each part once regardless of how many people are listening, and
it is never in a guest's request path, so a large room costs it what a small one
does.

If the setup service is unavailable at launch but the cached certificate is
valid, the QR uses the configured local hostname. A travel router can make that
work by providing a local DNS record for the hostname. If the hostname cannot be
resolved, the QR instead offers the explicitly degraded HTTP IP fallback. The
normal HTTPS path remains the supported path for reliable background playback.

The console must distinguish:

- **Checking:** waiting for a phone to prove the path.
- **Direct:** guests are reaching the Mac on venue Wi-Fi.
- **Local:** no internet here, and guests reach the Mac on this Wi-Fi anyway.
- **Relay:** the Wi-Fi limits nearby-device connections, so audio goes through
  the relay origin.
- **No path:** guests cannot reach the Mac and there is no internet to fall back
  on, with the reason stated.
