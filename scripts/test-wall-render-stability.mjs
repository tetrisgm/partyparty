#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wallHTML = fs.readFileSync(path.join(root, 'web/wall.html'), 'utf8')
  .replaceAll('__PP_VERSION__', 'wall-render-test');
const pixel = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

const statusBody = {
  appVersion: 'wall-render-test',
  name: 'Stable Party',
  listeners: 7,
  connection: { mode: 'direct' },
  broadcast: { state: 'live' },
  urls: { join: 'https://join.example/party' },
  event: {
    title: 'Stable Party',
    host: 'DJ Luna',
    features: { wallMode: true },
    links: [{ type: 'instagram', url: 'https://instagram.com/djluna' }],
  },
};
const feedBody = {
  cursor: 1,
  dir: 'party-1',
  title: 'Stable Party',
  host: 'DJ Luna',
  features: { wallMode: true, reactions: true },
  links: [{ type: 'instagram', url: 'https://instagram.com/djluna' }],
  nowPlaying: { title: 'Night Drive', artist: 'DJ Luna' },
  reactions: { fire: 2 },
  spikes: {},
  ids: ['p1'],
  posts: [{
    id: 'p1', ts: 1, act: 1, author: 'Casey', emoji: '🎧',
    media: [{ id: 'm1', type: 'image', thumb: '/thumb/m1.png' }],
  }],
};

let holdStatus = false;
let statusRequests = 0;
let feedVersion = 1;
const heldStatus = [];
const heldFeeds = [];
const feedRequests = [];

function sendJSON(response, value, headers = {}) {
  if (response.destroyed || response.writableEnded) return;
  const body = JSON.stringify(value);
  response.writeHead(200, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...headers,
  });
  response.end(body);
}

function hold(request, response, pending) {
  pending.push(response);
  request.once('close', () => {
    const index = pending.indexOf(response);
    if (index >= 0) pending.splice(index, 1);
  });
}

function release(pending, value, headers = {}) {
  for (const response of pending.splice(0)) sendJSON(response, value, headers);
}

function currentFeedTag() {
  return `"feed-${feedVersion}"`;
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  if (url.pathname === '/' || url.pathname === '/wall.html') {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(wallHTML);
    return;
  }
  if (url.pathname === '/vendor/qrcode.min.js') {
    response.writeHead(200, { 'Content-Type': 'application/javascript' });
    response.end('window.QRCode=function(el,o){window.__qrCreates=(window.__qrCreates||0)+1;var c=document.createElement("canvas");c.width=c.height=(o&&o.width)||200;el.appendChild(c)};window.QRCode.CorrectLevel={M:0};');
    return;
  }
  if (url.pathname === '/api/status') {
    statusRequests++;
    if (holdStatus) hold(request, response, heldStatus);
    else sendJSON(response, statusBody);
    return;
  }
  if (url.pathname === '/api/feed') {
    const tag = currentFeedTag();
    const requestTag = request.headers['if-none-match'] || '';
    feedRequests.push({ wait: url.searchParams.get('wait') === '1', tag: requestTag });
    if (url.searchParams.get('wait') === '1' && requestTag === tag) {
      hold(request, response, heldFeeds);
    } else {
      sendJSON(response, feedBody, { ETag: tag });
    }
    return;
  }
  if (url.pathname.endsWith('.png')) {
    response.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': pixel.length });
    response.end(pixel);
    return;
  }
  response.writeHead(404);
  response.end();
});

function waitFor(check, message, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const inspect = () => {
      if (check()) { resolve(); return; }
      if (Date.now() >= deadline) { reject(new Error(message)); return; }
      setTimeout(inspect, 20);
    };
    inspect();
  });
}

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});

let browser;
try {
  const address = server.address();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });

  await page.goto(`http://127.0.0.1:${address.port}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() =>
    document.querySelector('#qr canvas') &&
    document.querySelector('#linkPrompt .promptqr canvas') &&
    document.querySelector('#reactBar .react') &&
    document.querySelector('#collage .tile img'),
  );
  await waitFor(() => heldFeeds.length === 1,
    'the wall did not park its relay feed poll with the current ETag');

  assert.equal(feedRequests[1]?.tag, '"feed-1"',
    'the wall must echo the relay feed ETag on its long poll');
  assert.equal(feedRequests.length, 2,
    'an unchanged relay feed must not turn into a rapid polling loop');

  await page.evaluate(() => {
    window.__stableWallNodes = {
      joinQR: document.querySelector('#qr canvas'),
      promptLink: document.querySelector('#linkPrompt a'),
      promptQR: document.querySelector('#linkPrompt .promptqr canvas'),
      reaction: document.querySelector('#reactBar .react'),
      tile: document.querySelector('#collage .tile'),
      image: document.querySelector('#collage .tile img'),
      byline: document.querySelector('#collage .tile .by'),
      titleText: document.querySelector('#eventTitle').firstChild,
      listenerText: document.querySelector('#listenerCount').firstChild,
      trackText: document.querySelector('#nowPlaying').firstChild,
    };
    window.__stableQRCount = window.__qrCreates;
  });

  // Two callers arriving together still represent one status poll. Apart from
  // avoiding overlap, this prevents an older response from overwriting a newer
  // one after the network returns them out of order.
  holdStatus = true;
  const beforeStatus = statusRequests;
  await page.evaluate(() => {
    window.__statusPair = Promise.all([pollStatus(), pollStatus()]);
  });
  await waitFor(() => heldStatus.length > 0, 'the requested status poll never started');
  await new Promise((resolve) => setTimeout(resolve, 100));
  const concurrentStatusRequests = statusRequests - beforeStatus;
  release(heldStatus, statusBody);
  holdStatus = false;
  await page.evaluate(() => window.__statusPair);
  assert.equal(concurrentStatusRequests, 1, 'concurrent status polls must share one request');

  // A feed version can change for data irrelevant to this display. The page
  // must process it without replacing every unchanged wall node and QR code.
  feedVersion++;
  release(heldFeeds, feedBody, { ETag: currentFeedTag() });
  await waitFor(() => heldFeeds.length === 1 && feedRequests.at(-1)?.tag === '"feed-2"',
    'the wall did not resume a tagged long poll after an unchanged response');

  const stable = await page.evaluate(() => {
    const before = window.__stableWallNodes;
    return {
      joinQR: before.joinQR === document.querySelector('#qr canvas'),
      promptLink: before.promptLink === document.querySelector('#linkPrompt a'),
      promptQR: before.promptQR === document.querySelector('#linkPrompt .promptqr canvas'),
      reaction: before.reaction === document.querySelector('#reactBar .react'),
      tile: before.tile === document.querySelector('#collage .tile'),
      image: before.image === document.querySelector('#collage .tile img'),
      byline: before.byline === document.querySelector('#collage .tile .by'),
      titleText: before.titleText === document.querySelector('#eventTitle').firstChild,
      listenerText: before.listenerText === document.querySelector('#listenerCount').firstChild,
      trackText: before.trackText === document.querySelector('#nowPlaying').firstChild,
      qrCount: window.__stableQRCount === window.__qrCreates,
    };
  });
  for (const [name, value] of Object.entries(stable)) {
    assert.equal(value, true, `${name} changed after unchanged wall responses`);
  }

  feedBody.nowPlaying = { title: 'Sunrise', artist: 'The Second Track' };
  feedBody.links = [{ type: 'soundcloud', url: 'https://soundcloud.com/djluna' }];
  feedBody.reactions = { fire: 3 };
  feedBody.posts[0].author = 'Jordan';
  feedVersion++;
  release(heldFeeds, feedBody, { ETag: currentFeedTag() });
  await page.waitForFunction(() =>
    document.querySelector('#nowPlaying')?.textContent === 'Sunrise - The Second Track' &&
    document.querySelector('#linkPrompt a')?.textContent === 'SoundCloud' &&
    document.querySelector('#reactBar .react')?.textContent === '🔥 3' &&
    document.querySelector('#collage .tile .by')?.textContent === '🎧 Jordan',
  );
  assert.equal(await page.evaluate(() => window.__qrCreates), 3,
    'a changed DJ link must replace only its prompt QR code');

  statusBody.event.links = feedBody.links;
  statusBody.urls = {};
  await page.evaluate(() => pollStatus());
  assert.equal(await page.locator('#qr canvas').count(), 0,
    'a vanished join URL must clear its stale QR code');
  statusBody.urls = { join: 'https://join.example/party' };
  await page.evaluate(() => pollStatus());
  await page.waitForSelector('#qr canvas');
  assert.equal(await page.evaluate(() => window.__qrCreates), 4,
    'restoring the join URL must recreate only its QR code');
  assert.deepEqual(errors, [], `wall console errors: ${errors.join(' | ')}`);
  console.log('PASS wall render stability');
} finally {
  if (browser) await browser.close();
  release(heldStatus, statusBody);
  release(heldFeeds, feedBody, { ETag: currentFeedTag() });
  await new Promise((resolve) => server.close(resolve));
}
