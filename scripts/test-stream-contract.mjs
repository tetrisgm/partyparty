#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

function checkInlineScripts(relative) {
  const html = read(relative);
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
    .map((match) => match[1])
    .filter((script) => script.trim());
  assert.ok(scripts.length > 0, `${relative} has no inline scripts`);
  scripts.forEach((script, index) => {
    const result = spawnSync(process.execPath, ['--check', '-'], {
      cwd: root,
      input: script,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, `${relative} inline script ${index + 1} failed syntax check:\n${result.stderr}`);
  });
}

checkInlineScripts('web/listener.html');
checkInlineScripts('web/dj.html');

const listener = read('web/listener.html');
const forbiddenDash = String.fromCodePoint(0x2014);
assert.match(listener, /const ROOM_TARGET_FALLBACK = 1\.0;/);
assert.match(listener, /const useNative = nativeHLS && \(isAppleUA \|\| iosShellBrowser\);/);
assert.match(listener, /const OUTLIER_LATE_BY = 0\.75;/);
assert.match(listener, /const OUTLIER_CONFIRMATIONS = 3;/);
assert.match(listener, /const OUTLIER_COOLDOWN_MS = 30000;/);
assert.match(listener, /const OUTLIER_MAX_REATTACHES = 2;/);
assert.match(listener, /logEvent\('outlier-reattach'/);
assert.match(listener, /document\.visibilityState !== 'visible'/);
// The DJ picker still opens the wall, but the "Party feed" heading above the
// photos was redundant and is gone for good.
assert.match(listener, /<div class="djpickerhead" id="djPickerHead">1 DJ now playing<\/div>[\s\S]*?<section class="album" id="albumSec"/);
assert.doesNotMatch(listener, /id="feedTitle"/);
// Who else is here belongs under the DJ card, not only behind a top-bar icon.
assert.match(listener, /id="listenersRow"[\s\S]*?id="listenersAvatars"[\s\S]*?id="listenersNum"/);
// The DJ strip is a snap reel: snapping moves focus, and the switch fires only
// once it settles. Committing per card crossed would rebuild the HLS session
// each time and put an audible gap in the music.
assert.match(listener, /const REEL_SETTLE_MS = \d+;/);
assert.match(listener, /scroll-snap-type:x mandatory/);
assert.match(listener, /\.djlist\.reel \.djchoice\.focused/);
// The event names itself on its own cover, with the city under it.
assert.match(listener, /id="coverTitle"/);
assert.match(listener, /id="coverPlace"/);
assert.match(listener, /function setEventPlace\(place\)/);
// The player bar must look expandable and must not promise lock-screen audio
// a second time; the cover already says it.
assert.match(listener, /class="expandchev"/);
assert.doesNotMatch(listener, /Audio stays on with screen locked/);
// Never dress the party cover up as the sleeve of a track we did not recognise.
assert.match(listener, /miniArt\.hidden = !artwork;/);
assert.match(listener, /function renderDJSelector\(djs, target\)/);
assert.match(listener, /listeners \+ ' listening<\/small>/);
assert.doesNotMatch(listener, /✓ Listening/);
assert.match(listener, /const djPalette = \[/);
assert.match(listener, /--selected-dj-color/);
assert.match(listener, /id="sheetBio"/);
assert.match(listener, /id="sheetProfileName"/);
assert.match(listener, /id="djProfileBio"/);
assert.match(listener, /row\.className = 'djprofilelink'/);
assert.doesNotMatch(listener, /id="sheetListenCount"/);
assert.match(listener, /let discoveredPeers = \[\], selectedDJId = ''/);
assert.match(listener, /function openPlayerSheet\(anchor\)/);
assert.match(listener, /playerSummary\.addEventListener\('click', \(\) => openPlayerSheet\(\)\)/);
assert.match(listener, /peopleBtn\.addEventListener\('click', \(\) => openPlayerSheet\('listeners'\)\)/);
assert.match(listener, /playerSheet\.addEventListener\('touchstart'/);
assert.match(listener, /playerSheet\.addEventListener\('touchmove'/);
assert.match(listener, /playerSheet\.addEventListener\('touchend'/);
assert.match(listener, /id="sheetCollapse"[^>]*>×<\/button>/);
assert.match(listener, /\.playerbarrow\{[\s\S]*?background:var\(--selected-dj-color,#20c965\)/);
assert.match(listener, /\.playersheet\{[\s\S]*?background:var\(--sheet-bg\)/);
assert.ok(!listener.includes(forbiddenDash));
assert.match(listener, /sheetPlay\.addEventListener\('click', \(\) => btn\.click\(\)\)/);
assert.match(listener, /body:not\(\.playing\) \.playbars\{visibility:hidden\}/);
assert.match(listener, /artworkUrl/);
assert.match(listener, /function renderIfChanged\(target, signature, render\)/);
assert.match(listener, /function setImageSource\(image, source\)/);
assert.match(listener, /let listenerGroupsSignature = '';/);
assert.match(listener, /renderIfChanged\(target, JSON\.stringify\(model\)/);
assert.match(listener, /function serviceIconMarkup\(type\)/);
assert.match(listener, /class="serviceicon"/);
assert.match(listener, /renderIfChanged\(albumStrip, signature/);
assert.match(listener, /sheetPlay\.dataset\.playState !== playState/);
assert.match(listener, /let currentLinksSignature = '';/);
assert.match(listener, /let currentTrackSignature = '';/);
assert.doesNotMatch(listener, /favicon\.ico|servicefavicon|servicefallback|favicon-failed/);
assert.match(listener, /switchingTo !== null/);
assert.match(listener, /selectedDJId = previousID/);
assert.match(listener, /Could not switch DJs/);
assert.match(listener, /function applySelectedSource\(peer\)/);
assert.match(listener, /LLSTREAM = peer\.streamUrl \|\| null;/);
assert.match(listener, /selectedDJId = id;[\s\S]*?paintDJs\(discoveredPeers\);[\s\S]*?resetTransport\(\);[\s\S]*?applySelectedSource\(peer\);[\s\S]*?attachSafe\(\)/);
assert.match(listener, /function clockURL\(\)[\s\S]*?peer\.roomUrl \+ '\/api\/time'/);
assert.match(listener, /const selectedChanged = LLSTREAM !== selected\.streamUrl/);
assert.doesNotMatch(listener, /peerPlayers|peerHls|peerPlayer|primePeerPlayers|document\.createElement\('audio'\)/);
assert.match(listener, /navigator\.mediaSession\.setActionHandler\('play',[\s\S]*?resumeGuest\(\)/);
assert.match(listener, /navigator\.mediaSession\.setActionHandler\('pause',[\s\S]*?pauseGuest\(\)/);
assert.match(listener, /function updateMediaSessionMetadata\(\)/);
assert.match(listener, /mediaSessionMetadataSignature/);
assert.match(listener, /venmo:\/\/paycharge\?txn=pay&recipients=/);
assert.match(listener, /data-web-fallback|dataset\.webFallback/);
assert.doesNotMatch(listener, /player\.currentTime\s*=|nativeGovernorTick|GOV_|untracked-reconnect|forceHlsOnApple|beginAlignedAudible|alignOnce|sync-failed|sync-watchdog|mode=aggressive/);

const dj = read('web/dj.html');
const djIDs = new Set([...dj.matchAll(/\bid=["']([^"']+)["']/g)].map((match) => match[1]));
const djIDRefs = [...dj.matchAll(/\$\(["']([^"']+)["']\)/g)].map((match) => match[1]);
assert.deepEqual(
  [...new Set(djIDRefs.filter((id) => !djIDs.has(id)))].sort(),
  [],
  'DJ console JavaScript references an element that is no longer in the page',
);
assert.match(dj, />About You</);
assert.match(dj, />Event Details</);
assert.match(dj, /Add another link/);
assert.match(dj, /https:\/\/account\.venmo\.com\/u\//);
assert.match(dj, /id="profileName"/);
assert.match(dj, /id="profilePhotoRemoveBtn"/);
assert.doesNotMatch(dj, /Guests connected to the LAN room/);
assert.doesNotMatch(dj, /hosted by&nbsp;/);
assert.doesNotMatch(dj, /id="heroLinks"/);
assert.doesNotMatch(dj, /\$\('devname(?:Wrap)?'\)/);
assert.doesNotMatch(dj, /\/api\/start[^'"\n]*(?:bitrate|mono)|[?&](?:bitrate|mono)=/);
assert.match(dj, /renderQR\(guestUrl\);[\s\S]*?return;/);
assert.match(dj, /id="qrPending" role="status" aria-live="polite"/);
assert.match(dj, /Creating secure guest link/);
assert.match(dj, /Retrying automatically/);
assert.match(dj, /const INITIAL_GUEST_URL = __PP_INITIAL_GUEST_URL_JSON__;/);
assert.match(dj, /function renderGuestLink\(s\)/);
assert.match(dj, /renderGuestLink\(null\);/);
assert.match(dj, /const s = await \(await fetch\('\/api\/status'[\s\S]*?renderGuestLink\(s\);[\s\S]*?const st = s\.broadcast\.state;/);
assert.match(dj, /console\.error\('console refresh failed:', message\);/);
assert.match(dj, /djLog\('error', \{ msg: 'console refresh failed: ' \+ message \}\);/);
assert.match(dj, /\$\('qr'\)\.hidden = false;/);
assert.match(dj, /\$\('qrPending'\)\.hidden = true;/);
assert.doesNotMatch(dj, /\$\('shareCard'\)\.hidden = !linkReady;/);
assert.doesNotMatch(dj, /\$\('partyQrPanel'\)\.hidden = !linkReady;/);
assert.doesNotMatch(dj, /id="setupCard"/);
assert.match(dj, /typeof s\.urls\?\.join === 'string'/);
assert.match(dj, /const mode = s && s\.connection && s\.connection\.mode \|\| 'checking';/);
assert.match(dj, /const linkReady = !!guestUrl && secure;/);
assert.match(dj, /Scan once to check this Wi-Fi\./);
assert.match(dj, /Internet relay active\./);
assert.match(dj, /Direct Wi-Fi connection\./);
assert.match(dj, /function renderConnectionState\(connection\)/);
assert.match(dj, /Reconnecting the internet relay now\./);
assert.doesNotMatch(dj, /const dnsPublished =/);
assert.match(dj, /\.spin16\{animation:pp-spin 1\.4s linear infinite!important\}/);
assert.match(dj, /Starting Audio/);
assert.match(dj, /Stop Broadcasting/);
assert.doesNotMatch(dj, /id="badge"/);
assert.doesNotMatch(dj, /captureSoftAsk|screenPermBtn|permission has not been confirmed/);
assert.ok(!dj.includes(forbiddenDash));

const playback = read('internal/server/playback.go');
assert.match(playback, /const roomLatencyTarget = 1\.0/);

const server = read('internal/server/server.go');
assert.match(server, /body = rewriteLivePlaylist\(body\)/);
assert.doesNotMatch(server, /EXT-X-START|PART-HOLD-BACK/);
assert.doesNotMatch(server, /case "\/api\/delivery"/);
assert.doesNotMatch(server, /"delivery":\s*s\.Broadcaster/);
assert.match(server, /Privacy_AudioCapture/);
assert.match(server, /case "\/api\/time":[\s\S]*?Access-Control-Allow-Origin/);
assert.doesNotMatch(server, /Privacy_ScreenCapture|Screen & System Audio Recording/);

const main = read('main.go');
assert.match(main, /startPeerDiscovery\(res\.Host\)/);
assert.match(main, /relay\.New\(relay\.Config/);

const relayMode = read('internal/relay/mode.go');
assert.match(relayMode, /ModeChecking = "checking"/);
assert.match(relayMode, /ModeDirect\s+= "direct"/);
assert.match(relayMode, /ModeRelay\s+= "relay"/);

const relayManager = read('internal/relay/relay.go');
assert.match(relayManager, /A guest's verdict rides the registration response/);
assert.match(relayManager, /m\.applyProbe\(networkKey, \*next\.Probe\)/);
assert.doesNotMatch(relayManager, /case "state_ack":|websocket\.Dial/);

const config = read('internal/config/config.go');
assert.match(config, /c\.Bitrate = "320k"/);
assert.match(config, /c\.Channels = 2/);
assert.match(config, /c\.PartDur = "150ms"/);
assert.match(config, /c\.SegDur = "500ms"/);
assert.match(config, /c\.SegCount = 48/);
assert.doesNotMatch(config, /PARTYPARTY_(?:BITRATE|MONO|DELIVERY|PART_DUR|SEG_DUR|SEG_COUNT)/);
assert.equal(fs.existsSync(path.join(root, 'internal/config/overrides.go')), false);
assert.equal(fs.existsSync(path.join(root, 'scripts/llhls-test.sh')), false);
assert.equal(fs.existsSync(path.join(root, 'scripts/setup-cert.sh')), false);
assert.deepEqual(JSON.parse(read('web/config.json')), {});

const broadcast = read('internal/broadcast/broadcast.go');
assert.match(broadcast, /fifo_options=drop_pkts_on_overflow=1/);

const e2e = read('scripts/stream-e2e.mjs');
assert.match(e2e, /hlsSegmentCount: 48/);
assert.match(e2e, /hlsSegmentDuration: 500ms/);
assert.match(e2e, /hlsPartDuration: 150ms/);
assert.match(e2e, /latencyTarget: 1,/);
assert.doesNotMatch(e2e, /latencyTarget:\s*3/);
assert.doesNotMatch(e2e, /--delivery|--latency-target|--part-duration|--seg-duration|--seg-count/);

console.log('PASS fixed streaming contract');
