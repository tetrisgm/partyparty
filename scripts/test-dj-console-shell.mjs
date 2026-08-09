#!/usr/bin/env node
// The DJ console, exercised in a real browser.
//
// This replaces test-dj-console-saves.mjs, which typed into the console's own
// profile and link editors. Those are gone: the console now shows the person's
// real pages from the platform in a frame and adds only the room around them.
// The BUG that test existed for is not gone, though. 125.41 shipped a console
// where the hydration flag lived in one IIFE and the wiring in another, so
// every handler threw a silent ReferenceError; `node --check` passed and the
// DJ watched their typing vanish. Deleting 1000 lines of that file is exactly
// when a script can be left half-wired, so this boots the real page in a real
// browser and fails on any uncaught error.
//
// It also guards the shape: the console must NOT grow a second copy of the
// event page again. That is the whole point of the frame.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const djHTML = fs.readFileSync(path.join(root, 'web/dj.html'), 'utf8')
  .replaceAll('__PP_VERSION__', 'shell-test')
  .replaceAll('__PP_INITIAL_GUEST_URL_JSON__', '"https://party.example/"');

const statusBody = () => ({
  signedIn: true,
  appVersion: 'shell-test',
  name: 'PartyParty',
  broadcast: { state: 'idle', since: 0, device: 'mac' },
  connection: { mode: 'direct', reason: 'probe_direct', override: 'auto', reach: 'wifi' },
  urls: { join: 'https://party.example/' },
  event: { title: 'Rooftop pop-up', host: 'Seth', bio: '', avatar: '' },
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
  if (url.pathname === '/' || url.pathname === '/dj' || url.pathname === '/dj.html') {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(djHTML);
    return;
  }
  // What the frame shows. The real server fetches this from the platform; here
  // it only has to be a page, so the frame can be proven to load one.
  if (url.pathname === '/home') {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><title>Your parties</title><body><h1>Your parties</h1>');
    return;
  }
  // The QR library, as the real server serves it: without it the console
  // throws while drawing the join code, which is a real failure and not one
  // this test should manufacture.
  if (url.pathname.startsWith('/vendor/')) {
    response.writeHead(200, { 'Content-Type': 'application/javascript' });
    response.end('window.QRCode=function(){this.clear=function(){}};window.QRCode.CorrectLevel={M:0,H:2};');
    return;
  }
  if (url.pathname === '/api/status') return sendJSON(response, statusBody());
  if (url.pathname.startsWith('/api/')) return sendJSON(response, { ok: true });
  response.writeHead(404).end();
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
const page = await browser.newPage();

// Anything the page throws is a failure. This is the guard the whole file is
// for: a console that renders and quietly does nothing looks fine in a
// screenshot.
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

try {
  await page.goto(`${base}/dj`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__ppBooted === true, null, { timeout: 10000 });
  // Let the status poll run at least once: half the wiring only executes there.
  await page.waitForTimeout(1500);

  // The person's own pages, in the frame, from this same origin.
  const frame = page.locator('#webFrame');
  assert.equal(await frame.count(), 1, 'the console has no frame for the web pages');
  assert.equal(await frame.getAttribute('src'), '/home', 'the frame does not open on home');
  assert.equal(
    await page.frameLocator('#webFrame').locator('h1').innerText(),
    'Your parties',
    'the frame did not load the page',
  );

  // The room: the one thing the Mac has that the web does not.
  for (const [sel, what] of [
    ['#goCard', 'Go live'],
    ['#joinCard', 'the join code'],
    ['#device', 'the capture source'],
    ['#liveBtn', 'the Go live button'],
  ]) {
    assert.equal(await page.locator(sel).count(), 1, `the console is missing ${what}`);
  }

  // And NOT a second event page. Each of these was a console-side duplicate of
  // something the web already owned; every one of them drifted.
  for (const id of [
    'titleEdit', 'eventCoverImg', 'pubCoverFile', 'profileName', 'profileBio',
    'djComposer', 'djFeed', 'linkRows', 'eventEditPanel',
  ]) {
    assert.equal(
      await page.locator(`#${id}`).count(), 0,
      `the console has grown its own #${id} again - that belongs to the web page`,
    );
  }

  assert.deepEqual(errors, [], 'the console threw');
  console.log('PASS dj console shell');
} finally {
  await browser.close();
  server.close();
}
