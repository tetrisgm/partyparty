#!/usr/bin/env node
// The playback soak lab: every playlist tier a guest can be served, measured
// at the same moment against the same live stream by real AVPlayers.
//
// WHAT THIS ANSWERS
//
// On 2026-08-11 two soaks recorded 1.17s on the direct path and 3.33s on the
// relay path against a declared 3.00s room target, and the finding sat
// unresolved because the two runs were not comparable. They measured different
// playlist tiers (a pinned multivariant against an unpinned media playlist),
// neither recorded which URL it measured, and the single number they printed
// was the SUM of transport staleness and attachment position. Those three
// defects are fixed in scripts/soak-playback.swift; this script uses the
// repaired instrument to run the comparison that was never actually run.
//
// THE ARMS
//
//   direct       http://127.0.0.1:<http>/live/party/index.m3u8
//                The real direct guest path: the Go server's /live proxy, which
//                is where internal/schedule authors the room's EXT-X-START pin.
//                Plaintext because AVPlayer will not attach to the throwaway
//                certificate a lab stack presents; the proxy, the rewrite and
//                the muxer behind it are the shipping ones.
//
//   proxy-keep   the same playlist through scripts/soakarm, passing through.
//                A CONTROL, not a result. If it does not reproduce `direct`,
//                the lab proxy is distorting the measurement and no conclusion
//                may be drawn from the arm below it. The 2026-08-11 bench proxy
//                had no such control, which is why three different pin
//                placements all returned about 3.1s.
//
//   proxy-strip  the same playlist with EXT-X-START removed and nothing else.
//                The difference between this and proxy-keep is the ENTIRE
//                effect of the room's attachment pin.
//
//   relay        http://127.0.0.1:<origin>/r/lab/stream.m3u8
//                The real relay guest path: internal/contribute pushing to a
//                real cmd/pporigin over loopback. This is a MEDIA playlist,
//                which internal/schedule never pins, so it shows what a relayed
//                guest is actually served. Loopback removes the wide-area hop,
//                so its `edge` is the floor of the relay's own delay, not the
//                value a venue would see.
//
// All arms run CONCURRENTLY against one stream. That is deliberate: arms run
// back to back see different minutes of the stream and different machine load,
// and the quantity under test is a difference between arms. Four muted headless
// players on a loopback 320kbps stream is not a meaningful load.
//
// It starts a bundled mediamtx and ffmpeg on throwaway ports. DO NOT RUN IT
// WHILE THE MAC IS BROADCASTING: compiling and loading the Mac during a set has
// already caused audible cutoffs.
//
//   node scripts/soak-lab.mjs [--minutes=10] [--keep-work]

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  ROOT, log, fail, helperPath, isExecutable, run, startProcess, registerCleanup,
  cleanup, freePorts, waitFor, getInsecure, startRealStack, startOrigin,
} from './lib/real-stack.mjs';

const MINUTES = Number((process.argv.find((a) => a.startsWith('--minutes=')) || '').split('=')[1] || 10);
const KEEP_WORK = process.argv.includes('--keep-work');
const ROOM = 'lab';
// Not a secret: a loopback origin with -broker "" accepts exactly what its
// static rooms file says, and the file is written fresh into the throwaway
// work directory on every run.
const TOKEN = 'soak-lab-publish-token';

function stamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
}

async function soakPlayerBinary(workDir) {
  const bin = path.join(workDir, 'soak-playback');
  log('>> building the soak player');
  await run('swiftc', ['-O', '-o', bin, 'scripts/soak-playback.swift'], { cwd: ROOT, timeoutMs: 300000 });
  return bin;
}

async function soakArmBinary(workDir) {
  const bin = path.join(workDir, 'soakarm');
  log('>> building soakarm');
  await run('go', ['build', '-o', bin, './scripts/soakarm'], { cwd: ROOT, timeoutMs: 180000 });
  return bin;
}

/** Start one soakarm proxy and return the base URL it serves. */
async function startArmProxy(bin, workDir, { name, pin = 'keep', holdBack = 0, upstream }) {
  const [port] = await freePorts(1);
  const args = ['-addr', `127.0.0.1:${port}`, '-upstream', upstream, '-pin', pin];
  if (holdBack > 0) args.push('-holdback', String(holdBack));
  const proc = startProcess(`soakarm-${name}`, bin, args, {
    cwd: ROOT,
    logPath: path.join(workDir, `soakarm-${name}.log`),
  });
  await waitFor(async () => {
    const r = await getInsecure(`http://127.0.0.1:${port}/live/party/index.m3u8`, 2000);
    return r.status === 200 && r.body.includes('#EXTM3U');
  }, { timeoutMs: 15000, label: `soakarm-${name} serving` });
  return { proc, base: `http://127.0.0.1:${port}` };
}

/** What the arm is actually serving, recorded in the receipt so it cannot be argued about later. */
async function describeManifest(url) {
  const mv = await getInsecure(url, 4000);
  const tier = /#EXT-X-STREAM-INF/.test(mv.body) ? 'multivariant' : 'media';
  const start = /^#EXT-X-START:.*$/m.exec(mv.body || '')?.[0] || 'absent';
  let holdback = 'n/a';
  let partTarget = 'n/a';
  let mediaBody = mv.body;
  if (tier === 'multivariant') {
    const variant = (mv.body || '').split(/\r?\n/).find((l) => l && !l.startsWith('#'));
    if (variant) {
      const mediaUrl = new URL(variant, url).href;
      const media = await getInsecure(mediaUrl, 4000, 5, mv.cookie);
      mediaBody = media.body;
    }
  }
  holdback = /PART-HOLD-BACK=([0-9.]+)/.exec(mediaBody || '')?.[1] || 'absent';
  partTarget = /PART-TARGET=([0-9.]+)/.exec(mediaBody || '')?.[1] || 'absent';
  const mediaStart = /^#EXT-X-START:.*$/m.exec(mediaBody || '')?.[0] || 'absent';
  const serverControl = /^#EXT-X-SERVER-CONTROL:.*$/m.exec(mediaBody || '')?.[0] || 'absent';
  const targetDuration = /#EXT-X-TARGETDURATION:([0-9]+)/.exec(mediaBody || '')?.[1] || 'absent';
  return { tier, start, mediaStart, holdback, partTarget, serverControl, targetDuration };
}

function runSoak(bin, { url, label, workDir }) {
  const logPath = path.join(workDir, `soak-${label}.log`);
  return new Promise(async (resolve) => {
    const proc = startProcess(`soak-${label}`, bin, [url], {
      cwd: ROOT,
      logPath,
      env: {
        ...process.env,
        PP_SOAK_MINUTES: String(MINUTES),
        PP_SOAK_LABEL: label,
        PP_SOAK_BUILD: process.env.PP_SOAK_BUILD || 'soak-lab throwaway stack',
      },
    });
    proc.child.on('exit', async (code) => {
      let text = '';
      try { text = await fs.readFile(logPath, 'utf8'); } catch {}
      resolve({ label, url, code, logPath, text });
    });
  });
}

function summarise(result) {
  const pass = /^SOAK PASS:/m.test(result.text);
  const verdictLine = /^SOAK (PASS|FAIL):.*$/m.exec(result.text)?.[0] || '(no verdict line)';
  const nums = { latency: [], edge: [], attach: [] };
  for (const m of result.text.matchAll(/latency=(-?[0-9.]+)s edge=(-?[0-9.]+)s attach=(-?[0-9.]+)s/g)) {
    const [, l, e, a] = m.map(Number);
    if (l >= 0) nums.latency.push(l);
    if (e >= 0) nums.edge.push(e);
    if (a >= 0) nums.attach.push(a);
  }
  const med = (xs) => (xs.length ? xs.slice().sort((x, y) => x - y)[Math.floor(xs.length / 2)] : NaN);
  const llSamples = (result.text.match(/mode=low-latency/g) || []).length;
  const ordinary = (result.text.match(/mode=ordinary-live/g) || []).length;
  return {
    ...result,
    pass,
    verdictLine,
    mode: llSamples > ordinary ? 'low-latency' : (ordinary ? 'ordinary-live' : 'unknown'),
    llSamples,
    ordinarySamples: ordinary,
    samples: nums.latency.length,
    latency: med(nums.latency),
    edge: med(nums.edge),
    attach: med(nums.attach),
  };
}

function fixed(v) {
  return Number.isFinite(v) ? v.toFixed(2) : ' n/a';
}

async function main() {
  const ffmpeg = helperPath('ffmpeg');
  const mediamtx = helperPath('mediamtx');
  if (!isExecutable(ffmpeg) && ffmpeg === 'ffmpeg') log('note: using ffmpeg from PATH');
  if (!isExecutable(mediamtx) && mediamtx === 'mediamtx') log('note: using mediamtx from PATH');

  const rootWork = await fs.mkdtemp(path.join(os.tmpdir(), 'pp-soak-lab-'));
  if (!KEEP_WORK) registerCleanup(() => fs.rm(rootWork, { recursive: true, force: true }));
  log(`work: ${rootWork}`);

  const origin = await startOrigin(rootWork, { room: ROOM, token: TOKEN });
  log(`origin: ${origin.base}`);

  const stack = await startRealStack(rootWork, ffmpeg, mediamtx, {
    relayOrigin: origin.base,
    relayToken: TOKEN,
    relayPush: true,
    name: 'PartyParty Soak Lab',
  });
  log(`stack: http=${stack.httpPort} tls=${stack.tlsPort} hls=${stack.hlsPort}`);

  // The plaintext console port serves the same handler as the guest port, so
  // /live reaches the same proxy and the same rewrite. Prove it rather than
  // assume it: a run against a URL that does not carry the schedule is exactly
  // the mistake this lab exists to stop repeating.
  const directUrl = `http://127.0.0.1:${stack.httpPort}/live/party/index.m3u8`;
  const directProbe = await getInsecure(directUrl, 4000);
  if (directProbe.status !== 200 || !directProbe.body.includes('#EXTM3U')) {
    fail(`the plaintext /live path did not serve a playlist (HTTP ${directProbe.status}). `
      + `Without it no arm can be measured, because AVPlayer will not attach to the lab's throwaway certificate.`);
  }

  // The relay arm needs contribution to have actually reached the origin.
  const relayUrl = `${origin.base}/stream.m3u8`;
  await waitFor(async () => {
    const r = await getInsecure(relayUrl, 3000);
    return r.status === 200 && r.body.includes('#EXTM3U');
  }, { timeoutMs: 60000, label: 'contribution reaching the loopback origin' });
  log('relay: contribution is landing on the origin');

  const armBin = await soakArmBinary(rootWork);
  const upstream = `http://127.0.0.1:${stack.httpPort}`;
  const keep = await startArmProxy(armBin, rootWork, { name: 'keep', pin: 'keep', upstream });
  const strip = await startArmProxy(armBin, rootWork, { name: 'strip', pin: 'strip', upstream });
  // Two hold-backs, moved in opposite directions from the 3.0s the stream falls
  // to by default. One arm that agrees with a prediction proves little; an arm
  // that tracks the value UP and another that tracks it DOWN is a lever.
  const hbLow = await startArmProxy(armBin, rootWork, { name: 'hb15', holdBack: 1.5, upstream });
  const hbSame = await startArmProxy(armBin, rootWork, { name: 'hb30', holdBack: 3.0, upstream });
  const hbHigh = await startArmProxy(armBin, rootWork, { name: 'hb50', holdBack: 5.0, upstream });

  const arms = [
    { label: 'direct', url: directUrl },
    { label: 'proxy-keep', url: `${keep.base}/live/party/index.m3u8` },
    { label: 'proxy-strip', url: `${strip.base}/live/party/index.m3u8` },
    { label: 'holdback-1.5', url: `${hbLow.base}/live/party/index.m3u8` },
    { label: 'holdback-3.0', url: `${hbSame.base}/live/party/index.m3u8` },
    { label: 'holdback-5.0', url: `${hbHigh.base}/live/party/index.m3u8` },
    { label: 'relay', url: relayUrl },
  ];

  log('\n>> what each arm is serving');
  const manifests = {};
  for (const arm of arms) {
    const d = await describeManifest(arm.url);
    manifests[arm.label] = d;
    log(`   ${arm.label.padEnd(12)} tier=${d.tier.padEnd(12)} multivariant-start=${d.start}`);
    log(`   ${''.padEnd(12)} TARGETDURATION=${d.targetDuration} PART-TARGET=${d.partTarget} PART-HOLD-BACK=${d.holdback} media-start=${d.mediaStart}`);
    log(`   ${''.padEnd(12)} ${d.serverControl}`);
  }
  if (manifests['proxy-strip'].start !== 'absent') {
    fail('the pin-strip arm still carries EXT-X-START; the experiment has no independent variable');
  }
  if (manifests['direct'].start === 'absent') {
    fail('the direct arm carries no EXT-X-START; the shipping path is not what is being measured');
  }

  const playerBin = await soakPlayerBinary(rootWork);
  log(`\n>> soaking ${arms.length} arms concurrently for ${MINUTES} minute(s)`);
  const results = (await Promise.all(arms.map((a) => runSoak(playerBin, { ...a, workDir: rootWork })))).map(summarise);

  log('\n================ SOAK LAB ================');
  log('arm           tier          pin      latency  =   edge  +  attach   AVPlayer mode  verdict');
  for (const r of results) {
    const m = manifests[r.label];
    const pin = m.start === 'absent' ? 'none' : 'master';
    log(`${r.label.padEnd(13)} ${m.tier.padEnd(13)} ${pin.padEnd(8)} ${fixed(r.latency)}s   ${fixed(r.edge)}s   ${fixed(r.attach)}s   ${r.mode.padEnd(14)} ${r.pass ? 'PASS' : 'FAIL'}`);
  }

  const byLabel = Object.fromEntries(results.map((r) => [r.label, r]));
  log('\n---- reading it ----');
  const controlDelta = Math.abs(byLabel['proxy-keep'].attach - byLabel['direct'].attach);
  if (!Number.isFinite(controlDelta)) {
    log('CONTROL INVALID: an arm produced no attach measurement. Draw no conclusion about the pin.');
  } else if (controlDelta > 0.35) {
    log(`CONTROL FAILED: proxy-keep attach differs from direct by ${controlDelta.toFixed(2)}s. The lab proxy is`);
    log('distorting the measurement, exactly as scripts/bench-playlist-proxy.py did. The pin arm below');
    log('proves nothing and must not be quoted.');
  } else {
    log(`control ok: proxy-keep reproduces direct within ${controlDelta.toFixed(2)}s, so the lab proxy is transparent.`);
    const pinEffect = byLabel['proxy-keep'].attach - byLabel['proxy-strip'].attach;
    log(`pin effect on attachment: ${pinEffect >= 0 ? '+' : ''}${pinEffect.toFixed(2)}s `
      + `(with pin ${fixed(byLabel['proxy-keep'].attach)}s, without ${fixed(byLabel['proxy-strip'].attach)}s).`);
    if (Math.abs(pinEffect) < 0.35) {
      log('INERT: EXT-X-START in the multivariant playlist does not move where AVPlayer attaches.');
      log('The room has no three-second cushion on any path, and the declared target is decorative.');
    } else {
      log('The pin moves the attachment point. Whether it reaches the declared target is the `direct` row above.');
    }
  }
  const baseline = byLabel['proxy-keep'].attach;
  const hb = {
    1.5: byLabel['holdback-1.5'],
    3.0: byLabel['holdback-3.0'],
    5.0: byLabel['holdback-5.0'],
  };
  log(`explicit segment HOLD-BACK, against an undeclared baseline of ${fixed(baseline)}s:`);
  for (const [value, r] of Object.entries(hb)) {
    const played = r.samples > 0 && Number.isFinite(r.attach);
    log(`   HOLD-BACK=${value}  ->  ${played ? `attach ${fixed(r.attach)}s` : 'THE PLAYER NEVER PLAYED'}`);
  }
  const target = Number(manifests['direct'].targetDuration);
  const floor = Number.isFinite(target) ? target * 3 : NaN;
  if (Number.isFinite(hb[5.0].attach) && hb[5.0].attach - baseline > 1.0) {
    log('HOLD-BACK IS A LEVER: declaring it moves where AVPlayer attaches, by about the amount declared.');
    log('The shipping media playlist declares PART-HOLD-BACK but NO HOLD-BACK, so the room inherits the');
    log(`HLS default of three target durations. gohlslib rounds TARGETDURATION to an integer second, so`);
    log(`that default is 3 x ${target}s = ${floor}s. The room's declared three-second cushion is a`);
    log('coincidence of that rounding, not something the code asks for, and it would move on its own if');
    log('the segment duration ever changed.');
  } else {
    log('HOLD-BACK did not move the attachment point. Neither tag under test is a lever here.');
  }
  if (!(hb[1.5].samples > 0)) {
    log(`The 1.5s arm did not play at all, which is the HLS floor asserting itself: HOLD-BACK below three`);
    log(`target durations (${floor}s here) is invalid, and AVPlayer refuses the playlist outright rather`);
    log('than holding back less. HOLD-BACK can lengthen the cushion. It cannot shorten it below that floor.');
  }
  const relayEdge = byLabel['relay'].edge;
  log(`relay transport floor on loopback: edge ${fixed(relayEdge)}s, attach ${fixed(byLabel['relay'].attach)}s.`);
  log('A venue adds wide-area delay on top of that edge; it never reduces it.');

  const outDir = path.join(ROOT, 'build', `soak-lab-${stamp()}`);
  await fs.mkdir(outDir, { recursive: true });
  for (const r of results) {
    await fs.copyFile(r.logPath, path.join(outDir, `soak-${r.label}.log`));
  }
  await fs.writeFile(path.join(outDir, 'manifests.json'), JSON.stringify(manifests, null, 2));
  for (const name of ['keep', 'strip', 'hb15', 'hb30', 'hb50']) {
    const src = path.join(rootWork, `soakarm-${name}.log`);
    try { await fs.copyFile(src, path.join(outDir, `soakarm-${name}.log`)); } catch {}
  }
  log(`\nreceipts: ${outDir}`);
  log('build/ is gitignored and `make clean` deletes it. Copy what matters into docs/receipts/.');

  const bad = results.filter((r) => !r.pass);
  if (bad.length) {
    log(`\n${bad.length} arm(s) did not pass. That is a result, not necessarily a defect in the run:`);
    for (const r of bad) log(`   ${r.label}: ${r.verdictLine}`);
  }
}

main()
  .then(async () => { await cleanup(); process.exit(0); })
  .catch(async (err) => {
    console.error(`\nsoak-lab failed: ${err.message}`);
    if (err.cause) console.error(`cause: ${err.cause.message || err.cause}`);
    await cleanup();
    process.exit(1);
  });
