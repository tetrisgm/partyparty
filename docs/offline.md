# Offline and LAN behavior

Guests connect directly to the Mac over venue Wi-Fi. The Mac serves the player,
LL-HLS stream, active-room feed, uploads, reactions, comments, and requests.
Guest routes are unauthenticated and continue to work without internet.

The HTTPS hostname uses a publicly trusted certificate and resolves to the Mac's
current private LAN address. Initial account linking and certificate issuance
need internet. A linked Mac caches its account and valid certificate so later
parties can run when the venue's internet uplink disappears.

The Worker never receives live audio or party posts. It supports sign-in, Mac
linking, LAN DNS/certificate coordination, diagnostics, downloads, and updates.

The console must distinguish:

- **LAN room reachable:** the HTTPS hostname resolves to this Mac's current LAN
  address and the local listener is serving.
- **Guests cannot join:** no secure LAN URL is currently reachable. There is no
  cloud fallback.
