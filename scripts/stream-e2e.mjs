#!/usr/bin/env node
// Browser guest stream E2E:
// - runs the real dev partyparty-server with device=test, LL-HLS, and a
//   throwaway cert on throwaway ports (use --mock only when explicitly testing
//   the browser harness itself);
// - drives the real listener.html in headless Chromium and proves media fetch,
//   buffering, playback progress, and non-zero WebAudio RMS.

import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The stack bring-up lives in scripts/lib/real-stack.mjs so that this suite and
// scripts/soak-lab.mjs measure the SAME server, proxy and muxer. A second copy
// would drift, and a harness that has drifted from the thing it measures is
// how a pre-upload receipt ends up describing a playlist no guest receives.
import {
  ROOT, log, sleep, fail, isExecutable, helperPath, run, startProcess,
  registerCleanup, cleanup, freePort, freePorts, waitFor, fetchJSON, getInsecure,
  generateCert, linkOrCopy, startRealStack, killRealPublisher,
} from './lib/real-stack.mjs';

const __filename = fileURLToPath(import.meta.url);
const KEEP_WORK = process.argv.includes('--keep-work') || process.env.PP_E2E_KEEP_WORK === '1';
const FORCE_MOCK = process.argv.includes('--mock') || process.env.PP_E2E_FORCE_MOCK === '1';
const SCENARIO_ARG = process.argv.find((a) => a.startsWith('--scenario='));
const SCENARIO = SCENARIO_ARG ? SCENARIO_ARG.split('=')[1] : 'all';
const ENGINE_ARG = process.argv.find((a) => a.startsWith('--engine='));
const ENGINE = ENGINE_ARG ? ENGINE_ARG.split('=')[1] : 'chromium';

let failures = [];

// The shipping playlist shape, asserted against the real /live path.
//
// THESE TWO ASSERTIONS USED TO REQUIRE THE OPPOSITE. One failed on any
// EXT-X-START in the multivariant and the other failed on PART-HOLD-BACK >=
// 0.75, while internal/schedule has emitted
// EXT-X-START:TIME-OFFSET=-3.000,PRECISE=YES and rewritten hold-back to 0.90000
// since 2026-08-05. No shipping build could pass them. They never fired because
// this file is not in `npm test` (package.json exposes it as stream:e2e only),
// so the repository carried two checks that asserted the absence of the thing
// it ships and called the suite green.
async function assertShippingPlaylistShape(stack) {
  const mvUrl = `https://127.0.0.1:${stack.tlsPort}/live/party/index.m3u8`;
  const mv = await getInsecure(mvUrl);
  const pin = /^#EXT-X-START:.*$/m.exec(mv.body || '')?.[0];
  if (pin !== '#EXT-X-START:TIME-OFFSET=-2.000,PRECISE=YES') {
    fail(`multivariant playlist must carry the room's attachment pin, got ${pin || 'nothing'}:\n${(mv.body || '').slice(0, 300)}`);
  }
  log('PASS multivariant playlist carries the declared attachment pin');

  const variant = mv.body.split(/\r?\n/).find((line) => line && !line.startsWith('#'));
  if (!variant) fail(`multivariant playlist has no media variant:\n${mv.body.slice(0, 300)}`);
  const mediaUrl = new URL(variant, mvUrl).href;
  const media = await getInsecure(mediaUrl, 5000, 5, mv.cookie);
  const part = Number(/PART-TARGET=([0-9.]+)/.exec(media.body || '')?.[1]);
  const holdback = Number(/PART-HOLD-BACK=([0-9.]+)/.exec(media.body || '')?.[1]);
  if (!(part > 0) || !(holdback > part)) {
    fail(`media playlist is not low latency: part=${part} holdback=${holdback}\n${(media.body || '').slice(0, 500)}`);
  }
  // schedule.PartHoldBack is the floor, and setPartHoldBack never LOWERS a
  // higher upstream value, so the shipped playlist is at or above it.
  if (!(holdback >= 0.6 - 1e-9)) {
    fail(`media playlist hold-back ${holdback} is below the declared 0.6 floor:\n${(media.body || '').slice(0, 500)}`);
  }
  // The room's attachment point is authored in the MULTIVARIANT playlist. In the
  // media playlist, without PRECISE, it once measured 25.00s from the edge: the
  // offset applied from the wrong end. It must not appear here.
  if (/#EXT-X-START:/.test(media.body || '')) {
    fail(`media playlist must not carry EXT-X-START:\n${(media.body || '').slice(0, 500)}`);
  }
  log(`PASS media playlist is low latency at the declared hold-back floor: ${holdback.toFixed(3)}s`);
}

function mimeFor(file) {
  if (file.endsWith('.html')) return 'text/html; charset=utf-8';
  if (file.endsWith('.js')) return 'application/javascript; charset=utf-8';
  if (file.endsWith('.css')) return 'text/css; charset=utf-8';
  if (file.endsWith('.png')) return 'image/png';
  if (file.endsWith('.svg')) return 'image/svg+xml';
  return 'application/octet-stream';
}

async function startMockStack(rootWork, ffmpeg, mediamtx) {
  // --mock exists to test the browser harness itself. It serves a playlist this
  // repository authored, so it proves nothing about the shipping one; that is
  // why assertShippingPlaylistShape runs only on the real stack.
  const workDir = path.join(rootWork, 'mock');
  await fs.mkdir(workDir, { recursive: true });
  const [webPort, rtspPort, hlsPort] = await freePorts(3);
  const { cert, key } = await generateCert(workDir);
  const mtxConfig = path.join(workDir, 'mtx.yml');
  const streamUrl = `https://127.0.0.1:${hlsPort}/party/index.m3u8`;
  await fs.writeFile(mtxConfig, `logLevel: info
api: no
rtmp: no
srt: no
webrtc: no
rtsp: yes
rtspAddress: 127.0.0.1:${rtspPort}
rtspTransports: [tcp]
hls: yes
hlsAddress: :${hlsPort}
hlsEncryption: yes
hlsServerCert: ${cert}
hlsServerKey: ${key}
hlsVariant: lowLatency
hlsAlwaysRemux: yes
hlsSegmentCount: 48
hlsSegmentDuration: 500ms
hlsPartDuration: 150ms
hlsAllowOrigins: ['*']
authInternalUsers:
- user: any
  pass:
  permissions:
  - action: publish
  - action: read
paths:
  party:
`, 'utf8');

  const mtx = startProcess('mock-mediamtx', mediamtx, [mtxConfig], {
    cwd: workDir,
    logPath: path.join(workDir, 'mediamtx.log'),
  });
  await sleep(1500);

  let mockStartedAt = Date.now();
  let mockLive = true;
  let mockReady = true;
  let pub = startMockPublisher(workDir, ffmpeg, rtspPort);

  const web = http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url || '/', `http://127.0.0.1:${webPort}`);
      if (u.pathname === '/api/status') {
        sendJSON(res, {
          name: 'PartyParty E2E',
          appVersion: 'e2e',
          broadcast: {
            state: mockLive ? 'live' : 'idle',
            since: mockStartedAt,
            device: 'test',
            deviceName: 'Test tone (440 Hz)',
            bitrate: '320k',
            channels: 2,
            segDur: 0.5,
            sampleRate: 48000,
          },
          listeners: 1,
          listenersTotal: 1,
          llhlsUrl: streamUrl,
          llhlsAvailable: true,
          llhlsRealCert: true,
          latencyTarget: 2.0,
          streamSync: {
            generation: mockStartedAt,
            ready: mockLive && mockReady,
            checking: mockLive && !mockReady,
            publishing: mockLive,
            playlist: `mock-${mockStartedAt}_audio.m3u8`,
            realHistory: mockReady ? 4 : 0,
            gapHistory: mockReady ? 14 : 2,
            partHoldBack: 0.513,
            partTarget: 0.171,
          },
          health: {},
          urls: { primary: `http://127.0.0.1:${webPort}/`, ip: '127.0.0.1', port: webPort, interfaces: [] },
        });
        return;
      }
      if (u.pathname === '/api/time') {
        const received = Date.now();
        const sent = Date.now();
        sendJSON(res, { t: sent, received, sent });
        return;
      }
      if (u.pathname === '/api/heartbeat') {
        sendJSON(res, { ok: true });
        return;
      }
      if (u.pathname === '/api/client-events' || u.pathname === '/api/guest-profile') {
        req.resume();
        sendJSON(res, { ok: true });
        return;
      }
      if (u.pathname === '/api/feed') {
        sendJSON(res, { error: 'no event store' }, 404);
        return;
      }
      const rel = u.pathname === '/' ? 'listener.html' : u.pathname.replace(/^\/+/, '');
      const safeRel = path.normalize(rel).replace(/^(\.\.[/\\])+/, '');
      const file = path.join(ROOT, 'web', safeRel);
      if (!file.startsWith(path.join(ROOT, 'web'))) {
        res.writeHead(403);
        res.end('forbidden');
        return;
      }
      let data = await fs.readFile(file);
      if (file.endsWith('.html')) data = Buffer.from(data.toString('utf8').replaceAll('__PP_VERSION__', 'e2e'));
      res.writeHead(200, { 'Content-Type': mimeFor(file), 'Cache-Control': 'no-store' });
      res.end(data);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('not found');
    }
  });
  await new Promise((resolve) => web.listen(webPort, '127.0.0.1', resolve));
  registerCleanup(() => new Promise((resolve) => web.close(resolve)));

  await waitFor(async () => {
    const r = await getInsecure(streamUrl, 3000);
    return r.status === 200 && r.body.includes('#EXTM3U');
  }, { timeoutMs: 20000, label: 'mock LL-HLS manifest' });

  return {
    mode: 'mock',
    workDir,
    pageUrl: `http://127.0.0.1:${webPort}/?debug=1`,
    streamUrl,
    hlsPort,
    setRoomState({ live = mockLive, ready = mockReady } = {}) {
      if (live && !mockLive) mockStartedAt = Date.now();
      mockLive = live;
      mockReady = ready;
    },
    async restartPublisher() {
      log('>> resilience: killing mock ffmpeg publisher and restarting it');
      mockLive = false;
      mockReady = false;
      await pub.stop('SIGKILL');
      await sleep(1000);
      mockStartedAt = Date.now();
      pub = startMockPublisher(workDir, ffmpeg, rtspPort);
      await waitFor(async () => {
        const r = await getInsecure(streamUrl, 3000);
        return r.status === 200 && r.body.includes('#EXTM3U');
      }, { timeoutMs: 20000, label: 'mock restarted manifest' });
      mockLive = true;
      mockReady = true;
    },
    logs() {
      return [mtx.lines.slice(-20).join('\n'), pub.lines.slice(-20).join('\n')].filter(Boolean).join('\n');
    },
  };
}

function startMockPublisher(workDir, ffmpeg, rtspPort) {
  return startProcess('mock-ffmpeg-publisher', ffmpeg, [
    '-hide_banner', '-loglevel', 'warning', '-progress', path.join(workDir, 'progress.txt'),
    '-re', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-vn', '-ac', '2', '-ar', '48000', '-c:a', 'aac', '-b:a', '320k',
    '-f', 'tee', '-map', '0:a',
    `[f=rtsp:rtsp_transport=tcp:onfail=ignore:use_fifo=1:fifo_options=drop_pkts_on_overflow=1]rtsp://127.0.0.1:${rtspPort}/party|[f=adts:onfail=ignore:use_fifo=1:fifo_options=drop_pkts_on_overflow=1]${path.join(workDir, 'rec.aac')}`,
  ], {
    cwd: workDir,
    logPath: path.join(workDir, `publisher-${Date.now()}.log`),
  });
}

function sendJSON(res, body, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function ensurePlaywright() {
  try {
    return await import('playwright');
  } catch (err) {
    if (err && (err.code === 'ERR_MODULE_NOT_FOUND' || String(err.message || '').includes('Cannot find package'))) {
      log('>> installing npm dependencies for Playwright');
      await run('npm', ['install', '--no-audit', '--no-fund'], { cwd: ROOT, timeoutMs: 180000 });
      return await import('playwright');
    }
    throw err;
  }
}

async function ensureEngine(playwright, engine) {
  const browserType = playwright[engine];
  if (!browserType) fail(`unknown browser engine ${engine}; use chromium or webkit`);
  const exe = browserType.executablePath();
  if (existsSync(exe)) return;
  log(`>> installing Playwright ${engine}`);
  await run('npx', ['playwright', 'install', engine], { cwd: ROOT, timeoutMs: 240000 });
}

function streamMatcher(stack) {
  const expected = new URL(stack.streamUrl);
  return (raw) => {
    try {
      const u = new URL(raw);
      return u.protocol === expected.protocol && u.hostname === expected.hostname && u.port === expected.port && u.pathname.endsWith('.m3u8');
    } catch {
      return false;
    }
  };
}

async function createGuestSession(stack, browser, opts = {}) {
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: opts.viewport || { width: 390, height: 844 },
  });
  if (opts.disableStartDate) {
    await context.addInitScript(() => {
      try {
        Object.defineProperty(HTMLMediaElement.prototype, 'getStartDate', {
          configurable: true,
          value: () => new Date(NaN),
        });
      } catch {}
    });
  }
  const page = await context.newPage();
  const consoleLines = [];
  const requestFailures = [];
  const pageErrors = [];
  const requests = [];
  page.on('console', (msg) => {
    const text = msg.text();
    if (msg.type() === 'error' || text.includes('E2E') || text.includes('error')) {
      consoleLines.push(`${msg.type()}: ${text}`);
      if (consoleLines.length > 40) consoleLines.shift();
    }
  });
  page.on('pageerror', (err) => pageErrors.push(String(err.stack || err.message || err)));
  if (process.env.PP_E2E_TIMING_TRACE === '1') {
    const traceFile = path.join(stack.workDir, `timing-${Date.now()}.jsonl`);
    page.on('console', msg => {
      const text = msg.text();
      if (text.startsWith('E2E-TIMING ')) fs.appendFile(traceFile,text.slice(11)+'\n').catch(()=>{});
    });
    await page.addInitScript(() => {
      setInterval(() => {
        if (typeof hls==='undefined' || !hls || typeof started==='undefined' || !started) return;
        const p=document.getElementById('player'), f=hls.streamController?.currentFrag;
        console.log('E2E-TIMING '+JSON.stringify({wall:Date.now(),lat:measureLatency(),position:p.currentTime,
          muted:p.muted,rate:p.playbackRate,seeking:p.seeking,ready:p.readyState,
          pdt:hls.playingDate?.getTime(),sn:f?.sn,start:f?.start,fragPdt:f?.programDateTime,
          ac:window.__ppE2ETap?.ac.currentTime,acRate:window.__ppE2ETap?.ac.sampleRate}));
      },100);
    });
  }
  page.on('requestfailed', (req) => {
    const url = req.url();
    if (url.includes('/api/') || url.includes('/party/')) {
      requestFailures.push(`${req.failure()?.errorText || 'failed'} ${url}`);
      if (requestFailures.length > 40) requestFailures.shift();
    }
  });

  const matchesStream = streamMatcher(stack);
  page.on('request', (req) => {
    const url = req.url();
    if (matchesStream(url)) requests.push({ t: Date.now(), url });
    if (requests.length > 200) requests.splice(0, requests.length - 200);
  });

  return { context, page, consoleLines, requestFailures, pageErrors, requests, matchesStream };
}

async function assertGuestActions(page) {
  if (!(await page.locator('#composer').isVisible())) fail('guest identity/comment composer is not visible');

  await page.locator('#qrBtn').click();
  await page.waitForFunction(() => {
    const root = document.getElementById('qrShare');
    return root && (root.querySelector('canvas') || root.querySelector('img'));
  }, { timeout: 5000 });
  // Count MODULES against BACKGROUND, not dark pixels against light ones.
  //
  // This used to classify a pixel as a module only when r+g+b < 200, which is
  // near-black. The symbol is deliberately drawn in the brand pink #ff2d6f,
  // whose channels sum to 411: neither "dark" nor "light" by those thresholds.
  // A perfectly good QR therefore reported dark:0 and was called blank. The
  // check could not pass on any shipping build, and never ran, because two
  // earlier assertions in this file failed first.
  const qr = await page.evaluate(() => {
    const root = document.getElementById('qrShare');
    const canvas = root && root.querySelector('canvas');
    if (canvas) {
      const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      let module = 0, background = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i] + data[i + 1] + data[i + 2] > 700) background++;
        else module++;
      }
      const total = module + background;
      return { kind: 'canvas', width: canvas.width, height: canvas.height, module, background, total };
    }
    const img = root && root.querySelector('img');
    return img ? { kind: 'img', width: img.naturalWidth, height: img.naturalHeight, src: img.src.slice(0, 16) } : null;
  });
  if (!qr || qr.width < 200 || qr.height < 200) {
    fail(`guest share QR is missing or too small to scan: ${JSON.stringify(qr)}`);
  }
  if (qr.kind === 'canvas') {
    // A real symbol is a mix. All background is a blank canvas; nearly all
    // module is a solid block, which is what a badge painted over the whole
    // code would look like.
    const filled = qr.module / qr.total;
    if (!(filled > 0.05 && filled < 0.8)) {
      fail(`guest share QR is not a symbol: ${(filled * 100).toFixed(1)}% of pixels are modules ${JSON.stringify(qr)}`);
    }
  }
  await page.locator('#qrClose').click();

  await page.locator('#ctext').fill('party comment');
  await page.locator('#cfiles').setInputFiles([
    { name: 'photo.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlOcAAAAASUVORK5CYII=', 'base64') },
    { name: 'clip.mov', mimeType: 'video/quicktime', buffer: Buffer.from('original-video-bytes') },
  ]);
  await page.waitForFunction(() => document.querySelectorAll('#pendingPreviews .pendingfile').length === 2);
  const previews = await page.evaluate(() => ({
    total: document.querySelectorAll('#pendingPreviews .pendingfile').length,
    photos: document.querySelectorAll('#pendingPreviews .pendingfile img').length,
    videos: document.querySelectorAll('#pendingPreviews .pendingfile.video .videocover').length,
    claims: document.querySelectorAll('#claimOv,[id*="keepsake"]').length,
  }));
  if (previews.total !== 2 || previews.photos !== 1 || previews.videos !== 1 || previews.claims !== 0) {
    fail(`guest composer preview/claim state is wrong: ${JSON.stringify(previews)}`);
  }
  const layout = await page.evaluate(() => {
    const composer = document.getElementById('composer').getBoundingClientRect();
    const tray = document.getElementById('listenBar').getBoundingClientRect();
    return {
      viewport: innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      composer: { left: composer.left, right: composer.right, top: composer.top, bottom: composer.bottom },
      tray: { left: tray.left, right: tray.right, top: tray.top, bottom: tray.bottom },
    };
  });
  if (layout.scrollWidth > layout.viewport + 1 || layout.composer.left < layout.tray.left - 1 || layout.composer.right > layout.tray.right + 1 || layout.composer.top < layout.tray.top - 1 || layout.composer.bottom > layout.tray.bottom + 1) {
    fail(`guest mobile controls overflow or overlap: ${JSON.stringify(layout)}`);
  }
  if (process.env.PP_E2E_SCREENSHOT) {
    await page.screenshot({ path: process.env.PP_E2E_SCREENSHOT, fullPage: false });
  }
  log(`PASS browser guest actions: QR=${qr.width}x${qr.height} composer=visible previews=2 keepsake=absent`);
}

async function driveGuest(stack, label, browser, session = null, opts = {}) {
  let ownSession = false;
  let joinStartedAt = 0;
  if (!session) {
    session = await createGuestSession(stack, browser, opts);
    ownSession = true;
  }
  const { context, page, consoleLines, requestFailures, pageErrors, requests, matchesStream } = session;
  const manifestSince = opts.manifestSince || Date.now();
  try {
    if (ownSession) {
      await page.goto(stack.pageUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForSelector('#player', { state: 'attached', timeout: 10000 });
      // Connect the measurement sink before alignment. Creating a WebAudio
      // graph halfway through synchronized playback changes the output route.
      if (ENGINE !== 'webkit') await prepareAudioTap(page);
      joinStartedAt = await startGuestPlayback(page);
    }

    const manifestUrl = await waitFor(() => {
      const hit = requests.find((r) => r.t >= manifestSince && matchesStream(r.url));
      return hit && hit.url;
    }, { timeoutMs: 15000, label: 'LL-HLS manifest fetch' });
    const media = await waitForMediaReady(page, 25000);
    const joinMs = joinStartedAt ? Date.now() - joinStartedAt : 0;
    // Playwright WebKit does not expose iPhone's valid native-HLS getStartDate
    // bridge, so it proves native playback continuity but not PDT measurement.
    const joinBudget = ENGINE === 'webkit' ? 15500 : 12800;
    if (joinMs > joinBudget) fail(`muted startup exceeded the ${joinBudget}ms product budget: ${joinMs}ms`);
    const progress = await assertPlaybackProgress(page);
    const clientPlatform = await page.evaluate(() => typeof platform === 'string' ? platform : 'unknown');
    if (ENGINE === 'webkit' && clientPlatform !== 'native') {
      fail(`WebKit did not select the native HLS path (got ${clientPlatform})`);
    }
    // Playwright WebKit's headless output is silent to WebAudio even while its
    // native media element is buffered and advancing. Chromium remains the
    // decoded-audio/RMS proof; WebKit proves the native Safari code path.
    const audio = ENGINE === 'webkit' ? { skipped: true } : await assertAudioRMS(page);

    if (ownSession && opts.checkActions !== false && stack.mode !== 'mock') await assertGuestActions(page);

    const audioResult = audio.skipped ? 'native-media=advancing' : `rms=${audio.rmsMean.toFixed(5)} max=${audio.rmsMax.toFixed(5)}`;
    log(`PASS browser ${label}: platform=${clientPlatform} join=${joinMs}ms manifest=${manifestUrl} readyState=${media.readyState} bufferedEnd=${media.bufferedEnd.toFixed(2)}s delta=${progress.delta.toFixed(2)}s ${audioResult}`);
    if (ownSession && !opts.keepOpen) await context.close();
    return { session, manifestUrl, media, progress, audio };
  } catch (err) {
    const state = await page.evaluate(() => {
      const p = document.getElementById('player');
      if (!p) return null;
      let buffered = [];
      try {
        for (let i = 0; i < p.buffered.length; i++) buffered.push([p.buffered.start(i), p.buffered.end(i)]);
      } catch {}
      return {
        paused: p.paused,
        muted: p.muted,
        readyState: p.readyState,
        currentTime: p.currentTime,
        src: p.currentSrc || p.src,
        buffered,
        btn: document.getElementById('btnlabel')?.textContent,
        status: document.getElementById('pilltext')?.textContent,
      };
    }).catch(() => null);
    const detail = [
      `Browser ${label} failed: ${err.message}`,
      state ? `state=${JSON.stringify(state)}` : '',
      pageErrors.length ? `pageErrors:\n${pageErrors.slice(-8).join('\n')}` : '',
      requestFailures.length ? `requestFailures:\n${requestFailures.slice(-12).join('\n')}` : '',
      consoleLines.length ? `console:\n${consoleLines.slice(-12).join('\n')}` : '',
      stack.logs ? `stack logs:\n${stack.logs()}` : '',
    ].filter(Boolean).join('\n');
    await context.close().catch(() => {});
    fail(detail);
  }
}

async function assertReadinessGate(stack, browser) {
  if (typeof stack.setRoomState !== 'function') return;
  stack.setRoomState({ live: false, ready: false });
  const session = await createGuestSession(stack, browser, { checkActions: false });
  const { context, page, requests } = session;
  try {
    await page.goto(stack.pageUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForSelector('#player', { state: 'attached', timeout: 10000 });
    await page.waitForFunction(() => typeof live === 'boolean' && !live && !streamReady && !attached);
    await sleep(3200);
    if (requests.length) fail(`idle guest fetched HLS before publication: ${JSON.stringify(requests)}`);

    stack.setRoomState({ live: true, ready: false });
    await page.waitForFunction(() => live && !streamReady && !attached && /preparing/i.test(document.getElementById('btnlabel')?.textContent || ''), null, { timeout: 8000 });
    await sleep(3200);
    if (requests.length) fail(`guest fetched HLS while the playlist contained insufficient real history: ${JSON.stringify(requests)}`);

    stack.setRoomState({ live: true, ready: true });
    await page.waitForFunction(() => streamReady && ready && !document.getElementById('btn').classList.contains('preparing'), null, { timeout: 15000 });
    await page.locator('#btn').click({ timeout: 5000 });
    await waitForMediaReady(page, 25000);
    log('PASS browser readiness gate: no HLS attach while idle/GAP-only; current generation became audible after ready');
  } finally {
    stack.setRoomState({ live: true, ready: true });
    await context.close().catch(() => {});
  }
}

async function startGuestPlayback(page) {
  const welcome = page.locator('#welGo');
  try {
    await welcome.waitFor({ state: 'visible', timeout: 3000 });
    const startedAt = Date.now();
    await welcome.click({ timeout: 5000 });
    return startedAt;
  } catch {}

  await page.waitForFunction(() => {
    const btn = document.getElementById('btn');
    const label = document.getElementById('btnlabel')?.textContent || '';
    return btn && !btn.classList.contains('preparing') && /tap to listen|resume/i.test(label);
  }, { timeout: 15000 });
  const startedAt = Date.now();
  await page.locator('#btn').click({ timeout: 5000 });
  return startedAt;
}

async function waitForMediaReady(page, timeoutMs) {
  const handle = await page.waitForFunction(() => {
    const p = document.getElementById('player');
    if (!p) return false;
    let bufferedEnd = 0;
    try {
      if (p.buffered.length) bufferedEnd = p.buffered.end(0);
    } catch {}
    if (!p.paused && !p.muted && p.readyState >= 3 && bufferedEnd > 3) {
      return { readyState: p.readyState, bufferedEnd, currentTime: p.currentTime, muted: p.muted };
    }
    return false;
  }, { timeout: timeoutMs, polling: 200 });
  return await handle.jsonValue();
}

async function assertPlaybackProgress(page) {
  await sleep(1200);
  for (let attempt = 0; attempt < 2; attempt++) {
    const samples = await page.evaluate(async () => {
      const p = document.getElementById('player');
      const out = [];
      for (let i = 0; i < 9; i++) {
        out.push({ t: performance.now(), currentTime: p.currentTime, paused: p.paused, readyState: p.readyState });
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      return out;
    });
    const delta = samples.at(-1).currentTime - samples[0].currentTime;
    const backwards = samples.some((s, i) => i > 0 && s.currentTime + 0.25 < samples[i - 1].currentTime);
    const paused = samples.some((s) => s.paused);
    if (!paused && !backwards && delta >= 2.5) {
      return { samples, delta };
    }
    if (attempt === 0) await sleep(1000);
    else fail(`playback did not advance monotonically enough: delta=${delta.toFixed(2)} paused=${paused} backwards=${backwards} samples=${JSON.stringify(samples)}`);
  }
}

async function prepareAudioTap(page) {
  return await page.evaluate(async () => {
    const p = document.getElementById('player');
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return { ok: false, reason: 'AudioContext unavailable' };
    if (!window.__ppE2ETap) {
      const ac = new AC();
      const src = ac.createMediaElementSource(p);
      const analyser = ac.createAnalyser();
      analyser.fftSize = 2048;
      src.connect(analyser);
      analyser.connect(ac.destination);
      window.__ppE2ETap = { ac, analyser };
    }
    await window.__ppE2ETap.ac.resume();
    return {ok:true};
  });
}

async function assertAudioRMS(page) {
  const prepared = await prepareAudioTap(page);
  if (!prepared.ok) fail(prepared.reason);
  const result = await page.evaluate(async () => {
    const { ac, analyser } = window.__ppE2ETap;
    await ac.resume();
    const data = new Float32Array(analyser.fftSize);
    const rms = [];
    for (let i = 0; i < 20; i++) {
      analyser.getFloatTimeDomainData(data);
      let sum = 0;
      for (let j = 0; j < data.length; j++) sum += data[j] * data[j];
      rms.push(Math.sqrt(sum / data.length));
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const rmsMax = Math.max(...rms);
    const rmsMean = rms.reduce((a, b) => a + b, 0) / rms.length;
    return { ok: true, state: ac.state, rms, rmsMax, rmsMean };
  });
  if (!result.ok) fail(result.reason || 'WebAudio tap failed');
  if (result.state !== 'running') fail(`AudioContext state is ${result.state}, want running`);
  if (!(result.rmsMax > 0.01 && result.rmsMean > 0.005)) {
    await sleep(1000);
    const retry = await page.evaluate(async () => {
      const { analyser } = window.__ppE2ETap;
      const data = new Float32Array(analyser.fftSize);
      const rms = [];
      for (let i = 0; i < 20; i++) {
        analyser.getFloatTimeDomainData(data);
        let sum = 0;
        for (let j = 0; j < data.length; j++) sum += data[j] * data[j];
        rms.push(Math.sqrt(sum / data.length));
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return {
        rms,
        rmsMax: Math.max(...rms),
        rmsMean: rms.reduce((a, b) => a + b, 0) / rms.length,
      };
    });
    if (!(retry.rmsMax > 0.01 && retry.rmsMean > 0.005)) {
      fail(`audio RMS too low: first mean=${result.rmsMean} max=${result.rmsMax}; retry mean=${retry.rmsMean} max=${retry.rmsMax}`);
    }
    return retry;
  }
  return result;
}

async function syncState(page) {
  return await page.evaluate(() => {
    const p = document.getElementById('player');
    let latency = null;
    try { latency = typeof measureLatency === 'function' ? measureLatency() : null; } catch {}
    let ref = 'none', pdt = null, startDateValid = false;
    let seekableStart = null, seekableEnd = null;
    try { ref = typeof syncReference === 'function' ? syncReference() : 'none'; } catch {}
    try { pdt = typeof measureProgramLatency === 'function' ? measureProgramLatency() : null; } catch {}
    try {
      const d = typeof p?.getStartDate === 'function' ? p.getStartDate() : null;
      startDateValid = !!(d && Number.isFinite(d.getTime()));
    } catch {}
    try {
      if (p?.seekable?.length) {
        seekableStart = p.seekable.start(0);
        seekableEnd = p.seekable.end(p.seekable.length - 1);
      }
    } catch {}
    return {
      latency,
      pdt,
      ref,
      target: typeof roomTarget === 'function' ? roomTarget() : null,
      currentTime: p?.currentTime || 0,
      clockOffset: typeof clockOffset === 'number' ? clockOffset : null,
      paused: p?.paused ?? true,
      muted: p?.muted ?? true,
      readyState: p?.readyState || 0,
      rate: p?.playbackRate || 0,
      platform: typeof platform === 'string' ? platform : 'unknown',
      startDateValid,
      seekableStart,
      seekableEnd,
      attachGeneration: typeof attachGeneration === 'number' ? attachGeneration : null,
      audibleGeneration: typeof audibleGeneration === 'number' ? audibleGeneration : null,
      audibleSeeks: typeof audibleSeeks === 'number' ? audibleSeeks : null,
      stalls: typeof sumStalls === 'number' ? sumStalls : null,
    };
  });
}

async function injectDrift(page, seconds) {
  return await page.evaluate((delta) => {
    const p = document.getElementById('player');
    if (!p || !p.seekable.length) return null;
    const low = p.seekable.start(0) + 0.2;
    const high = p.seekable.end(p.seekable.length - 1) - 0.2;
    const before = p.currentTime;
    p.currentTime = Math.max(low, Math.min(high, before + delta));
    return { before, after: p.currentTime, requested: delta };
  }, seconds);
}

async function assertRoomSync(first, second, label = 'steady', { allowInjectedDrift = false } = {}) {
  const tolerance = 0.1;
  try {
    await waitFor(async () => {
      const states = await Promise.all([syncState(first), syncState(second)]);
      return states.every((s) => !s.paused && !s.muted && s.readyState >= 3 && Number.isFinite(s.latency) && s.ref === 'pdt')
        && Math.abs(states[0].latency - states[1].latency) <= tolerance && states;
    }, { timeoutMs: 20000, label: `both guests within the room tolerance (${label})` });
  } catch (err) {
    const states = await Promise.all([syncState(first), syncState(second)]);
    fail(`${err.message}; states=${JSON.stringify(states)}`);
  }

  const samples = [];
  for (let i = 0; i < 12; i++) {
    const [a, b] = await Promise.all([syncState(first), syncState(second)]);
    if (Number.isFinite(a.latency) && Number.isFinite(b.latency)) {
      samples.push({
        a: a.latency, b: b.latency, spread: Math.abs(a.latency - b.latency),
        targetA: a.target, targetB: b.target,
        errorA: Number.isFinite(a.target) ? a.latency - a.target : null,
        errorB: Number.isFinite(b.target) ? b.latency - b.target : null,
        rawA: a.currentTime, rawB: b.currentTime, rateA: a.rate, rateB: b.rate,
        platformA: a.platform, platformB: b.platform,
        refA: a.ref, refB: b.ref,
        audibleA: a.audibleSeeks, audibleB: b.audibleSeeks,
      });
    }
    await sleep(500);
  }
  if (samples.length < 8) fail(`room sync produced only ${samples.length} valid latency samples`);
  const sorted = samples.map((s) => s.spread).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const p90 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))];
  const aLatencies = samples.map((s) => s.a).sort((a, b) => a - b);
  const bLatencies = samples.map((s) => s.b).sort((a, b) => a - b);
  const aMedian = aLatencies[Math.floor(aLatencies.length / 2)];
  const bMedian = bLatencies[Math.floor(bLatencies.length / 2)];
  const targetErrors = samples.flatMap((s) => [s.errorA, s.errorB]).filter(Number.isFinite).map(Math.abs).sort((a, b) => a - b);
  const targetMedian = targetErrors[Math.floor(targetErrors.length / 2)];
  const targetP90 = targetErrors[Math.min(targetErrors.length - 1, Math.floor(targetErrors.length * 0.9))];
  if (samples.some((s) =>
    (s.platformA === 'native' && Math.abs(s.rateA - 1) > 0.001)
    || (s.platformB === 'native' && Math.abs(s.rateB - 1) > 0.001)
    || (s.platformA === 'hls' && Math.abs(s.rateA - 1) > 0.001)
    || (s.platformB === 'hls' && Math.abs(s.rateB - 1) > 0.001))) {
    fail(`room sync used an invalid playback rate: ${JSON.stringify(samples)}`);
  }
  if (samples.some((s) => s.refA !== 'pdt' || s.refB !== 'pdt')) {
    fail(`room sync did not use each player's PROGRAM-DATE-TIME: ${JSON.stringify(samples)}`);
  }
  // The room target is config-driven (not a hardcoded value), but every listener
  // must use the SAME one - a room-wide constant, never per-device.
  if (targetErrors.length !== samples.length * 2 || samples.some((s) => !Number.isFinite(s.targetA) || Math.abs(s.targetA - s.targetB) > 0.001)) {
    fail(`room sync targets diverged across listeners: ${JSON.stringify(samples)}`);
  }
  // Gate clean-room startup separately from deliberate synthetic drift.
  if (!allowInjectedDrift && samples.some((s) => s.audibleA > 0 || s.audibleB > 0)) {
    fail(`clean-room playback required an audible correction: ${JSON.stringify(samples)}`);
  }
  // Require 100 ms of media-clock agreement. This is a Chromium test; the
  // native guest-page lab separately exercises Safari's presentation behavior.
  if (median >= tolerance || p90 >= tolerance) {
    fail(`two-client sync spread too wide: median=${median.toFixed(3)}s p90=${p90.toFixed(3)}s samples=${JSON.stringify(samples)}`);
  }
  // Check the same tolerance against the common deadline, while the
  // separate spread check catches peer disagreement.
  // The direct synthetic publisher has no production capture/PDT origin, so the
  // mock validates peer spread and recovery only. The real Go-server stack owns
  // the absolute room-deadline assertion.
  if (!FORCE_MOCK && (targetMedian >= tolerance || targetP90 >= tolerance)) {
    fail(`listeners missed the authoritative deadline: median error=${targetMedian.toFixed(3)}s p90=${targetP90.toFixed(3)}s samples=${JSON.stringify(samples)}`);
  }
  log(`PASS browser room-sync ${label}: peers=${aMedian.toFixed(3)}s/${bMedian.toFixed(3)}s; spread median=${median.toFixed(3)}s p90=${p90.toFixed(3)}s; deadline error median=${targetMedian.toFixed(3)}s p90=${targetP90.toFixed(3)}s (${samples.length} samples, local PDT)`);
  return { median, p90, aMedian, bMedian, targetMedian, targetP90, samples };
}

async function startContinuityProbe(page) {
  return await page.evaluate(() => {
    const p = document.getElementById('player');
    if (!window.__ppContinuity) {
      window.__ppContinuity = { waits: 0, seeks: 0 };
      p.addEventListener('waiting', () => window.__ppContinuity.waits++);
      p.addEventListener('seeking', () => window.__ppContinuity.seeks++);
    }
    return { ...window.__ppContinuity, currentTime: p.currentTime };
  });
}

async function continuityState(page) {
  return await page.evaluate(() => {
    const p = document.getElementById('player');
    return {
      ...(window.__ppContinuity || { waits: 0, seeks: 0 }),
      currentTime: p.currentTime,
      paused: p.paused,
      muted: p.muted,
      readyState: p.readyState,
    };
  });
}

function assertContinuous(before, after, label, minProgress = 3) {
  const progress = after.currentTime - before.currentTime;
  if (after.waits !== before.waits || after.seeks !== before.seeks || after.paused || after.muted || after.readyState < 3 || progress < minProgress) {
    fail(`${label} interrupted: progress=${progress.toFixed(3)} before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
  }
  log(`PASS browser continuity ${label}: progress=${progress.toFixed(3)}s, no waits, no seeks`);
}

async function assertAudibleTransactionClosed(page, label) {
  const before = await syncState(page);
  const accepted = await page.evaluate(() => beginAudible('synthetic-reentry'));
  await sleep(250);
  const after = await syncState(page);
  if (accepted !== false || after.muted || after.paused || after.audibleGeneration !== before.audibleGeneration) {
    fail(`${label} reopened a completed audible transaction: accepted=${accepted} before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
  }
  log(`PASS browser audible transaction ${label}: re-entry refused at generation=${after.audibleGeneration}`);
}

async function assertRecovered(page,faultEnd,initial,label) {
  let recoveredAt = null, stableSince = null;
  while (Date.now()-faultEnd<3200) {
    const state = await syncState(page);
    if (!state.muted && !state.paused && state.readyState>=3 && Number.isFinite(state.latency) && Math.abs(state.latency-state.target)<=.1) {
      stableSince ??= Date.now();
      if (Date.now()-stableSince>=1000) { recoveredAt=stableSince; break; }
    } else stableSince=null;
    await sleep(50);
  }
  if (recoveredAt == null || recoveredAt-faultEnd>2000) fail(`${label} did not recover within two seconds`);
  const recovered = await syncState(page);
  if (recovered.attachGeneration!==initial.attachGeneration || recovered.audibleSeeks!==initial.audibleSeeks) {
    fail('recovery replaced the HLS session or performed an audible seek');
  }
  log(`PASS browser recovery ${label}: ${recoveredAt-faultEnd}ms, same attachment, no audible repair seeks`);
}

async function assertInjectedDriftIsolation(first, second) {
  await Promise.all([
    assertAudibleTransactionClosed(first, 'healthy peer'),
    assertAudibleTransactionClosed(second, 'delayed peer'),
  ]);
  await startContinuityProbe(first);
  await startContinuityProbe(second);
  const injected = await injectDrift(second, -0.65);
  if (!injected || Math.abs(injected.after - injected.before) < 0.5) {
    fail(`could not inject the 650ms late-phone drift: ${JSON.stringify(injected)}`);
  }
  log(`>> injected late-phone drift: ${(injected.after - injected.before).toFixed(3)}s`);
  await waitFor(async () => !(await second.evaluate(() => document.getElementById('player').seeking)), {
    timeoutMs: 5000,
    label: 'injected seek to settle',
  });
  const beforeFirst = await startContinuityProbe(first);
  const disturbed = await syncState(second);
  const faultEnd = Date.now();
  await assertRecovered(second,faultEnd,disturbed,'650ms drift');
  const beforeSecond = await startContinuityProbe(second);
  await sleep(4000);
  const [afterFirst, afterSecond] = await Promise.all([continuityState(first), continuityState(second)]);
  assertContinuous(beforeFirst, afterFirst, 'healthy peer after another device drifts', 4);
  assertContinuous(beforeSecond, afterSecond, 'repaired device remains playing', 3);
  await assertRoomSync(first, second, 'after-650ms-drift', { allowInjectedDrift: true });
}

async function assertNetworkRecovery(first,second) {
  const beforeFirst=await startContinuityProbe(first);
  const before=await syncState(second);
  const releaseAt=Date.now()+2500;
  let held=0;
  const hold=async route=>{
    held++;
    await sleep(Math.max(0,releaseAt-Date.now()));
    await route.continue();
  };
  await second.route('**/live/**',hold);
  try { await sleep(Math.max(0,releaseAt-Date.now())); }
  finally { await second.unroute('**/live/**',hold); }
  await assertRecovered(second,releaseAt,before,'2.5s media delivery hold');
  const after=await syncState(second);
  if(!held || after.stalls<=before.stalls) fail('network fault did not exercise an actual rebuffer');
  assertContinuous(beforeFirst,await continuityState(first),'healthy peer during media delivery outage',3);
  log(`PASS network fault: ${held} held requests, ${after.stalls-before.stalls} observed stalls`);
}

async function main() {
  const ffmpeg = helperPath('ffmpeg');
  const mediamtx = helperPath('mediamtx');
  log(`>> browser=${ENGINE} scenario=${SCENARIO}`);
  log(`>> ffmpeg=${ffmpeg}`);
  log(`>> mediamtx=${mediamtx}`);
  await run(ffmpeg, ['-version'], { timeoutMs: 10000 }).catch((err) => fail(`ffmpeg not runnable: ${err.message}`));
  await run(mediamtx, ['--help'], { timeoutMs: 10000 }).catch(() => ({}));

  const rootWork = await fs.mkdtemp(path.join(os.tmpdir(), 'pp-stream-e2e-'));
  if (KEEP_WORK) log(`>> keeping work dir: ${rootWork}`);
  else registerCleanup(() => fs.rm(rootWork, { recursive: true, force: true }));

  const playwright = await ensurePlaywright();
  await ensureEngine(playwright, ENGINE);

  let stack;
  if (FORCE_MOCK) {
    stack = await startMockStack(rootWork, ffmpeg, mediamtx);
    log(`>> browser E2E stack=mock page=${stack.pageUrl} stream=${stack.streamUrl}`);
  } else {
    stack = await startRealStack(rootWork, ffmpeg, mediamtx);
    log(`>> browser E2E stack=real page=${stack.pageUrl} stream=${stack.streamUrl}`);
    await assertShippingPlaylistShape(stack);
  }

  let browser;
  const browserType = playwright[ENGINE];
  const launchOptions = { headless: true };
  if (ENGINE === 'chromium') launchOptions.args = ['--autoplay-policy=no-user-gesture-required'];
  try {
    browser = await browserType.launch(launchOptions);
  } catch (err) {
    if (String(err.message || '').includes('Executable doesn')) {
      await run('npx', ['playwright', 'install', ENGINE], { cwd: ROOT, timeoutMs: 240000 });
      browser = await browserType.launch(launchOptions);
    } else {
      throw err;
    }
  }

  try {
    await assertReadinessGate(stack, browser);
    let session = null;
    if (SCENARIO === 'gate') {
      // The dedicated mock scenario stops after assertReadinessGate().
    } else if (SCENARIO === 'happy') {
      await driveGuest(stack, 'happy', browser);
    } else if (SCENARIO === 'all') {
      const r = await driveGuest(stack, 'happy', browser, null, { keepOpen: true });
      session = r.session;
      await sleep(2000);
      const beforeJoin = await startContinuityProbe(session.page);
      const peer = await driveGuest(stack, 'delayed-peer', browser, null, { keepOpen: true, checkActions: false });
      assertContinuous(beforeJoin, await continuityState(session.page), 'healthy peer while another device joins');
      await assertRoomSync(session.page, peer.session.page, 'delayed-join');
      await assertInjectedDriftIsolation(session.page, peer.session.page);
      await peer.session.context.close().catch(() => {});
      const beforeUnknownClock = await startContinuityProbe(session.page);
      const unknownClock = await driveGuest(stack, 'peer-without-program-clock', browser, null, { keepOpen: true, disableStartDate: true, checkActions: false });
      if (ENGINE === 'webkit') {
        const unknownState = await syncState(unknownClock.session.page);
        if (unknownState.startDateValid || unknownState.paused || unknownState.muted || unknownState.ref !== 'none') {
          fail(`WebKit no-PDT fallback was not honest and audible (${JSON.stringify(unknownState)})`);
        }
      }
      assertContinuous(beforeUnknownClock, await continuityState(session.page), 'healthy peer while an unsynchronized device joins');
      await unknownClock.session.context.close().catch(() => {});
      const manifestSince = Date.now();
      await stack.restartPublisher();
      await driveGuest(stack, 'resilience', browser, session, { keepOpen: true, manifestSince });
      await session.context.close().catch(() => {});
    } else if (SCENARIO === 'sync') {
      const first = await driveGuest(stack, 'sync-first', browser, null, { keepOpen: true });
      await sleep(2000);
      const beforeJoin = await startContinuityProbe(first.session.page);
      const second = await driveGuest(stack, 'sync-delayed', browser, null, { keepOpen: true, checkActions: false });
      assertContinuous(beforeJoin, await continuityState(first.session.page), 'healthy peer while another device joins');
      await assertRoomSync(first.session.page, second.session.page, 'delayed-join');
      await assertInjectedDriftIsolation(first.session.page, second.session.page);
      if(ENGINE==='chromium') await assertNetworkRecovery(first.session.page,second.session.page);
      await second.session.context.close().catch(() => {});
      const beforeUnknownClock = await startContinuityProbe(first.session.page);
      const unknownClock = await driveGuest(stack, 'sync-peer-without-program-clock', browser, null, { keepOpen: true, disableStartDate: true, checkActions: false });
      const unknownState = await syncState(unknownClock.session.page);
      if (ENGINE === 'webkit' && unknownState.startDateValid) {
        fail(`WebKit no-PDT setup failed: getStartDate remained valid (${JSON.stringify(unknownState)})`);
      }
      if (ENGINE === 'webkit' && (unknownState.paused || unknownState.muted || unknownState.ref !== 'none')) {
        fail(`WebKit no-PDT fallback was not honest and audible (${JSON.stringify(unknownState)})`);
      }
      assertContinuous(beforeUnknownClock, await continuityState(first.session.page), 'healthy peer while an unsynchronized device joins');
      await unknownClock.session.context.close().catch(() => {});
      await first.session.context.close().catch(() => {});
    } else if (SCENARIO === 'resilience') {
      const r = await driveGuest(stack, 'pre-resilience', browser, null, { keepOpen: true });
      session = r.session;
      const manifestSince = Date.now();
      await stack.restartPublisher();
      await driveGuest(stack, 'resilience', browser, session, { keepOpen: true, manifestSince });
      await session.context.close().catch(() => {});
    } else {
      fail(`unknown scenario ${SCENARIO}; use gate, happy, sync, resilience, or all`);
    }
  } catch (err) {
    failures.push(err.message || String(err));
  } finally {
    await browser?.close().catch(() => {});
  }

  if (failures.length) {
    log('RESULT: FAIL - browser guest did not hear the DJ audio.');
    for (const f of failures) log(`\n${f}`);
    await cleanup();
    process.exit(1);
  }

  log(ENGINE === 'webkit'
    ? 'RESULT: PASS - WebKit guest used native HLS and fetched, buffered, and advanced playback.'
    : 'RESULT: PASS - browser guest fetched, buffered, played, and measured non-zero audio RMS.');
  await cleanup();
}

main().catch(async (err) => {
  log('RESULT: FAIL - browser stream E2E crashed.');
  log(err.stack || err.message || String(err));
  await cleanup();
  process.exit(1);
});
