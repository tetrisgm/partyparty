# HELD (do not run until the v1 onboarding field-tests OK): Captive-portal one-scan hotspot join

Held in codex/tasks/held/ so the loop does NOT auto-run it. This is the upgrade
that makes JOINING the Mac's hotspot a SINGLE scan (join Wi-Fi -> party auto-opens),
instead of the two-step "join Wi-Fi QR then party QR". It needs real-iPhone field
validation before it's worth shipping, so run it only after network-detect +
guest-setup-ui land and the basic onboarding is confirmed working at a real party.

## Idea
When a phone joins Wi-Fi, iOS/Android auto-fetch a captive-detection probe
(captive.apple.com/hotspot-detect.html, connectivitycheck.gstatic.com, etc.). When
the Mac IS the network (Internet Sharing / hotspot), intercept those probes and
serve a tiny launchpad page ("🎉 Tap to open the party") that bounces the guest into
full Safari at the real HTTPS party URL. Result: one `WIFI:` QR joins the hotspot and
the party pops automatically.

## Approach
- Only active when hotspotting (bridge100 up) and the Mac owns DHCP/DNS. Extend the
  existing local DNS server to answer the well-known captive hostnames with the Mac's
  IP, and serve an HTTP launchpad on that path.
- The Captive Network Assistant is a restricted mini-browser (no reliable audio, HTTP-
  oriented). Use it ONLY as a launchpad that hands off to Safari at primaryUrl — do
  NOT try to run the stream inside it.

## Risks to validate on a real iPhone FIRST
- Whether the CNA auto-pops reliably on the current iOS, and whether "open in Safari"
  hands off cleanly (both are version-finicky).
- That it doesn't interfere with the guest's normal captive checks when NOT hotspotting.

## Guardrails
- Do NOT touch internal/broadcast/* or the sign-in path. Extend the DNS/HTTP serving
  only. Branch only; needs a field test before merge.
