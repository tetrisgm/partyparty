#!/usr/bin/env node
// partyparty web perf bench — the stack `perf` skill's "measure first, never
// guess" harness, adapted to partyparty's guest hot path (listener.html).
//
// The skill's one idea: perceived speed is intent -> visible feedback. For a
// guest that means join -> first audio, and the biggest thing in the way is
// bytes we make every phone download+parse on the critical path. This bench
// measures exactly that: how many VENDOR script bytes the listener page pulls
// on initial load, split by the player path the device actually takes.
//
//   - "apple"  : iPhone/iPad/Safari -> native <audio> HLS (useNative=true).
//                Chromium has no native HLS, so we override canPlayType + UA to
//                drive the page down the SAME branch a real iPhone takes.
//   - "chrome" : desktop/Android Chromium -> hls.js path (useNative=false).
//
// It serves the raw web/ assets (identical bytes to the Go server's serveWeb,
// which only adds a version stamp + headers) and records every /vendor/*
// request. Dev-dep only (playwright, already used by stream-e2e). No build step.
//
//   node scripts/perf-bench.mjs
//
// PASS/FAIL is not the point here — the NUMBERS are. Capture a baseline, make
// one change, re-run, keep what moves the number (per the skill).

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const WEB = path.join(ROOT, 'web');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// Minimal stand-in for the Go server: serve web/ (stamping __PP_VERSION__ like
// serveWeb) and answer any /api/* so the page doesn't error out mid-load.
function startServer() {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    let p = u.pathname;
    if (p === '/') p = '/listener.html';
    if (p === '/dj' || p === '/dj/') p = '/dj.html';
    if (p.startsWith('/api/')) {
      // Enough shape that the listener proceeds past its first poll.
      res.setHeader('content-type', 'application/json');
      if (p === '/api/status') {
        res.end(JSON.stringify({
          live: false, version: 'bench-1', title: 'Bench', listening: 0,
          llhlsRealCert: true, latencyTargetMs: 7000,
        }));
        return;
      }
      res.end('{}');
      return;
    }
    const file = path.join(WEB, p);
    if (!file.startsWith(WEB) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.statusCode = 404; res.end('nf'); return;
    }
    let body = fs.readFileSync(file);
    if (file.endsWith('.html')) {
      body = Buffer.from(body.toString().replaceAll('__PP_VERSION__', 'bench-1'));
    }
    res.setHeader('content-type', MIME[path.extname(file)] || 'application/octet-stream');
    res.end(body);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// Drive the listener page down one player path and total the /vendor/* bytes it
// pulls before/after the "join" moment.
async function measure(playwright, base, kind) {
  const iPhoneUA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
  const chromeUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';
  const browser = await playwright.chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const context = await browser.newContext({
    userAgent: kind === 'apple' ? iPhoneUA : chromeUA,
  });
  if (kind === 'apple') {
    // Make the page believe native HLS works (Chromium has none) so it takes the
    // useNative branch a real iPhone would. Everything else is unchanged.
    await context.addInitScript(() => {
      const orig = HTMLMediaElement.prototype.canPlayType;
      HTMLMediaElement.prototype.canPlayType = function (t) {
        if (/mpegurl/i.test(t)) return 'maybe';
        return orig.call(this, t);
      };
    });
  }
  const page = await context.newPage();
  const vendor = [];
  page.on('response', async (resp) => {
    const url = resp.url();
    if (!url.includes('/vendor/')) return;
    let len = Number(resp.headers()['content-length'] || 0);
    if (!len) { try { len = (await resp.body()).length; } catch {} }
    vendor.push({ url: url.replace(base, ''), bytes: len });
  });
  await page.goto(base, { waitUntil: 'networkidle', timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(600); // let any parse-time lazy loader fire
  const onLoad = vendor.reduce((a, v) => a + v.bytes, 0);
  const onLoadList = vendor.map((v) => `${v.url} ${(v.bytes / 1024).toFixed(0)}KB`).join(', ') || '(none)';

  // Now exercise the deferred "Show QR" affordance and see what it pulls. Use a
  // programmatic click: on-load overlays (engagement gate) sit above the fixed
  // Share button and would intercept a real pointer click in headless.
  const before = vendor.length;
  await page.evaluate(() => { const b = document.getElementById('shareBtn'); if (b) b.click(); }).catch(() => {});
  await page.waitForTimeout(600);
  const afterClick = vendor.slice(before);
  const clickBytes = afterClick.reduce((a, v) => a + v.bytes, 0);

  await browser.close();
  return { kind, onLoad, onLoadList, clickBytes };
}

(async () => {
  const playwright = await import('playwright');
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  const rows = [];
  for (const kind of ['apple', 'chrome']) {
    rows.push(await measure(playwright, base, kind));
  }
  server.close();

  console.log('\n=== partyparty listener vendor-byte bench ===');
  console.log('(vendor JS the guest downloads before first audio, by device path)\n');
  for (const r of rows) {
    console.log(`  ${r.kind.padEnd(7)}  on-load: ${(r.onLoad / 1024).toFixed(0).padStart(4)}KB  [${r.onLoadList}]`);
    console.log(`  ${''.padEnd(7)}  on Show-QR tap: +${(r.clickBytes / 1024).toFixed(0)}KB`);
  }
  const apple = rows.find((r) => r.kind === 'apple');
  console.log(`\n  north-star (iPhone-first) on-load vendor weight: ${(apple.onLoad / 1024).toFixed(0)}KB\n`);
})();
