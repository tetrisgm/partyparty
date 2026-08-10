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

// Two parties on the account, so the seam between the frame and the picker has
// something to be wrong about. `open` records what the console asked for.
const parties = [
  { key: 'k-one', slug: 'rooftop-pop-up', handle: 'seth', title: 'Rooftop pop-up',
    url: 'https://partyparty.party/@seth/rooftop-pop-up', startsMs: 0 },
  { key: 'k-two', slug: 'basement', handle: 'seth', title: 'Basement',
    url: 'https://partyparty.party/@seth/basement', startsMs: 0 },
];
let current = 'k-one';
const opened = [];

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
  if (url.pathname === '/api/parties') {
    return sendJSON(response, { linked: true, current, parties });
  }
  if (url.pathname === '/api/party/open') {
    let raw = '';
    request.on('data', (c) => { raw += c; });
    request.on('end', () => {
      const key = (JSON.parse(raw || '{}').key) || '';
      opened.push(key);
      current = key;
      sendJSON(response, { party: parties.find((p) => p.key === key) || null });
    });
    return;
  }
  if (url.pathname.startsWith('/api/')) return sendJSON(response, { ok: true });
  // The night's people, served on their own - what the console shows in its
  // sidebar beside the QR.
  const railOf = parties.find((p) => url.pathname === `/@${p.handle}/${p.slug}/rail`);
  if (railOf) {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><body><aside class="rail nightpeople">${railOf.title} people</aside>`);
    return;
  }
  // Any party page, so the frame has somewhere real to go.
  const party = parties.find((p) => url.pathname === `/@${p.handle}/${p.slug}`);
  if (party) {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><title>${party.title}</title><body><h1>${party.title}</h1>`);
    return;
  }
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

  // The person's own pages, in the frame, from this same origin. It is authored
  // at /home (test-stream-contract asserts that statically) and the console
  // steers it to the night this room is running, which is checked below.
  const frame = page.locator('#webFrame');
  assert.equal(await frame.count(), 1, 'the console has no frame for the web pages');
  assert.match(
    await page.frameLocator('#webFrame').locator('h1').innerText(),
    /\S/,
    'the frame did not load a page at all',
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

  // The room and the frame are one choice. A console reopened mid-set opens on
  // the night it is running, and reading a different night in the frame moves
  // the room to it - without the two bouncing each other in a loop.
  await page.waitForFunction(
    () => document.getElementById('webFrame').contentWindow.location.pathname
      === '/@seth/rooftop-pop-up',
    null, { timeout: 10000 },
  );
  await page.evaluate(() => {
    document.getElementById('webFrame').src = '/@seth/basement';
  });
  // Reading a night in the frame is how the room learns which night it is on.
  // There is no picker to disagree with it any more - the frame IS the choice.
  await page.waitForFunction(
    () => document.getElementById('peopleFrame').getAttribute('src')
      === '/@seth/basement/rail',
    null, { timeout: 10000 },
  );
  await page.waitForTimeout(1200);
  assert.deepEqual(opened, ['k-two'],
    `the frame and the room are echoing each other: opened ${JSON.stringify(opened)}`);

  // The way home is the chip on the cover, which the page owns - the console
  // has none of its own. What it must do is keep up: no night in the frame,
  // no rail in the sidebar.
  assert.equal(await page.locator('#homeBtn').count(), 0,
    'the console has grown a second way home');
  await page.evaluate(() => { document.getElementById('webFrame').src = '/home'; });
  await page.waitForFunction(
    () => document.getElementById('peopleFrame').hidden === true,
    null, { timeout: 10000 },
  );

  // Import from Shazam. In a browser there is no app to read a library, and
  // the honest answer is the whole feature working correctly: the failure this
  // guards is a button wired into a scope where its helpers do not exist,
  // which throws and looks like a dead button.
  assert.equal(await page.locator('#shazamBtn').count(), 1, 'the Shazam import button is gone');
  await page.evaluate(() => document.getElementById('shazamBtn').click());
  await page.waitForFunction(
    () => !document.getElementById('shazamReport').hidden, null, { timeout: 5000 });
  assert.match(
    await page.locator('#shazamReport').innerText(),
    /Only the PartyParty app/,
    'the Shazam button did not say why a browser cannot do this',
  );

  // The frame must actually occupy the column. A purge of the console's dead
  // CSS once collapsed the layout, and nothing failed.
  const frameW = await page.evaluate(
    () => document.getElementById('webFrame').getBoundingClientRect().width);
  assert.ok(frameW > 300, `the frame collapsed to ${frameW}px`);

  assert.deepEqual(errors, [], 'the console threw');
  console.log('PASS dj console shell');
} finally {
  await browser.close();
  server.close();
}
