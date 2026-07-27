# Offline and LAN behavior

Guests connect directly to the Mac over venue Wi-Fi. The Mac serves the player,
LL-HLS stream, active-room feed, uploads, reactions, comments, and requests.
Guest routes are unauthenticated and continue to work without internet.

The HTTPS hostname uses a publicly trusted certificate and resolves to the Mac's
current private LAN address. The anonymous installation receives a stable
two-party-word hostname and credential. Initial hostname and certificate
provisioning need internet; the valid certificate is cached so later parties can
run when the venue's internet uplink disappears.

The Worker never receives live audio, party posts, or session diagnostics. It
supports anonymous LAN DNS/certificate coordination and the product website.

The console must distinguish:

- **LAN room reachable:** the HTTPS hostname resolves to this Mac's current LAN
  address and the local listener is serving.
- **Guests cannot join:** no secure LAN URL is currently reachable. There is no
  cloud fallback.
