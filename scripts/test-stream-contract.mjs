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
assert.match(listener, /const ROOM_TARGET_FALLBACK = 1\.0;/);
assert.match(listener, /const useNative = nativeHLS && \(isAppleUA \|\| iosShellBrowser\);/);
assert.match(listener, /const OUTLIER_LATE_BY = 0\.75;/);
assert.match(listener, /const OUTLIER_CONFIRMATIONS = 3;/);
assert.match(listener, /const OUTLIER_COOLDOWN_MS = 30000;/);
assert.match(listener, /const OUTLIER_MAX_REATTACHES = 2;/);
assert.match(listener, /logEvent\('outlier-reattach'/);
assert.match(listener, /document\.visibilityState !== 'visible'/);
assert.match(listener, /<div class="djpickerhead" id="djPickerHead">1 DJ now playing<\/div>[\s\S]*?<div class="feedhead" id="feedTitle">Party feed<\/div>/);
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
assert.doesNotMatch(listener, /—/);
assert.match(listener, /sheetPlay\.addEventListener\('click', \(\) => btn\.click\(\)\)/);
assert.match(listener, /body:not\(\.playing\) \.playbars\{visibility:hidden\}/);
assert.match(listener, /artworkUrl/);
assert.match(listener, /servicefavicon/);
assert.match(listener, /instagram: 'https:\/\/www\.instagram\.com\/favicon\.ico'/);
assert.match(listener, /soundcloud: 'https:\/\/soundcloud\.com\/favicon\.ico'/);
assert.match(listener, /venmo: 'https:\/\/account\.venmo\.com\/favicon\.ico'/);
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
assert.match(dj, /const dnsPublished = !!\(s && s\.lan && s\.lan\.dnsPublished === true\);/);
assert.match(dj, /const linkReady = !!guestUrl && secure;/);
assert.doesNotMatch(dj, /const linkReady = !!guestUrl && secure && lanReady;/);
assert.doesNotMatch(dj, /const linkReady = !!guestUrl && secure && dnsPublished;/);
assert.match(dj, /Secure link created\. Updating it for this Wi-Fi\./);
assert.match(dj, /Ready to scan\./);
assert.match(dj, /\.spin16\{animation:pp-spin 1\.4s linear infinite!important\}/);
assert.match(dj, /Starting Audio/);
assert.match(dj, /Stop Broadcasting/);
assert.doesNotMatch(dj, /id="badge"/);
assert.doesNotMatch(dj, /captureSoftAsk|screenPermBtn|permission has not been confirmed/);

const playback = read('internal/server/playback.go');
assert.match(playback, /const roomLatencyTarget = 1\.0/);

const server = read('internal/server/server.go');
assert.doesNotMatch(server, /EXT-X-START|rewriteLivePlaylist|PART-HOLD-BACK/);
assert.doesNotMatch(server, /case "\/api\/delivery"/);
assert.doesNotMatch(server, /"delivery":\s*s\.Broadcaster/);
assert.match(server, /Privacy_AudioCapture/);
assert.match(server, /case "\/api\/time":[\s\S]*?Access-Control-Allow-Origin/);
assert.doesNotMatch(server, /Privacy_ScreenCapture|Screen & System Audio Recording/);

const main = read('main.go');
assert.match(main, /startPeerDiscovery\(res\.Host\)/);

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
