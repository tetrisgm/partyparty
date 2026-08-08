#!/usr/bin/env node
// The sign-in door, clicked.
//
// Build 268 shipped a door whose "Continue with Apple" button opened nothing at
// all. It called window.open, and inside the console's WKWebView window.open
// reaches the app's WKUIDelegate - which did not implement
// createWebViewWith, so it returned null in silence. No window, no error, no
// console message. The door then said "Finish in the browser - this opens by
// itself when you are done" about a browser that had never opened, and sat
// there for five minutes.
//
// Nothing catches that except clicking the button and checking where the URL
// went. `node --check` passes, unit tests pass, and a screenshot of the door
// looks perfect.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const djHTML = fs.readFileSync(path.join(root, 'web/dj.html'), 'utf8')
  .replaceAll('__PP_VERSION__', 'signin-test')
  .replaceAll('__PP_INITIAL_GUEST_URL_JSON__', '"https://party.example/"');

const LINK = 'https://partyparty.party/link/AB12CD';
// Signed out, which is the whole point: the door is what an unpaired Mac shows.
let signedIn = false;

const statusBody = () => ({
  signedIn,
  appVersion: 'signin-test',
  name: 'PartyParty',
  broadcast: { state: 'idle', since: 0, device: 'mac' },
  connection: { mode: 'direct', reason: 'probe_direct', override: 'auto', reach: 'wifi' },
  urls: { join: 'https://party.example/' },
  event: { title: '', host: '', bio: '', avatar: '' },
  health: { status: 'idle', listeners: 0 },
  listeners: 0, roster: [], relay: {}, peers: [],
  lan: { state: 'ready' }, streamSync: {}, schedule: {}, latency: {}, log: [],
});

const sendJSON = (res, value) => {
  const body = JSON.stringify(value);
  res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/' || url.pathname === '/dj' || url.pathname === '/dj.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(djHTML);
    return;
  }
  if (url.pathname.startsWith('/vendor/')) {
    res.writeHead(200, { 'Content-Type': 'application/javascript' });
    res.end('window.QRCode=function(){this.clear=function(){}};window.QRCode.CorrectLevel={M:0,H:2};');
    return;
  }
  if (url.pathname === '/api/status') return sendJSON(res, statusBody());
  if (url.pathname === '/api/sign-in-link') return sendJSON(res, { ok: true, linked: false, url: LINK });
  if (url.pathname === '/api/sign-in-check') return sendJSON(res, { signedIn });
  if (url.pathname === '/api/feed') return sendJSON(res, { cursor: 1, posts: [], ids: [], links: [], features: {}, reactions: {} });
  sendJSON(res, {});
});

const listening = new Promise((r) => server.listen(0, '127.0.0.1', r));
await listening;
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch();
const page = await browser.newPage();

const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

// Stand in for the app: the pp bridge, recording what Swift would have been
// asked to open. A real WKWebView is the only place the bug reproduces, but the
// console's half of the contract is "hand the URL to the bridge", and that is
// exactly what regressed.
const opened = [];
await page.exposeFunction('__ppBridge', (msg) => { opened.push(msg); });
await page.addInitScript(() => {
  window.ppNative = true;
  window.webkit = { messageHandlers: { pp: { postMessage: (m) => window.__ppBridge(m) } } };
  // If anything reaches for window.open, record that instead of letting it
  // quietly appear to work - in the app it returns null and does nothing.
  window.__windowOpened = [];
  window.open = (u) => { window.__windowOpened.push(u); return null; };
});

await page.goto(`${base}/dj`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.macdoor:not([hidden]) .macssobtn', { timeout: 10000 });

await page.click('.macssobtn[data-provider="apple"]');
// Wait for the OUTCOME, not for the status line to be non-empty: the click
// sets "Opening your browser…" synchronously, before the link has even been
// fetched. Asserting at that moment passes on a fast machine and fails on the
// build runner, which is how this test failed its own first merge gate.
await page.waitForFunction(
  () => /Finish in the browser|could not open/.test(
    document.getElementById('macDoorSays')?.textContent || ''),
  null, { timeout: 10000 });

const says = (await page.textContent('#macDoorSays'))?.trim();
const viaWindowOpen = await page.evaluate(() => window.__windowOpened);

assert.equal(errors.length, 0, `console errors: ${errors.join(' | ')}`);
// The bridge also carries ready/jslog/permissions; only the open matters here.
const opens = opened.filter((m) => m && m.action === 'openURL');
assert.equal(opens.length, 1, `openURL sent ${opens.length} times, want 1`);
assert.ok(opens[0].url.startsWith(LINK),
  `the pairing link never reached the app: ${opens[0].url}`);
assert.ok(opens[0].url.includes('with=apple'), 'the provider must ride along');
assert.deepEqual(viaWindowOpen, [],
  'window.open is a no-op inside the console WKWebView; the bridge is the only way out');
assert.match(says, /Finish in the browser/,
  `the door should say it is waiting once the link is away, got: ${says}`);

// And the door must not claim a browser opened when nothing could open one.
// Without the bridge, window.open answering null is a failure, not a success.
const bare = await browser.newPage();
const bareErrors = [];
bare.on('pageerror', (e) => bareErrors.push(String(e)));
await bare.addInitScript(() => { window.open = () => null; });
await bare.goto(`${base}/dj`, { waitUntil: 'domcontentloaded' });
await bare.waitForSelector('.macdoor:not([hidden]) .macssobtn', { timeout: 10000 });
await bare.click('.macssobtn[data-provider="apple"]');
await bare.waitForFunction(
  () => /could not open|partyparty\.party\/link/.test(document.getElementById('macDoorSays')?.textContent || ''),
  null, { timeout: 5000 });
const bareSays = (await bare.textContent('#macDoorSays'))?.trim();
assert.ok(!/opens by itself/.test(bareSays),
  `nothing opened, so the door must not promise it did: ${bareSays}`);
assert.equal(bareErrors.length, 0, `console errors: ${bareErrors.join(' | ')}`);

await browser.close();
server.close();
console.log('PASS dj console sign-in opens the browser');
