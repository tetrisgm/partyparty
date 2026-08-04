#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const listenerHTML = fs.readFileSync(path.join(root, 'web/listener.html'), 'utf8')
  .replaceAll('__PP_VERSION__', 'render-test');
const pixel = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

const statusBody = {
  appVersion: 'render-test',
  name: 'Stable Party',
  connection: { mode: 'direct' },
  llhlsUrl: '/hls/index.m3u8',
  latencyTarget: 1,
  broadcast: { state: 'idle', since: 0 },
  streamSync: { generation: 0, ready: false },
  event: {
    host: 'DJ Luna',
    avatar: '/avatar.png',
    bio: 'House music and bright rooms.',
  },
  listenerGroups: [{
    dj: 'DJ Luna',
    listeners: [{ name: 'Casey', emoji: '🎧' }],
  }],
  peers: [],
};

const feedBody = {
  cursor: 1,
  title: 'Stable Party',
  host: 'DJ Luna',
  avatar: '/avatar.png',
  bio: 'House music and bright rooms.',
  cover: '/cover.png',
  starts: '',
  features: {
    uploads: true,
    videoUploads: true,
    comments: true,
    reactions: false,
    requests: false,
    trackId: true,
    wallMode: true,
  },
  links: [
    { type: 'instagram', label: 'Instagram', url: 'https://www.instagram.com/djluna' },
    { type: 'soundcloud', label: 'SoundCloud', url: 'https://soundcloud.com/djluna' },
    { type: 'website', label: 'Website', url: 'https://djluna.example' },
  ],
  nowPlaying: {
    title: 'Night Drive',
    artist: 'DJ Luna',
    artworkUrl: '/artwork.png',
  },
  reactions: {},
  posts: [],
  ids: [],
  media: 0,
  photos: 0,
  videos: 0,
};

function sendJSON(response, value) {
  const body = JSON.stringify(value);
  response.writeHead(200, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  response.end(body);
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  if (url.pathname === '/' || url.pathname === '/listener.html') {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(listenerHTML);
    return;
  }
  if (url.pathname === '/api/status') {
    sendJSON(response, statusBody);
    return;
  }
  if (url.pathname === '/api/feed') {
    sendJSON(response, feedBody);
    return;
  }
  if (url.pathname === '/api/time') {
    sendJSON(response, { t: Date.now() });
    return;
  }
  if (url.pathname === '/api/client-log' || url.pathname === '/api/audio-open') {
    response.writeHead(204);
    response.end();
    return;
  }
  if (url.pathname.endsWith('.png') || url.pathname.endsWith('.jpg')) {
    response.writeHead(200, {
      'Content-Type': 'image/png',
      'Content-Length': pixel.length,
      'Cache-Control': 'public, max-age=3600',
    });
    response.end(pixel);
    return;
  }
  response.writeHead(404);
  response.end();
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});

let browser;
try {
  const address = server.address();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const externalRequests = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.hostname !== '127.0.0.1') externalRequests.push(url.href);
  });
  await page.addInitScript(() => {
    try { localStorage.setItem('pp.welcomed', '1'); } catch (error) {}
    window.__imageSourceWrites = [];
    window.__mediaMetadataWrites = [];
    class TestMediaMetadata {
      constructor(metadata) {
        Object.assign(this, metadata);
        window.__mediaMetadataWrites.push(JSON.parse(JSON.stringify(metadata)));
      }
    }
    Object.defineProperty(window, 'MediaMetadata', {
      configurable: true,
      value: TestMediaMetadata,
    });
    Object.defineProperty(navigator, 'mediaSession', {
      configurable: true,
      value: {
        metadata: null,
        playbackState: 'none',
        setActionHandler() {},
      },
    });
    const descriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
    if (!descriptor || !descriptor.get || !descriptor.set) return;
    Object.defineProperty(HTMLImageElement.prototype, 'src', {
      configurable: descriptor.configurable,
      enumerable: descriptor.enumerable,
      get: descriptor.get,
      set(value) {
        window.__imageSourceWrites.push({ id: this.id || '', value: String(value) });
        return descriptor.set.call(this, value);
      },
    });
  });

  await page.goto(`http://127.0.0.1:${address.port}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() =>
    document.querySelectorAll('#djProfileLinks .djprofilelink').length === 3 &&
    document.querySelector('#djList .djchoice img') &&
    document.querySelector('#sheetListenerGroups .listenergroup') &&
    document.querySelector('#albumStrip .albumempty'),
  );
  await page.waitForTimeout(700);

  await page.evaluate(() => {
    window.__stableListenerNodes = {
      card: document.querySelector('#djList .djchoice'),
      cardAvatar: document.querySelector('#djList .djchoice img'),
      sheetCard: document.querySelector('#sheetDJList .djchoice'),
      listenerGroup: document.querySelector('#sheetListenerGroups .listenergroup'),
      profileLink: document.querySelector('#djProfileLinks .djprofilelink'),
      sheetProfileLink: document.querySelector('#sheetLinks .djprofilelink'),
      playIcon: document.querySelector('#sheetPlay svg'),
      albumEmpty: document.querySelector('#albumStrip .albumempty'),
      headingText: document.querySelector('#djPickerHead').firstChild,
      profileNameText: document.querySelector('#djProfileName').firstChild,
      trackTitleText: document.querySelector('#sheetTrackTitle').firstChild,
    };
    window.__stableImageWriteCount = window.__imageSourceWrites.length;
    window.__stableMediaMetadataWriteCount = window.__mediaMetadataWrites.length;
  });

  await page.waitForTimeout(4200);

  const stable = await page.evaluate(() => {
    const before = window.__stableListenerNodes;
    return {
      card: before.card === document.querySelector('#djList .djchoice'),
      cardAvatar: before.cardAvatar === document.querySelector('#djList .djchoice img'),
      sheetCard: before.sheetCard === document.querySelector('#sheetDJList .djchoice'),
      listenerGroup: before.listenerGroup === document.querySelector('#sheetListenerGroups .listenergroup'),
      profileLink: before.profileLink === document.querySelector('#djProfileLinks .djprofilelink'),
      sheetProfileLink: before.sheetProfileLink === document.querySelector('#sheetLinks .djprofilelink'),
      playIcon: before.playIcon === document.querySelector('#sheetPlay svg'),
      albumEmpty: before.albumEmpty === document.querySelector('#albumStrip .albumempty'),
      headingText: before.headingText === document.querySelector('#djPickerHead').firstChild,
      profileNameText: before.profileNameText === document.querySelector('#djProfileName').firstChild,
      trackTitleText: before.trackTitleText === document.querySelector('#sheetTrackTitle').firstChild,
      imageWrites: window.__imageSourceWrites.length === window.__stableImageWriteCount,
      mediaMetadataWrites: window.__mediaMetadataWrites.length === window.__stableMediaMetadataWriteCount,
      serviceImages: document.querySelectorAll('.djprofilelink img').length,
      serviceIcons: document.querySelectorAll('#djProfileLinks .serviceicon').length,
    };
  });

  for (const [name, value] of Object.entries(stable)) {
    if (name === 'serviceImages' || name === 'serviceIcons') continue;
    assert.equal(value, true, `${name} was replaced by an unchanged poll response`);
  }
  assert.equal(stable.serviceImages, 0, 'profile services must not fetch remote favicon images');
  assert.equal(stable.serviceIcons, 3, 'all known profile services must have local icons');
  const initialMetadata = await page.evaluate(() => window.__mediaMetadataWrites.at(-1));
  assert.equal(initialMetadata.title, 'Night Drive', 'Media Session must receive the current track title');
  assert.equal(initialMetadata.artist, 'DJ Luna', 'Media Session must receive the current track artist');

  // Venmo is gone from the product; a plain web link is what a profile carries.
  const siteLink = await page.locator('#djProfileLinks .djprofilelink').filter({ hasText: 'Website' }).evaluate((link) => ({
    href: link.getAttribute('href'),
  }));
  assert.equal(siteLink.href, 'https://djluna.example/');

  feedBody.nowPlaying = {
    title: 'Sunrise',
    artist: 'The Second Track',
    artworkUrl: '/artwork-2.png',
  };
  await page.waitForFunction(() =>
    window.__mediaMetadataWrites.at(-1)?.title === 'Sunrise' &&
    document.querySelector('#sheetTrackTitle')?.textContent === 'Sunrise',
  );
  const refreshedMetadata = await page.evaluate(() => window.__mediaMetadataWrites.at(-1));
  assert.equal(refreshedMetadata.artist, 'The Second Track',
    'Media Session metadata must refresh while the existing playback session stays active');
  assert.match(refreshedMetadata.artwork[0].src, /\/artwork-2\.png$/);

  assert.deepEqual(externalRequests, [], `listener made external asset requests:\n${externalRequests.join('\n')}`);
  if (process.env.PARTYPARTY_RENDER_SCREENSHOT) {
    await page.screenshot({ path: process.env.PARTYPARTY_RENDER_SCREENSHOT, fullPage: true });
  }
  console.log('PASS listener render stability');
} finally {
  if (browser) await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
