#!/usr/bin/env node
// The DJ console's autosave, exercised in a real browser.
//
// 125.41 shipped a console where NO profile or link edit was ever saved: the
// hydration flag lived inside one IIFE and the autosave wiring in another, so
// every keystroke threw a silent ReferenceError inside its event handler. Unit
// tests and `node --check` both passed; the DJ typed a name, went live, and
// watched the field clear itself. Only a browser that types can catch that,
// so this test types.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const djHTML = fs.readFileSync(path.join(root, 'web/dj.html'), 'utf8')
  .replaceAll('__PP_VERSION__', 'save-test')
  .replaceAll('__PP_INITIAL_GUEST_URL_JSON__', '"https://party.example/"');
const pixel = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

// The server's stored identity. POSTs mutate it, polls report it - the same
// loop the real console runs, which is what makes a lost save visible.
const stored = { host: '', bio: '', links: [], avatar: '' };
const posts = { profile: [], links: [] };

const statusBody = () => ({
  appVersion: 'save-test',
  name: 'PartyParty',
  broadcast: { state: 'idle', since: 0, device: 'mac' },
  connection: { mode: 'direct', reason: 'probe_direct', override: 'auto', reach: 'wifi' },
  urls: { join: 'https://party.example/' },
  event: { title: '', host: stored.host, bio: stored.bio, avatar: stored.avatar },
  health: { status: 'idle', listeners: 0 },
  listeners: 0,
  roster: [],
  relay: {},
  peers: [],
  lan: { state: 'ready' },
  streamSync: {},
  schedule: {},
  latency: {},
  log: [],
});

const feedBody = () => ({
  cursor: 1,
  title: '',
  host: stored.host,
  bio: stored.bio,
  avatar: stored.avatar,
  links: stored.links,
  features: {},
  reactions: {},
  posts: [],
  ids: [],
});

function sendJSON(response, value) {
  const body = JSON.stringify(value);
  response.writeHead(200, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  response.end(body);
}

function readBody(request) {
  return new Promise((resolve) => {
    let raw = '';
    request.on('data', (chunk) => { raw += chunk; });
    request.on('end', () => {
      try { resolve(JSON.parse(raw || '{}')); } catch (error) { resolve({}); }
    });
  });
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  if (url.pathname === '/' || url.pathname === '/dj.html') {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(djHTML);
    return;
  }
  if (url.pathname === '/api/dj-profile' && request.method === 'POST') {
    const body = await readBody(request);
    posts.profile.push(body);
    if (typeof body.name === 'string' && body.name.trim()) stored.host = body.name.trim();
    if (typeof body.bio === 'string') stored.bio = body.bio;
    // Hold the FIRST save open. Moving from the name field to the bio fires a
    // save carrying only the name, and everything that goes wrong goes wrong
    // while that request is in flight: a second save can be dropped, and the
    // first one's reply can overwrite what was typed meanwhile. On a fast
    // machine the window is too small to land in, which is exactly why this
    // failed only on the build runner. Forcing it makes the guard honest
    // everywhere.
    if (posts.profile.length === 1) await new Promise((r) => setTimeout(r, 1500));
    sendJSON(response, { ok: true, name: stored.host, bio: stored.bio, avatar: stored.avatar });
    return;
  }
  if (url.pathname === '/api/event-links' && request.method === 'POST') {
    const body = await readBody(request);
    posts.links.push(body);
    stored.links = Array.isArray(body.links) ? body.links : [];
    sendJSON(response, { ok: true, links: stored.links });
    return;
  }
  if (url.pathname === '/api/status') { sendJSON(response, statusBody()); return; }
  if (url.pathname === '/api/feed') { sendJSON(response, feedBody()); return; }
  if (url.pathname === '/api/devices') { sendJSON(response, { devices: [] }); return; }
  if (url.pathname === '/api/connection-mode') { sendJSON(response, { override: 'auto', available: true }); return; }
  if (url.pathname === '/api/reach') { sendJSON(response, { reach: 'wifi', available: true }); return; }
  if (url.pathname === '/api/requests') { sendJSON(response, { requests: [] }); return; }
  if (url.pathname === '/api/time') { sendJSON(response, { t: Date.now() }); return; }
  if (request.method === 'POST') { sendJSON(response, { ok: true }); return; }
  if (url.pathname.endsWith('.png') || url.pathname.endsWith('.jpg') || url.pathname.endsWith('.webp')) {
    response.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': pixel.length });
    response.end(pixel);
    return;
  }
  if (url.pathname.startsWith('/vendor/')) {
    response.writeHead(200, { 'Content-Type': 'application/javascript' });
    response.end('window.QRCode=function(){this.clear=function(){}};window.QRCode.CorrectLevel={M:0,H:2};');
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
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

  const consoleErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(String(error)));

  await page.goto(`http://127.0.0.1:${address.port}/`, { waitUntil: 'domcontentloaded' });
  // Hydration has to land before saves arm, exactly as in production.
  await page.waitForFunction(() => window.ppProfileHydrated === true, null, { timeout: 10000 });

  // Parse the design tokens and press rule in a browser. Source regexes did
  // not catch either a missing custom-property semicolon or a dangling
  // selector comma, even though both invalidated visible console CSS.
  assert.equal(await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--tray').trim()), '4px',
  'the root design-token block did not parse through --tray');
  const settings = page.locator('#settingsBtn');
  const settingsBox = await settings.boundingBox();
  assert.ok(settingsBox, 'the settings control is not visible for press-state verification');
  await page.mouse.move(settingsBox.x + settingsBox.width / 2, settingsBox.y + settingsBox.height / 2);
  await page.mouse.down();
  const pressedTransform = await settings.evaluate((button) => getComputedStyle(button).transform);
  // Release away from the button so this style assertion does not open the
  // settings sheet and interfere with the save behavior exercised below.
  await page.mouse.move(1, 1);
  await page.mouse.up();
  assert.notEqual(pressedTransform, 'none', 'the shared active-state selector did not parse');

  // Type a name and a bio, then blur - the console's own save path.
  await page.fill('#profileName', 'DJ Luna');
  await page.fill('#profileBio', 'House music and bright rooms.');
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  await page.waitForTimeout(1200); // past the autosave debounce

  // Wait for the SAVE to arrive rather than snapshotting the last one: the
  // autosave debounce can fire between the two fills on a slow machine, so the
  // most recent POST may legitimately carry only the name.
  const savedBoth = async () => {
    for (let i = 0; i < 40; i++) {
      if (stored.host === 'DJ Luna' && stored.bio === 'House music and bright rooms.') return true;
      await page.waitForTimeout(250);
    }
    return false;
  };
  assert.ok(posts.profile.length > 0, 'typing in the profile fields never reached /api/dj-profile');
  assert.ok(await savedBoth(),
    `the server never received both fields: ${JSON.stringify(posts.profile)}`);

  // The poll must not then wipe what was just saved.
  await page.waitForTimeout(1500);
  assert.equal(await page.inputValue('#profileName'), 'DJ Luna', 'a poll cleared the saved name');
  assert.equal(await page.inputValue('#profileBio'), 'House music and bright rooms.', 'a poll cleared the saved bio');

  // Enter commits the bio instead of inserting a line break.
  await page.click('#profileBio');
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  const bioAfterEnter = await page.inputValue('#profileBio');
  assert.ok(!bioAfterEnter.includes('\n'), `Enter inserted a line break: ${JSON.stringify(bioAfterEnter)}`);

  // Accounts were removed from the product. Keep this browser test honest: a
  // status response with no account field must leave the local console usable,
  // and no legacy sign-in door may return unnoticed.
  assert.equal(await page.locator('#macDoor,.macssobtn').count(), 0,
    'the account-era sign-in door returned');

  assert.deepEqual(consoleErrors, [], `console errors: ${consoleErrors.join(' | ')}`);
  console.log('PASS dj console saves');
} finally {
  if (browser) await browser.close();
  server.close();
}
