# Current product plan

The architecture is intentionally narrow:

1. The Mac and every guest join the venue's existing Wi-Fi.
2. The Mac captures one selected source and serves one HTTPS LL-HLS stream.
3. Apple guests use native AVPlayer; other browsers use hls.js.
4. Party media and interaction remain local to the active room.
5. Cloud services are limited to identity, Mac activation, LAN certificate/DNS
   coordination, diagnostics, and software distribution.

The next product milestone is physical validation of the sandboxed App Store
build on a clean Mac and submission through App Store Connect. No older hotspot,
remote-event, replay, cloud-listening, playback-mode, or stream-preset roadmap
remains active.
