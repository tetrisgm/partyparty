// Bring up the real PartyParty stack on throwaway ports.
//
// This is the only harness in the repository that runs the code a guest
// actually talks to: the Go server, its /live proxy (which is where the room
// schedule is authored), the bundled MediaMTX, and a bundled ffmpeg publishing
// device=test. Everything else that claims to measure the guest path either
// talks to MediaMTX directly, which never sees the schedule rewrite, or puts a
// proxy of its own in the media path, which measures the proxy.
//
// It lives here rather than inside scripts/stream-e2e.mjs because two callers
// need it now: the browser E2E suite and scripts/soak-lab.mjs, which attaches a
// real AVPlayer to each playlist tier. A copy would drift, and a harness that
// drifts from the thing it measures is how a pre-upload receipt ends up
// describing a playlist no guest receives.
//
// Nothing here asserts anything about playlist contents. Assertions belong to
// the caller; this module only produces a running stack and the ports to reach
// it on.

import fs from 'node:fs/promises';
import { createWriteStream, existsSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
export const ROOT = path.resolve(path.dirname(__filename), '..', '..');

const cleanupFns = [];

export function log(msg) {
  console.log(msg);
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function fail(msg, extra) {
  const err = new Error(msg);
  if (extra) err.extra = extra;
  throw err;
}

export function isExecutable(p) {
  try {
    return existsSync(p);
  } catch {
    return false;
  }
}

export function helperPath(name) {
  const envKey = name === 'ffmpeg' ? 'FF' : 'MTX';
  const candidates = [
    process.env[envKey],
    path.join(ROOT, 'assets', name),
    path.join(os.homedir(), 'Applications', 'PartyParty.app', 'Contents', 'Helpers', name),
    name,
  ].filter(Boolean);
  for (const c of candidates) {
    if (c === name) return c;
    if (isExecutable(c)) return c;
  }
  return name;
}

export function run(cmd, args, opts = {}) {
  const cwd = opts.cwd || ROOT;
  const env = opts.env || process.env;
  const timeoutMs = opts.timeoutMs || 120000;
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${cmd} ${args.join(' ')} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr, code, signal });
      } else {
        const err = new Error(`${cmd} ${args.join(' ')} exited ${code ?? signal}`);
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
      }
    });
  });
}

export function startProcess(name, cmd, args, opts = {}) {
  const logPath = opts.logPath;
  const child = spawn(cmd, args, {
    cwd: opts.cwd || ROOT,
    env: opts.env || process.env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const lines = [];
  const append = (stream, d) => {
    const s = d.toString();
    for (const line of s.split(/\r?\n/)) {
      if (line) {
        lines.push(`${stream}: ${line}`);
        if (lines.length > 200) lines.shift();
      }
    }
  };
  let logStream = null;
  if (logPath) {
    logStream = createWriteStream(logPath, { flags: 'a' });
    child.stdout.pipe(logStream, { end: false });
    child.stderr.pipe(logStream, { end: false });
  }
  child.stdout.on('data', (d) => append('stdout', d));
  child.stderr.on('data', (d) => append('stderr', d));
  child.on('exit', (code, signal) => {
    lines.push(`exit: ${name} exited ${code ?? signal}`);
    if (logStream) logStream.end();
  });
  child.on('error', (err) => {
    lines.push(`error: ${err.message}`);
  });
  const proc = {
    name,
    child,
    lines,
    async stop(signal = 'SIGTERM') {
      if (child.exitCode != null || child.signalCode != null) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        try { child.kill(signal); } catch {}
      }
      for (let i = 0; i < 20; i++) {
        if (child.exitCode != null || child.signalCode != null) return;
        await sleep(100);
      }
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        try { child.kill('SIGKILL'); } catch {}
      }
    },
  };
  cleanupFns.push(() => proc.stop());
  return proc;
}

export function registerCleanup(fn) {
  cleanupFns.push(fn);
}

export async function cleanup() {
  while (cleanupFns.length) {
    const fn = cleanupFns.pop();
    try { await fn(); } catch {}
  }
}

process.on('SIGINT', async () => {
  await cleanup();
  process.exit(130);
});
process.on('SIGTERM', async () => {
  await cleanup();
  process.exit(143);
});

export async function freePort() {
  return await new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

export async function freePorts(n) {
  const ports = new Set();
  while (ports.size < n) ports.add(await freePort());
  return [...ports];
}

export async function waitFor(fn, opts = {}) {
  const timeoutMs = opts.timeoutMs || 15000;
  const intervalMs = opts.intervalMs || 250;
  const label = opts.label || 'condition';
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (err) {
      lastErr = err;
    }
    await sleep(intervalMs);
  }
  const err = new Error(`Timed out waiting for ${label}`);
  if (lastErr) err.cause = lastErr;
  throw err;
}

export async function fetchJSON(url, opts = {}) {
  const res = await fetch(url, opts);
  const body = await res.text();
  let json = {};
  try { json = body ? JSON.parse(body) : {}; } catch {}
  if (!res.ok) {
    const err = new Error(`${opts.method || 'GET'} ${url} -> HTTP ${res.status}: ${body.slice(0, 300)}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return json;
}

export function getInsecure(url, timeoutMs = 5000, redirects = 5, cookie = '') {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const options = {
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method: 'GET',
      rejectUnauthorized: false,
      timeout: timeoutMs,
      headers: cookie ? { Cookie: cookie } : undefined,
    };
    const req = lib.request(options, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { body += d; });
      res.on('end', () => {
        const status = res.statusCode || 0;
        const location = res.headers.location;
        const setCookie = res.headers['set-cookie'] || [];
        const cookieBits = Array.isArray(setCookie) ? setCookie : [setCookie];
        const responseCookie = cookieBits
          .map((value) => String(value).split(';')[0])
          .filter(Boolean)
          .join('; ') || cookie;
        if (redirects > 0 && status >= 300 && status < 400 && location) {
          const nextURL = new URL(location, u).toString();
          getInsecure(nextURL, timeoutMs, redirects - 1, responseCookie).then(resolve, reject);
          return;
        }
        resolve({ status, body, headers: res.headers, cookie: responseCookie });
      });
    });
    req.on('timeout', () => req.destroy(new Error(`GET ${url} timed out`)));
    req.on('error', reject);
    req.end();
  });
}

export async function generateCert(workDir) {
  const cert = path.join(workDir, 'cert.pem');
  const key = path.join(workDir, 'key.pem');
  await run('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', key, '-out', cert, '-days', '2',
    '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost',
  ], { cwd: workDir, timeoutMs: 30000 });
  return { cert, key };
}

export async function linkOrCopy(src, dst) {
  try {
    await fs.symlink(src, dst);
  } catch {
    await fs.copyFile(src, dst);
    await fs.chmod(dst, 0o755);
  }
}

/**
 * Start a real partyparty-server with a real MediaMTX and a real ffmpeg test
 * tone, on throwaway ports, under a throwaway HOME.
 *
 * opts:
 *   relayOrigin  pin contribution at this origin base instead of the broker's
 *   relayToken   the publish credential for it
 *   relayPush    force contribution on (see --relay-push in internal/config)
 *   label        process name prefix, for logs
 */
export async function startRealStack(rootWork, ffmpeg, mediamtx, opts = {}) {
  const workDir = path.join(rootWork, opts.dir || 'real');
  await fs.mkdir(workDir, { recursive: true });
  const [httpPort, tlsPort, rtspPort, hlsPort] = await freePorts(4);
  const appRoot = path.join(workDir, 'PartyPartyE2E.app', 'Contents');
  const macosDir = path.join(appRoot, 'MacOS');
  const helpersDir = path.join(appRoot, 'Helpers');
  const testHome = path.join(workDir, 'home');
  const testTmp = path.join(workDir, 'tmp');
  await fs.mkdir(macosDir, { recursive: true });
  await fs.mkdir(helpersDir, { recursive: true });
  await fs.mkdir(testHome, { recursive: true });
  await fs.mkdir(testTmp, { recursive: true });
  await linkOrCopy(ffmpeg, path.join(helpersDir, 'ffmpeg'));
  await linkOrCopy(mediamtx, path.join(helpersDir, 'mediamtx'));
  const { cert, key } = await generateCert(workDir);
  const serverBin = path.join(macosDir, 'partyparty-server');

  log('>> building dev partyparty-server');
  await run('go', ['build', '-tags', 'bundle', '-o', serverBin, '.'], {
    cwd: ROOT,
    timeoutMs: 180000,
  });

  const args = [
    '--no-open',
    '--port', String(httpPort),
    '--tls-port', String(tlsPort),
    '--domain', '127.0.0.1',
    '--cert', cert,
    '--key', key,
    '--rtsp-port', String(rtspPort),
    '--hls-port', String(hlsPort),
    '--stream-path', 'party',
    '--name', opts.name || 'PartyParty E2E',
  ];
  if (opts.relayOrigin) {
    args.push('--relay-origin', opts.relayOrigin);
    if (opts.relayToken) args.push('--relay-token', opts.relayToken);
    if (opts.relayPush) args.push('--relay-push');
  }

  const server = startProcess(opts.label || 'partyparty-server', serverBin, args, {
    cwd: ROOT,
    logPath: path.join(workDir, 'server.log'),
    env: {
      ...process.env,
      HOME: testHome,
      TMPDIR: testTmp,
      PP_DEV_NO_LOGIN: '1',
      PARTYPARTY_TELEMETRY: '0',
    },
  });

  const statusURL = `http://127.0.0.1:${httpPort}/api/status`;
  try {
    await waitFor(() => fetchJSON(statusURL), {
      timeoutMs: 20000,
      label: 'real server /api/status',
    });
  } catch (err) {
    throw new Error(`${err.message}; exit=${server.child.exitCode} signal=${server.child.signalCode}\n${server.lines.slice(-20).join('\n')}`, { cause: err });
  }

  await fetchJSON(`http://127.0.0.1:${httpPort}/api/start?device=test`, {
    method: 'POST',
  });

  const live = await waitFor(async () => {
    const s = await fetchJSON(statusURL);
    return s.broadcast && s.broadcast.state === 'live' && s.llhlsUrl ? s : false;
  }, {
    timeoutMs: 25000,
    label: 'real server live LL-HLS status',
  });

  await waitFor(async () => {
    const r = await getInsecure(live.llhlsUrl, 3000);
    return r.status === 200 && r.body.includes('#EXTM3U');
  }, {
    timeoutMs: 20000,
    label: 'real server LL-HLS manifest',
  });

  const syncReady = await waitFor(async () => {
    const s = await fetchJSON(statusURL);
    return s.streamSync && s.streamSync.ready && s.streamSync.realHistory >= s.latencyTarget ? s : false;
  }, {
    timeoutMs: 25000,
    label: 'real server contiguous non-GAP readiness',
  });
  log(`PASS server stream readiness: generation=${syncReady.streamSync.generation} real=${syncReady.streamSync.realHistory.toFixed(3)}s gaps=${syncReady.streamSync.gapHistory.toFixed(3)}s target=${syncReady.latencyTarget.toFixed(3)}s`);

  return {
    mode: 'real',
    workDir,
    proc: server,
    pageUrl: `https://127.0.0.1:${tlsPort}/?debug=1`,
    statusURL,
    streamUrl: live.llhlsUrl,
    httpPort,
    tlsPort,
    rtspPort,
    hlsPort,
    cert,
    key,
    async restartPublisher() {
      log('>> resilience: killing real ffmpeg publisher and restarting device=test');
      const killed = await killRealPublisher(server.child.pid);
      if (!killed) {
        log('   ffmpeg publisher pid not found; using /api/stop as fallback');
        await fetchJSON(`http://127.0.0.1:${httpPort}/api/stop`, { method: 'POST' }).catch(() => ({}));
      }
      await waitFor(async () => {
        const s = await fetchJSON(statusURL).catch(() => null);
        return s && s.broadcast && s.broadcast.state !== 'live';
      }, { timeoutMs: 10000, label: 'real publisher stopped' }).catch(() => null);
      await fetchJSON(`http://127.0.0.1:${httpPort}/api/start?device=test`, {
        method: 'POST',
      });
      const s = await waitFor(async () => {
        const st = await fetchJSON(statusURL);
        return st.broadcast && st.broadcast.state === 'live' && st.llhlsUrl ? st : false;
      }, { timeoutMs: 25000, label: 'real publisher restarted' });
      this.streamUrl = s.llhlsUrl;
      await waitFor(async () => {
        const r = await getInsecure(s.llhlsUrl, 3000);
        return r.status === 200 && r.body.includes('#EXTM3U');
      }, { timeoutMs: 20000, label: 'real restarted manifest' });
      await waitFor(async () => {
        const st = await fetchJSON(statusURL);
        return st.streamSync && st.streamSync.ready && st.streamSync.generation === st.broadcast.since;
      }, { timeoutMs: 25000, label: 'real restarted stream readiness' });
    },
    logs() {
      return server.lines.slice(-40).join('\n');
    },
  };
}

export async function killRealPublisher(serverPid) {
  try {
    const out = await run('pgrep', ['-P', String(serverPid), '-f', 'ffmpeg'], { timeoutMs: 5000 });
    const pids = out.stdout.trim().split(/\s+/).filter(Boolean).map((v) => Number(v)).filter(Boolean);
    for (const pid of pids) {
      try { process.kill(pid, 'SIGKILL'); } catch {}
    }
    return pids.length > 0;
  } catch {
    return false;
  }
}

/**
 * Start cmd/pporigin on loopback with a static rooms file and no broker, so a
 * relayed guest path can be exercised end to end without any network, any
 * registration, or the production origin.
 */
export async function startOrigin(rootWork, { room, token, dir = 'origin' } = {}) {
  const workDir = path.join(rootWork, dir);
  await fs.mkdir(workDir, { recursive: true });
  const [port] = await freePorts(1);
  const bin = path.join(workDir, 'pporigin');
  const roomsFile = path.join(workDir, 'rooms.json');
  await fs.writeFile(roomsFile, JSON.stringify({ [room]: token }), 'utf8');

  log('>> building pporigin');
  await run('go', ['build', '-o', bin, './cmd/pporigin'], { cwd: ROOT, timeoutMs: 180000 });

  const proc = startProcess('pporigin', bin, [
    '-addr', `127.0.0.1:${port}`,
    '-rooms', roomsFile,
    '-broker', '',
  ], {
    cwd: ROOT,
    logPath: path.join(workDir, 'origin.log'),
  });

  await waitFor(async () => {
    const r = await getInsecure(`http://127.0.0.1:${port}/__pp/health`, 2000);
    return r.status === 200;
  }, { timeoutMs: 15000, label: 'pporigin health' });

  return {
    proc,
    port,
    workDir,
    base: `http://127.0.0.1:${port}/r/${room}`,
    logs() {
      return proc.lines.slice(-40).join('\n');
    },
  };
}
