#!/usr/bin/env node
// Real guest page in macOS WKWebView, using native HLS over loopback HTTPS.
// Certificate trust is confined to the test process. This measures media
// timelines, not physical speaker output; it is not a release approval.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ROOT, run, startProcess, helperPath, startRealStack, cleanup, sleep, freePort, waitFor, getInsecure } from './lib/real-stack.mjs';
import { readNativeTimeline } from './lib/native-clock.mjs';

const seconds = Number(process.env.PP_SYNC_SECONDS || 90);
const clockOnly = process.env.PP_SYNC_CLOCK_ONLY === '1';
const drift = process.env.PP_SYNC_DRIFT === '1';
if (!Number.isFinite(seconds) || seconds < 30 || seconds > 3600) throw new Error('PP_SYNC_SECONDS must be 30–3600');
if (drift && seconds < 90) throw new Error('fault injection requires at least 90 seconds');
const work = await fs.mkdtemp(path.join(os.tmpdir(), 'pp-native-sync-'));
console.log(`work=${work}`);
try {
  const fingerprints = {};
  for (const file of ['web/listener.html', 'internal/schedule/clock.go', 'internal/schedule/schedule.go', 'scripts/soak-listener.swift', 'scripts/native-sync-lab.mjs']) {
    fingerprints[file] = createHash('sha256').update(await fs.readFile(path.join(ROOT,file))).digest('hex');
  }
  await fs.writeFile(path.join(work,'source-sha256.json'), JSON.stringify(fingerprints,null,2)+'\n');
  const bin = path.join(work, 'soak-listener');
  await run('swiftc', ['-O', '-o', bin, 'scripts/soak-listener.swift'], { timeoutMs: 180000 });
  const metadata = process.env.PP_CLOCK_METADATA === '1';
  const proxy = path.join(work, 'soakarm');
  if (metadata) await run('go', ['build', '-o', proxy, './scripts/soakarm']);
  const stack = await startRealStack(work, helperPath('ffmpeg'), helperPath('mediamtx'));
  const http = process.env.PP_NATIVE_HTTP === '1';
  let base = http ? `http://127.0.0.1:${stack.httpPort}` : `https://127.0.0.1:${stack.tlsPort}`;
  if (metadata) {
    const port = await freePort();
    startProcess('clock-cue-proxy', proxy, ['-addr', `127.0.0.1:${port}`, '-upstream', `http://127.0.0.1:${stack.httpPort}`, '-clock-metadata', '-cert', stack.cert, '-key', stack.key], {logPath:path.join(work,'proxy.log')});
    base = `https://127.0.0.1:${port}`;
    await waitFor(async()=> (await getInsecure(base+'/api/status')).status===200);
  }
  const setup = path.join(work, 'setup.js');
  const candidate = path.join(work, 'candidate.js');
  await fs.writeFile(setup, `window.readNativeTimeline = ${readNativeTimeline.toString()};\n` + (http || metadata ? `
    const labFetch = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const response = await labFetch(...args);
      if (new URL(String(args[0]), location.href).pathname !== '/api/status' || !response.ok) return response;
      const data = await response.json();
      data.llhlsUrl = ${JSON.stringify(base + '/live/party/index.m3u8')};
      return new Response(JSON.stringify(data), {status: response.status, headers: response.headers});
    };
  ` : ''));
  await fs.writeFile(candidate, '');
  const logfile = path.join(work, 'native.jsonl');
  const proc = startProcess('native-listeners', bin, [base + '/?debug=1', setup, candidate, String(seconds)], { logPath: logfile });
  const deadline = Date.now() + (seconds + 30)*1000;
  while (proc.child.exitCode == null && proc.child.signalCode == null && Date.now() < deadline) await sleep(500);
  if (proc.child.exitCode !== 0) throw new Error(`native player failed: ${proc.lines.slice(-8).join('\n')}`);
  const samples = (await fs.readFile(logfile, 'utf8')).split('\n').filter(s => s.startsWith('{')).map(s => JSON.parse(s));
  const percentile = (values, p) => values.toSorted((a,b)=>a-b)[Math.min(values.length-1, Math.floor(values.length*p))];
  const results = {};
  const names = ['current-0', 'current-1'];
  const measuredWindow = s => s.elapsed >= 20 && !(drift && s.arm === 'current-1' && s.elapsed >= 30 && s.elapsed < 50);
  for (const arm of names) {
    const all = samples.filter(s => s.arm === arm && measuredWindow(s));
    const valid = all.filter(s => Number.isFinite(s.latency) && !s.paused && !s.muted && s.ready >= 3);
    let stall = 0, maxStallSeconds = 0;
    for (let i=1; i<all.length; i++) {
      if (drift && arm==='current-1' && all[i-1].elapsed<30 && all[i].elapsed>=50) { stall=0; continue; }
      const advance = all[i].position-all[i-1].position;
      stall = advance < .01 ? stall + all[i].elapsed-all[i-1].elapsed : 0;
      maxStallSeconds = Math.max(maxStallSeconds, stall);
    }
    results[arm] = { total: all.length, measured: valid.length, precise: valid.filter(s=>s.precise).length, backward: all.filter(s=>s.backward).length,
      maxStallSeconds, audibleSeeks:Math.max(0,...samples.filter(s=>s.arm===arm && Number.isFinite(s.audibleSeeks)).map(s=>s.audibleSeeks)),
      median: percentile(valid.map(s=>s.latency), .5), p95Error: percentile(valid.map(s=>Math.abs(s.latency-3)), .95),
      rateMin: Math.min(...valid.map(s=>s.rate)), rateMax: Math.max(...valid.map(s=>s.rate)),
      platform: [...new Set(all.map(s=>s.platform))] };
  }
  // Compare samples taken at nearly the same wall instant. Page-relative elapsed
  // is insufficient when loads finish at different times, so use source PDT +
  // reported latency as the shared observation timestamp.
  for (const group of ['current']) {
    const a = samples.filter(s=>s.arm===group+'-0' && measuredWindow(s) && Number.isFinite(s.latency) && !s.paused && !s.muted);
    const b = samples.filter(s=>s.arm===group+'-1' && measuredWindow(s) && Number.isFinite(s.latency) && !s.paused && !s.muted);
    const stamp = s => s.origin + s.position*1000 + s.latency*1000;
    const spread=[];
    for (const x of a) {
      const y=b.reduce((best,y)=>!best || Math.abs(stamp(x)-stamp(y))<Math.abs(stamp(x)-stamp(best)) ? y : best, null);
      if (y && Math.abs(stamp(x)-stamp(y))<300) spread.push(Math.abs(x.latency-y.latency));
    }
    results[group+'-spread']={ samples: spread.length, median: percentile(spread,.5), p95: percentile(spread,.95), max: Math.max(...spread) };
  }
  if (drift) {
    const fault = samples.find(s=>s.arm==='current-1' && Number.isFinite(s.injectedStallAt));
    const disturbed = samples.filter(s=>s.arm==='current-1' && s.elapsed>=30 && s.elapsed<50);
    const peak = Math.max(...disturbed.filter(s=>Number.isFinite(s.latency)).map(s=>s.latency));
    const recovered = disturbed.find(s=>s.elapsed>=32 && s.precise && s.clock && !s.muted && !s.paused && s.ready>=3 && Math.abs(s.latency-3)<=.1);
    results.fault={injectedAt:fault?.injectedStallAt,peakLatency:peak,recoveredAt:recovered?.elapsed};
  }
  console.log(JSON.stringify(results,null,2));
  await fs.writeFile(path.join(work,'summary.json'), JSON.stringify({ protocol:http ? 'HTTP/1.1 loopback' : 'HTTPS loopback (ephemeral trust in test process)', metadataProxy:metadata, clockOnly, drift, seconds, results },null,2)+'\n');
  const arms=names.map(a=>results[a]);
  if (arms.some(a=>a.measured<100 || a.measured<a.total*.95 || a.precise<a.measured*.95 || a.backward>0 || a.maxStallSeconds>1 || a.audibleSeeks>0 || !a.platform.includes('native'))) {
    throw new Error('native timing/continuity check failed');
  }
  if (!clockOnly && (arms.some(a=>a.p95Error>.1) || results['current-spread'].p95>.1)) {
    throw new Error('native media-clock deadline failed; retain the receipt, do not ship');
  }
  if (drift && (!Number.isFinite(results.fault.injectedAt) || results.fault.peakLatency<3.75 || !Number.isFinite(results.fault.recoveredAt))) {
    throw new Error('fault injection did not prove a late native player recovered');
  }
  console.log(clockOnly ? 'PASS native clock metadata and continuity; synchronization target NOT asserted' : 'PASS native common deadline and continuity (physical output not tested)');
} finally { await cleanup(); }
