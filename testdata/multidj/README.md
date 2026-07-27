# Multi-DJ switching lab

This lab tests only the phone experience of switching among three already-live
DJ channels. It does not implement production Bonjour discovery.

Run:

```sh
scripts/multidj-lab.mjs
```

The command prints a trusted HTTPS URL using this Mac's current PartyParty LAN
hostname. Open that URL on the Mac to display its QR, then scan it with an iPhone
on the same Wi-Fi.

The harness starts:

- one isolated MediaMTX process;
- one looping FFmpeg process per song;
- synchronized 64 kbps mono warm and 320 kbps stereo full renditions;
- one HTTPS switching page using native `<audio>` elements.

The page initially starts all three warm renditions from one user gesture.
Selecting a channel unmutes its warm rendition immediately, starts its
full-quality rendition, and switches to full quality once native playback
advances. The diagnostics beneath the buttons show whether Safari is actually
keeping each muted warm player alive.

Defaults:

- page: `9443`
- HLS: `9888`
- RTSP: `9554`

Override them with `PP_LAB_PAGE_PORT`, `PP_LAB_HLS_PORT`, and
`PP_LAB_RTSP_PORT`. Use `PP_LAB_HOST`, `PP_LAB_CERT`, and `PP_LAB_KEY` when
running outside the normal PartyParty installation.
