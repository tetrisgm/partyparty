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
assert.match(listener, /const UNTRACKED_REATTACH_CONFIRMATIONS = 10;/);
assert.match(listener, /const GOV_TRIGGER = 0\.5;/);
assert.match(listener, /const GOV_REATTACH_AT = 0\.75;/);
assert.match(listener, /logEvent\('gov-reattach'/);
assert.match(listener, /document\.visibilityState !== 'visible'/);
assert.doesNotMatch(listener, /forceHlsOnApple|beginAlignedAudible|alignOnce|sync-failed|sync-watchdog|mode=aggressive/);

const dj = read('web/dj.html');
assert.doesNotMatch(dj, /\/api\/start[^'"\n]*(?:bitrate|mono)|[?&](?:bitrate|mono)=/);
assert.match(dj, /\$\('shareCard'\)\.hidden = !linkReady;/);
assert.match(dj, /\$\('partyQrPanel'\)\.hidden = !linkReady;/);
assert.match(dj, /if \(linkReady\) renderQR\(guestUrl\);/);
assert.match(dj, /Starting audio…/);
assert.match(dj, /Allow System Audio Recording/);
assert.match(dj, /It never records your screen/);
assert.match(dj, /selectedCaptureDevice\(\) === 'mac'/);
assert.doesNotMatch(dj, /screenPermBtn|permission has not been confirmed/);

const playback = read('internal/server/playback.go');
assert.match(playback, /const roomLatencyTarget = 1\.0/);

const server = read('internal/server/server.go');
assert.doesNotMatch(server, /EXT-X-START|rewriteLivePlaylist|PART-HOLD-BACK/);
assert.doesNotMatch(server, /case "\/api\/delivery"/);
assert.doesNotMatch(server, /"delivery":\s*s\.Broadcaster/);
assert.match(server, /Privacy_AudioCapture/);
assert.doesNotMatch(server, /Privacy_ScreenCapture|Screen & System Audio Recording/);

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
