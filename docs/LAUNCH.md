# PartyParty public-beta launch kit

This is the working launch package for Hacker News, Product Hunt, and smaller
community launches. PartyParty is a **free public beta**, not an App Store
release. Keep that status explicit everywhere.

## Positioning

**Core promise:** Turn your Mac into a live headphone party.

**One sentence:** PartyParty broadcasts anything playing on a Mac to friends'
phones over Wi-Fi; guests scan a QR code, tap play, and listen together through
their own headphones, even with an iPhone locked.

Use these qualifications consistently:

- Say “no guest app or account,” not “no app.” The DJ installs the Mac app.
- Say “works without internet after setup,” not an unconditional “no internet.”
- Describe playback as low-latency, not synchronized or real time. Direct and
  relayed listeners can currently land at different delays.
- Say “free public beta,” without promising permanent pricing.
- Do not claim large-venue scale until it has been physically demonstrated.

## Hacker News

**Title**

> Show HN: PartyParty – stream a Mac's audio to phones over Wi-Fi

**First comment**

> I built PartyParty, a macOS menu-bar app that turns one Mac into a live audio
> server for a room. The DJ selects the Mac's output or an audio interface and
> clicks Go Live; guests scan a QR code and tap play in their browser. There is
> no guest app or account.
>
> The deceptively difficult part was keeping low-latency playback stable without
> active seeking or rate steering causing audible skips. The current design uses
> native HLS/AVPlayer, 500 ms segments, 150 ms LL-HLS parts, and a fixed room
> latency target. On iPhone it continues while Safari is backgrounded or the
> phone is locked.
>
> Ordinary Wi-Fi uses direct local HTTPS and can keep running without internet
> after setup. There is also an optional relay for venue networks that isolate
> clients. The Mac uploads one stream copy to an origin that fans out the
> original playlists; the Cloudflare Worker handles bootstrap and certificate
> coordination, but never carries media.
>
> The app is a free public TestFlight beta for macOS 26+, and the source is at
> https://github.com/tetrisgm/partyparty. I am looking for feedback on
> onboarding, real venue networks, and the latency/stability tradeoff.
>
> I am still validating many-phone venue behavior, mixed direct/relay field
> behavior, and Shazam recognition in the distribution-signed build.

Link the Show HN title directly to `https://partyparty.party`. Do not ask for
upvotes, coordinate comments, or obscure the beta and hardware requirements.

## Product Hunt

**Name:** PartyParty

**Tagline:** Turn your Mac into a live headphone party

**Description:**

> PartyParty broadcasts anything playing on a Mac to friends' phones over
> Wi-Fi. Guests scan a QR code, tap play, and listen together through their own
> headphones—even with an iPhone locked. No guest app or account.

**Status:** Free public beta via TestFlight

**Maker comment:**

> Hey Product Hunt — I made PartyParty for the places where a speaker is
> awkward, prohibited, or impossible: parks, apartment after-parties, beaches,
> and DIY silent discos.
>
> The DJ runs one Mac app and plays from Apple Music, a browser, rekordbox, or
> an audio interface. Friends scan a QR code and listen from their browser
> through their own headphones. They don't need an app or account, and iPhone
> playback continues when the screen locks.
>
> Keeping the room together was the hard part. PartyParty uses native HLS
> playback and a short cushion for ordinary Wi-Fi hiccups. It can run locally
> after setup, with an optional relay for venue Wi-Fi that blocks devices from
> reaching one another.
>
> This is a free public beta for macOS 26 or later. I'd especially love
> feedback from DJs, silent-disco organizers, and anyone who has tried to play
> music where speakers weren't an option.

Candidate topics: Music, Mac, Events, and Audio. Use only topics that exist in
Product Hunt's posting form. Do not describe the repository as open source
until it has an explicit license.

## Asset manifest

- Product thumbnail: `launch/product-hunt-thumbnail.png` (240×240)
- Social card: `launch/social-card.png` (1200×630)
- Product Hunt gallery: `launch/gallery-01.png` onward (1270×760)
- Seven-second product demo: `demo-video/out/partyparty-demo.mp4`
- App icon source: `app/AppAssets.xcassets/AppIcon.appiconset/icon_512x512@2x.png`

The seven-second demo is a designed product animation, not literal screen
capture. Upload it to YouTube before creating the Product Hunt draft. Capture a
real lock-screen playback image and a clean full Mac console image before the
final Product Hunt launch.

## Release-day checks

- [x] Source-visible, all-rights-reserved notice published. Replace it only
      through an explicit owner licensing decision.
- [x] README and its launch image are publicly readable while signed out.
- [x] Public TestFlight invitation resolves, latest build is assigned to the
      external group, and App Store Connect reports `IN_BETA_TESTING`.
- [ ] Fresh Mac completes installation and permission onboarding.
- [ ] Fresh iPhone scans, plays, backgrounds, and locks successfully.
- [ ] Direct Wi-Fi path passes on the launch build.
- [ ] Relay path passes on the launch build.
- [x] Public support page and GitHub private security-report instructions work.
- [ ] Social-card previews render correctly on target networks.
- [ ] Product Hunt thumbnail, gallery, and YouTube link are attached.
- [x] Launch copy contains no unsupported scale, synchronization, latency, or
      offline claims.
- [ ] A supervised real-AVPlayer field test has closed the direct/relay delay
      mismatch before any synchronized-playback claim is restored.
- [ ] Owner is available to answer comments and triage reports.

## Measurement

The landing page routes TestFlight and GitHub calls to first-party `/go/`
redirects. The Worker writes one aggregate Analytics Engine point containing
only destination (`testflight` or `github`), an allowlisted placement, and the
count `1`. It deliberately records no IP address, user agent, referrer, cookie,
party identifier, or person identifier. The dataset is `partyparty_launch`.

## Owner-only actions

- Decide whether to keep the source-visible notice or replace it with an
  open-source license.
- Capture any real-device images that should not be simulated.
- Upload the demo to YouTube under the desired account.
- Create or schedule the Product Hunt post from the maker's personal account.
- Submit the Show HN post from the owner's Hacker News account.
- Decide separately whether and when to attach and submit an App Store build.
