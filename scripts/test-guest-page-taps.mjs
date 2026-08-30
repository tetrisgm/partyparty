#!/usr/bin/env node
// The guest page, tapped like a guest taps it.
//
// The render test proves the page paints and stays still. It cannot catch the
// class of bug that actually bit us: a handler that throws the moment someone
// touches it. A silent ReferenceError inside a click or a poll handler passes
// every static check, passes `node --check`, and looks perfect in a screenshot
// - and it shipped a DJ console where nothing saved for five builds. So this
// test taps: play, the player sheet, the QR sheet, a comment, and a poll
// failure (which is what makes the page re-home to another DJ's Mac). Any
// console error or unhandled rejection fails the run.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const listenerHTML = fs.readFileSync(path.join(root, 'web/listener.html'), 'utf8')
  .replaceAll('__PP_VERSION__', 'tap-test');
const pixel = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

let statusFails = false;
const livePeers = [{
  id: 'peer-two', name: 'DJ Two', live: true, ready: true,
  roomUrl: 'https://dj-two.example',
  streamUrl: 'https://dj-two.example/live/party/index.m3u8',
}];
const wallPosts = [{
  id: 'p1', ts: Date.now() - 30000, act: Date.now() - 30000,
  author: 'Neon Fox', emoji: '🦊', text: 'what a night', media: [],
}];
const posted = [];

const statusBody = {
  appVersion: 'render-test',
  name: 'Stable Party',
  connection: { mode: 'direct' },
  llhlsUrl: '/hls/index.m3u8',
  latencyTarget: 3,
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
    if (statusFails) { response.writeHead(503); response.end(); return; }
    // appVersion must match the served page or it reloads itself mid-tap.
    sendJSON(response, { ...statusBody, appVersion: 'tap-test', peers: livePeers });
    return;
  }
  if (url.pathname === '/api/feed') {
    if (statusFails) { response.writeHead(503); response.end(); return; }
    sendJSON(response, { ...feedBody, posts: wallPosts, ids: wallPosts.map((p) => p.id) });
    return;
  }
  if (url.pathname === '/api/post' || url.pathname === '/api/comment') {
    posted.push(url.pathname);
    sendJSON(response, { ok: true });
    return;
  }
  if (url.pathname === '/api/time') { sendJSON(response, { t: Date.now() }); return; }
  if (url.pathname === '/api/heartbeat') { sendJSON(response, { ok: true }); return; }
  if (url.pathname === '/api/client-log' || url.pathname === '/api/client-events' || url.pathname === '/api/audio-open') {
    response.writeHead(204);
    response.end();
    return;
  }
  if (url.pathname.startsWith('/vendor/')) {
    response.writeHead(200, { 'Content-Type': 'application/javascript' });
    response.end('window.QRCode=function(el,o){var c=document.createElement("canvas");c.width=c.height=(o&&o.width)||200;el.appendChild(c);var i=document.createElement("img");el.appendChild(i);this.clear=function(){}};window.QRCode.CorrectLevel={M:0,H:2};');
    return;
  }
  if (url.pathname.endsWith('.m3u8')) {
    response.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
    response.end('#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-ENDLIST\n');
    return;
  }
  response.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': pixel.length });
  response.end(pixel);
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

  const errors = [];
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    // Media playback genuinely cannot work in a headless browser with a stub
    // playlist; everything else must be silent.
    if (/media|play|audio|source|network error|Failed to load resource/i.test(text)) return;
    errors.push(text);
  });
  page.on('pageerror', (error) => errors.push(String(error)));

  await page.addInitScript(() => {
    try { localStorage.setItem('pp.welcomed', '1'); } catch (e) {}
  });
  await page.goto(`http://127.0.0.1:${address.port}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#btn', { state: 'attached', timeout: 15000 });
  await page.waitForTimeout(800);

  const tap = async (selector) => {
    const el = page.locator(selector).first();
    if (await el.count() === 0) return false;
    try { await el.click({ timeout: 2000, force: true }); } catch (e) { return false; }
    await page.waitForTimeout(400);
    return true;
  };

  // The things a guest actually touches.
  assert.ok(await tap('#btn'), 'the listen button is missing');
  await tap('#playerSummary');   // expand the player sheet
  await tap('#sheetPlay');
  await tap('#sheetCollapse');
  await tap('#qrBtn');           // the pink QR with the DJ badge
  await page.waitForTimeout(600);
  await tap('#qrClose');
  await tap('#peopleBtn');

  // Posting: type and send, the way a guest comments on the night.
  const composer = page.locator('#ctext').first();
  if (await composer.count() > 0) {
    await composer.fill('great set');
    await tap('#csend');
  }

  // The page must survive its Mac going away: after a run of failed polls it
  // re-homes to another member of the party instead of spinning forever.
  statusFails = true;
  await page.waitForTimeout(9000);
  statusFails = false;
  await page.waitForTimeout(2000);

  assert.deepEqual(errors, [], `console errors while tapping: ${errors.join(' | ')}`);
  console.log('PASS guest page taps');
} finally {
  if (browser) await browser.close();
  server.close();
}
