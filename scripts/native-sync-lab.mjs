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
import { programTimelineErrors } from './lib/program-timeline.mjs';

const seconds = Number(process.env.PP_SYNC_SECONDS || 90);
const clockOnly = process.env.PP_SYNC_CLOCK_ONLY === '1';
const drift = process.env.PP_SYNC_DRIFT === '1';
const mixed = process.env.PP_SYNC_CHROMIUM === '1';
if (!Number.isFinite(seconds) || seconds < 30 || seconds > 3600) throw new Error('PP_SYNC_SECONDS must be 30–3600');
if (drift && seconds < 90) throw new Error('fault injection requires at least 90 seconds');
const work = await fs.mkdtemp(path.join(os.tmpdir(), 'pp-native-sync-'));
console.log(`work=${work}`);
let browser, chromeTimer, chromeSampling, chromeError;
try {
  const fingerprints = {};
  for (const file of ['web/listener.html', 'web/vendor/hls.min.js', 'internal/mediamtx/mediamtx.go', 'internal/schedule/clock.go', 'internal/schedule/schedule.go', 'scripts/soak-listener.swift', 'scripts/native-sync-lab.mjs']) {
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
  const chromeSamples=[];
  if (mixed) {
    const {chromium}=await import('playwright');
    browser=await chromium.launch({headless:true,args:['--autoplay-policy=no-user-gesture-required']});
    const page=await browser.newPage({ignoreHTTPSErrors:true});
    await page.goto(base+'/?debug=1');
    await page.waitForFunction(()=>typeof streamReady!=='undefined' && streamReady);
    await page.evaluate(()=>{
      window.labAt=performance.now(); window.labPrevious=null;
      setTimeout(()=>{
        player.volume=0;
        if(!attached) attachSafe();
        beginAudible('mixed-lab');play();
      },8000);
    });
    chromeTimer=setInterval(()=>{
      if(chromeSampling || chromeError) return;
      chromeSampling=page.evaluate(()=>{
        const mapping=playbackTimelineSample(), position=player.currentTime, frag=hls?.streamController?.currentFrag;
        const sample={arm:'chromium',elapsed:(performance.now()-window.labAt)/1000,
          platform,latency:measureLatency(),target:roomTarget(),position,origin:mapping.origin,
          sn:frag?.sn,fragStart:frag?.start,fragPdt:frag?.programDateTime,fragEnd:frag?.end,
          pts:frag?.startPTS,dts:frag?.startDTS,cc:frag?.cc,
          precise:mapping.origin!=null,clock:clockReliable(),uncertainty:clockUncertainty,
          muted:player.muted,paused:player.paused,ready:player.readyState,seeking:player.seeking,
          rate:player.playbackRate,audibleSeeks,generation:attachGeneration,
          backward:window.labPrevious!=null && position<window.labPrevious-.05};
        window.labPrevious=position;return sample;
      }).then(s=>chromeSamples.push(s)).catch(e=>{chromeError=e;}).finally(()=>{chromeSampling=null;});
    },250);
  }
  const logfile = path.join(work, 'native.jsonl');
  const master = await getInsecure(base+'/live/party/index.m3u8');
  const variant = master.body.split(/\r?\n/).find(l=>l && !l.startsWith('#'));
  const mediaURL = new URL(variant,base+'/live/party/index.m3u8').href;
  const timeline=[];let lastTimeline=0;
  const proc = startProcess('native-listeners', bin, [base + '/?debug=1', setup, candidate, String(seconds)], { logPath: logfile });
  const deadline = Date.now() + (seconds + 30)*1000;
  while (proc.child.exitCode == null && proc.child.signalCode == null && Date.now() < deadline) {
    if(Date.now()-lastTimeline>=5000) {
      lastTimeline=Date.now();
      const playlist=await getInsecure(mediaURL,3000,5,master.cookie);
      timeline.push({at:Date.now(),status:playlist.status,body:playlist.body,errors:programTimelineErrors(playlist.body)});
    }
    await sleep(500);
  }
  await fs.writeFile(path.join(work,'playlists.json'),JSON.stringify(timeline,null,2)+'\n');
  clearInterval(chromeTimer);
  if(chromeSampling) await chromeSampling;
  if(mixed) await fs.writeFile(path.join(work,'chromium.jsonl'),chromeSamples.map(s=>JSON.stringify(s)).join('\n')+'\n');
  if(chromeError) throw chromeError;
  if (proc.child.exitCode !== 0) throw new Error(`native player failed: ${proc.lines.slice(-8).join('\n')}`);
  const samples = (await fs.readFile(logfile, 'utf8')).split('\n').filter(s => s.startsWith('{')).map(s => JSON.parse(s));
  samples.push(...chromeSamples);
  const percentile = (values, p) => values.toSorted((a,b)=>a-b)[Math.min(values.length-1, Math.floor(values.length*p))];
  const results = {};
  const timelineErrors=timeline.flatMap(s=>s.errors);
  results.programTimeline={observations:timelineErrors.length,maxErrorMs:Math.max(...timelineErrors.map(Math.abs))};
  const names = ['current-0', 'current-1', ...(mixed ? ['chromium'] : [])];
  const faults = samples.filter(s=>s.arm==='current-1' && Number.isFinite(s.injectedStallAt)).map(f=>({
    ...f, endedAt:samples.find(s=>s.arm===f.arm && s.fault===f.fault && Number.isFinite(s.stallEndedAt))?.stallEndedAt,
  }));
  // Only the actual fault plus a maximum two-second recovery allowance is
  // excluded for the disturbed listener. No blanket 20-second blind window.
  const measuredWindow = s => s.elapsed >= 20 && !faults.some(f=>s.arm===f.arm && s.elapsed>=f.injectedStallAt && s.elapsed<f.endedAt+2);
  for (const arm of names) {
    const all = samples.filter(s => s.arm === arm && measuredWindow(s));
    const valid = all.filter(s => Number.isFinite(s.latency) && !s.paused && !s.muted && s.ready >= 3);
    let stall = 0, maxStallSeconds = 0;
    for (let i=1; i<all.length; i++) {
      if (faults.some(f=>arm===f.arm && all[i-1].elapsed<f.injectedStallAt && all[i].elapsed>=f.endedAt+2)) { stall=0; continue; }
      const advance = all[i].position-all[i-1].position;
      stall = advance < .01 ? stall + all[i].elapsed-all[i-1].elapsed : 0;
      maxStallSeconds = Math.max(maxStallSeconds, stall);
    }
    results[arm] = { total: all.length, measured: valid.length, precise: valid.filter(s=>s.precise).length, backward: all.filter(s=>s.backward).length,
      unexpectedMuted:all.filter(s=>s.muted).length,
      generations:[...new Set(samples.filter(s=>s.arm===arm && s.elapsed>=20).map(s=>s.generation))],
      maxStallSeconds, audibleSeeks:Math.max(0,...samples.filter(s=>s.arm===arm && Number.isFinite(s.audibleSeeks)).map(s=>s.audibleSeeks)),
      median: percentile(valid.map(s=>s.latency), .5), target: valid[0]?.target, p95Error: percentile(valid.map(s=>Math.abs(s.latency-s.target)), .95),
      rateMin: Math.min(...valid.map(s=>s.rate)), rateMax: Math.max(...valid.map(s=>s.rate)),
      platform: [...new Set(all.map(s=>s.platform))] };
  }
  // Compare samples taken at nearly the same wall instant. Page-relative elapsed
  // is insufficient when loads finish at different times, so use source PDT +
  // reported latency as the shared observation timestamp.
  for (const [group,first,second] of [['current','current-0','current-1'], ...(mixed ? [['mixed','current-0','chromium'],['mixed-repaired','current-1','chromium']] : [])]) {
    const a = samples.filter(s=>s.arm===first && measuredWindow(s) && Number.isFinite(s.latency) && !s.paused && !s.muted);
    const b = samples.filter(s=>s.arm===second && measuredWindow(s) && Number.isFinite(s.latency) && !s.paused && !s.muted);
    const stamp = s => s.origin + s.position*1000 + s.latency*1000;
    const spread=[];
    for (const x of a) {
      const y=b.reduce((best,y)=>!best || Math.abs(stamp(x)-stamp(y))<Math.abs(stamp(x)-stamp(best)) ? y : best, null);
      if (y && Math.abs(stamp(x)-stamp(y))<300) spread.push(Math.abs(x.latency-y.latency));
    }
    results[group+'-spread']={ samples: spread.length, median: percentile(spread,.5), p95: percentile(spread,.95), max: Math.max(...spread) };
  }
  results.faults = faults.map(fault => {
    const faultEnd = fault.endedAt;
    const disturbed = samples.filter(s=>s.arm===fault.arm && s.elapsed>=fault.injectedStallAt && s.elapsed<faultEnd+10);
    const peak = Math.max(...disturbed.filter(s=>Number.isFinite(s.latency)).map(s=>s.latency));
    const aligned = s => s.precise && s.clock && !s.muted && !s.paused && s.ready>=3 && Math.abs(s.latency-s.target)<=.1;
    const recovered = disturbed.find((s,i)=>s.elapsed>=faultEnd && aligned(s)
      && disturbed.some(t=>t.elapsed>=s.elapsed+1)
      && disturbed.slice(i).filter(t=>t.elapsed<=s.elapsed+1).every(aligned));
    const muted = disturbed.filter(s=>s.muted);
    return {injectedAt:fault.injectedStallAt,endedAt:faultEnd,peakLatency:peak,recoveredAt:recovered?.elapsed,
      recoverySeconds:recovered ? recovered.elapsed-faultEnd : null,
      mutedSeconds:muted.length ? muted.at(-1).elapsed-muted[0].elapsed+.25 : 0};
  });
  console.log(JSON.stringify(results,null,2));
  await fs.writeFile(path.join(work,'summary.json'), JSON.stringify({ protocol:http ? 'HTTP/1.1 loopback' : 'HTTPS loopback (ephemeral trust in test process)', metadataProxy:metadata, clockOnly, drift, mixed, seconds, results },null,2)+'\n');
  const arms=names.map(a=>results[a]);
  if(timelineErrors.length<10 || timeline.some(s=>s.status!==200) || timelineErrors.some(e=>!Number.isFinite(e) || Math.abs(e)>2)) {
    throw new Error('source PROGRAM-DATE-TIME diverged from media duration');
  }
  if (arms.some(a=>a.measured<100 || a.measured<a.total*.95 || a.precise<a.measured*.95 || a.backward>0
      || a.unexpectedMuted>0 || a.generations.length!==1 || a.maxStallSeconds>1 || a.audibleSeeks>0)
      || names.some(name=>!results[name].platform.includes(name==='chromium' ? 'hls' : 'native'))) {
    throw new Error('native timing/continuity check failed');
  }
  if (!clockOnly && (arms.some(a=>!Number.isFinite(a.p95Error) || a.p95Error>.1)
      || Object.entries(results).filter(([name])=>name.endsWith('-spread')).some(([,s])=>!Number.isFinite(s.p95) || s.p95>.1))) {
    throw new Error('native media-clock deadline failed; retain the receipt, do not ship');
  }
  if (drift && (results.faults.length!==3 || results.faults.some(f=>!Number.isFinite(f.endedAt)
      || f.peakLatency<results['current-1'].target+.75 || !Number.isFinite(f.recoveredAt)
      || f.recoverySeconds>2 || f.mutedSeconds>2))) {
    throw new Error('late native player did not recover within two seconds of fault ending');
  }
  console.log(clockOnly ? 'PASS native clock metadata and continuity; synchronization target NOT asserted' : 'PASS native common deadline and continuity (physical output not tested)');
} finally {
  clearInterval(chromeTimer);
  if(chromeSampling) await chromeSampling.catch(()=>{});
  await browser?.close();
  await cleanup();
}
