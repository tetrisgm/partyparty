#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EVENT_RE = /^(\d\d):(\d\d):(\d\d)\.(\d{3}) \| ev\[(.*?)\] ([^ ]+)(?: (.*))?$/;
const STREAM_READY_RE = /stream sync ready: generation=(\d+) real=([0-9.]+)s gaps=([0-9.]+)s holdback=([0-9.]+)s target=([0-9.]+)s playlist=(.*)$/;
const KNOWN_KEYS = [
  'aligned', 'audible', 'before', 'buf', 'committed', 'corrected', 'correction',
  'degraded', 'error', 'first', 'gen', 'joinMs', 'lat', 'll', 'maxError',
  'mD', 'mMode', 'mPin', 'mSeek', // sync-approach tags (v53.61+): effective target/mode/pin/seek
  'quant', // v53.63+: open landed within expected native quantization (not genuinely degraded)
  'reroll', // v55+: Precise took a second muted draw before this open
  'muted', 'pos', 'progressAge', 'rate', 'real', 'ref', 'rs', 'samples', 'seek',
  'seeking', 'seeks', 'staleMs', 'target', 'used', 'want', 'why',
];

function timeToMs(h, m, s, ms) {
  return (((Number(h) * 60 + Number(m)) * 60 + Number(s)) * 1000) + Number(ms);
}

function scalar(v) {
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null') return null;
  if (/^-?(?:\d+|\d*\.\d+)$/.test(v)) return Number(v);
  return v;
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function bool(v) {
  return v === true || v === 'true';
}

export function parseFields(raw = '') {
  const out = {};
  const t = raw.match(/^\+([0-9.]+)ms(?: |$)/);
  if (t) out.t = Number(t[1]);
  const n = raw.match(/(?:^| )#([0-9.]+)(?: |$)/);
  if (n) out.n = Number(n[1]);
  for (const key of KNOWN_KEYS) {
    const re = new RegExp(`(?:^| )${key}=([^ ]*)`);
    const m = raw.match(re);
    if (m) out[key] = scalar(m[1]);
  }
  return out;
}

function emptyClient(name) {
  return {
    name,
    events: 0,
    counts: {},
    opens: [],
    failures: 0,
    watchdogs: 0,
    stalls: 0,
    reconnects: 0,
    alignRequests: 0,
    latestHealth: null,
  };
}

function inc(obj, key) {
  obj[key] = (obj[key] || 0) + 1;
}

function summarizeCohorts(opens, windowMs = 30000) {
  const usable = opens
    .filter((o) => num(o.lat) !== null && num(o.timeMs) !== null)
    .sort((a, b) => a.timeMs - b.timeMs);
  const cohorts = [];
  for (const open of usable) {
    const last = cohorts[cohorts.length - 1];
    if (!last || open.timeMs - last.lastMs > windowMs) {
      cohorts.push({ opens: [], firstMs: open.timeMs, lastMs: open.timeMs });
    }
    const c = cohorts[cohorts.length - 1];
    c.opens.push(open);
    c.lastMs = open.timeMs;
  }
  return cohorts.map((c, idx) => {
    const lats = c.opens.map((o) => o.lat);
    const min = Math.min(...lats);
    const max = Math.max(...lats);
    return {
      index: idx + 1,
      count: c.opens.length,
      spreadMs: Math.round((max - min) * 1000),
      minLatencySec: min,
      maxLatencySec: max,
      clients: c.opens.map((o) => o.client),
    };
  });
}

// Per sync-approach (v53.61+) rollup: the DJ flips the "Sync approach" radio and
// every guest re-aligns, stamping the effective mode on its audio-open + health
// telemetry (mMode/mSeek/mPin/mD). Grouping by mMode turns one party's log into a
// head-to-head: per approach, how many devices reached audio vs stayed silent
// (the #1 priority), the startup spread, and the latency band.
function approachBucket(map, mode) {
  let a = map.get(mode);
  if (!a) {
    a = { mode, seek: null, pin: null, target: null, opens: [], openClients: new Set(), seenClients: new Set() };
    map.set(mode, a);
  }
  return a;
}

export function analyzeText(text, source = '<stdin>') {
  const counts = {};
  const seen = new Set(); // (client, seq) dedupe of re-uploaded batches
  const clients = new Map();
  const opens = [];
  const approaches = new Map(); // mMode -> approachBucket
  const streamReady = [];
  const lines = text.split(/\r?\n/);

  for (const line of lines) {
    const sr = line.match(STREAM_READY_RE);
    if (sr) {
      streamReady.push({
        generation: Number(sr[1]),
        realHistorySec: Number(sr[2]),
        gapHistorySec: Number(sr[3]),
        holdbackSec: Number(sr[4]),
        targetSec: Number(sr[5]),
        playlist: sr[6],
      });
    }

    const ev = line.match(EVENT_RE);
    if (!ev) continue;
    const [, hh, mm, ss, ms, who, kind, rawFields = ''] = ev;
    const timeMs = timeToMs(hh, mm, ss, ms);
    const fields = parseFields(rawFields);
    // The uploader can re-send a batch (network retry), duplicating events in
    // the DJ log. Dedupe on (client, per-client sequence) when a seq exists.
    if (fields.n != null) {
      const dupKey = who + '#' + fields.n;
      if (seen.has(dupKey)) continue;
      seen.add(dupKey);
    }
    inc(counts, kind);

    if (!clients.has(who)) clients.set(who, emptyClient(who));
    const client = clients.get(who);
    client.events++;
    inc(client.counts, kind);

    if (kind === 'align-request') client.alignRequests++;
    if (kind === 'sync-failed') client.failures++;
    if (kind === 'sync-watchdog') client.watchdogs++;
    if (kind === 'stall' || kind === 'rebuffer') client.stalls++;
    if (kind === 'reconnect') client.reconnects++;
    if (kind === 'health' && num(fields.lat) !== null) {
      client.latestHealth = { lat: fields.lat, buf: fields.buf, ref: fields.ref, timeMs };
    }
    // Any event tagged with a sync approach (health fires continuously, so a phone
    // that is alive-but-silent under an approach is still "seen" under it).
    if (fields.mMode != null) {
      const a = approachBucket(approaches, String(fields.mMode));
      a.seenClients.add(who);
      if (num(fields.mSeek) !== null) a.seek = num(fields.mSeek);
      if (num(fields.mPin) !== null) a.pin = num(fields.mPin);
      if (num(fields.mD) !== null) a.target = num(fields.mD);
    }

    if (kind === 'audio-open') {
      const open = {
        client: who,
        timeMs,
        aligned: bool(fields.aligned),
        degraded: bool(fields.degraded),
        lat: num(fields.lat),
        joinMs: num(fields.joinMs),
        error: num(fields.error),
        maxError: num(fields.maxError),
        rate: num(fields.rate),
        seeks: num(fields.seeks),
        mode: fields.mMode != null ? String(fields.mMode) : null,
        ref: fields.ref || '',
        why: fields.why || '',
      };
      opens.push(open);
      client.opens.push(open);
      if (open.mode != null) {
        const a = approachBucket(approaches, open.mode);
        a.opens.push(open);
        a.openClients.add(who);
      }
    }
  }

  const cohorts = summarizeCohorts(opens);

  // Rank approaches for the A/B verdict: fewest silent devices first (the #1
  // priority), then tightest startup spread, then lowest latency.
  const approachesOut = [...approaches.values()].map((a) => {
    const lats = a.opens.map((o) => o.lat).filter((v) => num(v) !== null);
    const min = lats.length ? Math.min(...lats) : null;
    const max = lats.length ? Math.max(...lats) : null;
    const seen = a.seenClients.size;
    const opened = a.openClients.size;
    return {
      mode: a.mode,
      seek: a.seek,
      pin: a.pin,
      target: a.target,
      devicesSeen: seen,
      devicesOpened: opened,
      silent: Math.max(0, seen - opened),
      opens: a.opens.length,
      degraded: a.opens.filter((o) => o.degraded).length,
      minLatencySec: min,
      maxLatencySec: max,
      spreadMs: (min !== null && max !== null) ? Math.round((max - min) * 1000) : null,
      maxSeeks: Math.max(0, ...a.opens.map((o) => o.seeks || 0)),
    };
  }).sort((a, b) =>
    (a.silent - b.silent) ||
    ((a.spreadMs ?? Infinity) - (b.spreadMs ?? Infinity)) ||
    ((a.maxLatencySec ?? Infinity) - (b.maxLatencySec ?? Infinity)));
  const recommendation = approachesOut.find((a) => a.devicesOpened > 0)?.mode ?? null;

  const clientsOut = [...clients.values()].map((c) => ({
    ...c,
    alignedOpens: c.opens.filter((o) => o.aligned).length,
    degradedOpens: c.opens.filter((o) => o.degraded).length,
    maxSeeks: Math.max(0, ...c.opens.map((o) => o.seeks || 0), c.alignRequests),
  })).sort((a, b) => a.name.localeCompare(b.name));

  const degraded = opens.filter((o) => o.degraded).length;
  const joinMs = opens.map((o) => o.joinMs).filter((v) => num(v) !== null);
  const maxJoinMs = joinMs.length ? Math.max(...joinMs) : null;
  const maxOpenSeeks = Math.max(0, ...opens.map((o) => o.seeks || 0));
  const maxCohortSpreadMs = Math.max(0, ...cohorts.map((c) => c.spreadMs));
  const warnings = [];

  for (const s of streamReady) {
    // The room target is now approach-driven (presets: tight 2s / balanced ~3s /
    // deep 6s), so only flag values outside the sane LL-HLS band as suspect.
    if (s.targetSec < 1 || s.targetSec > 10) {
      warnings.push({ level: 'warn', message: `stream target is ${s.targetSec.toFixed(3)}s, outside the sane 1–10s range` });
    }
  }
  for (const a of approachesOut) {
    if (a.silent > 0) {
      warnings.push({ level: 'fail', message: `approach '${a.mode}': ${a.silent} device(s) polled but never opened audio (silent under this approach)` });
    }
  }
  if (opens.length === 0) {
    warnings.push({ level: 'warn', message: 'no audio-open events found; no listener startup acceptance can be computed' });
  }
  if ((counts['sync-watchdog'] || 0) > 0) {
    warnings.push({ level: 'fail', message: `${counts['sync-watchdog']} sync-watchdog event(s); muted startup exceeded the watchdog` });
  }
  if ((counts['sync-failed'] || 0) > 0) {
    warnings.push({ level: 'fail', message: `${counts['sync-failed']} sync-failed event(s); at least one listener reached the broken retry state` });
  }
  if ((counts['audible-seek'] || 0) > 0) {
    warnings.push({ level: 'fail', message: `${counts['audible-seek']} audible seek event(s); post-unmute app-directed seeks must stay zero` });
  }
  if ((counts['external-seek'] || 0) > 0) {
    warnings.push({ level: 'warn', message: `${counts['external-seek']} external seek(s) (lock-screen/OS scrub, not app code); each can park a guest behind — drift-reconnect should recover them` });
  }
  if (maxJoinMs !== null && maxJoinMs > 15000) {
    warnings.push({ level: 'fail', message: `slowest audio-open took ${Math.round(maxJoinMs)}ms; watchdog budget is 15000ms` });
  }
  if (opens.length && degraded / opens.length >= 0.05) {
    warnings.push({ level: degraded ? 'warn' : 'ok', message: `${degraded}/${opens.length} audio-open event(s) were degraded or timing-unverified` });
  }
  if (maxCohortSpreadMs > 1000) {
    warnings.push({ level: 'fail', message: `max startup cohort spread is ${maxCohortSpreadMs}ms; acceptance ceiling is 1000ms` });
  } else if (maxCohortSpreadMs > 500) {
    warnings.push({ level: 'warn', message: `max startup cohort spread is ${maxCohortSpreadMs}ms; typical target is <=500ms` });
  }
  if (maxOpenSeeks > 4) {
    warnings.push({ level: 'fail', message: `max muted startup seeks is ${maxOpenSeeks}; loop guard should cap at 4` });
  }

  return {
    source,
    totalLines: lines.length,
    eventCount: Object.values(counts).reduce((a, b) => a + b, 0),
    clientCount: clients.size,
    counts,
    startup: {
      audioOpens: opens.length,
      alignedOpens: opens.filter((o) => o.aligned).length,
      degradedOpens: degraded,
      maxJoinMs,
      maxOpenSeeks,
      maxCohortSpreadMs,
    },
    streamReady,
    cohorts,
    approaches: approachesOut,
    recommendation,
    clients: clientsOut,
    warnings,
  };
}

function latestLog() {
  const dir = path.join(os.homedir(), 'Library', 'Logs', 'partyparty');
  let entries = [];
  try {
    entries = fs.readdirSync(dir)
      .filter((name) => /^session-.*\.log$/.test(name))
      .map((name) => {
        const file = path.join(dir, name);
        return { file, mtime: fs.statSync(file).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
  } catch {
    return null;
  }
  return entries[0]?.file || null;
}

function fmtSec(v) {
  return v == null ? 'n/a' : `${Number(v).toFixed(3)}s`;
}

function printReport(summary) {
  console.log(`Session log: ${summary.source}`);
  console.log(`Events: ${summary.eventCount} across ${summary.clientCount} client(s)`);
  const c = summary.counts;
  console.log(`Startup: audio-open=${summary.startup.audioOpens} aligned=${summary.startup.alignedOpens} degraded=${summary.startup.degradedOpens} maxJoin=${summary.startup.maxJoinMs == null ? 'n/a' : `${Math.round(summary.startup.maxJoinMs)}ms`} maxSeeks=${summary.startup.maxOpenSeeks}`);
  console.log(`Problems: sync-failed=${c['sync-failed'] || 0} watchdog=${c['sync-watchdog'] || 0} stall=${c.stall || 0} rebuffer=${c.rebuffer || 0} reconnect=${c.reconnect || 0} audible-seek=${c['audible-seek'] || 0} external-seek=${c['external-seek'] || 0}`);
  console.log(`Recoveries: drift-reconnect=${c['drift-reconnect'] || 0} untracked-reconnect=${c['untracked-reconnect'] || 0}`);
  if (summary.streamReady.length) {
    console.log('\nStream sync readiness:');
    for (const s of summary.streamReady) {
      console.log(`  gen ${s.generation}: real=${fmtSec(s.realHistorySec)} gaps=${fmtSec(s.gapHistorySec)} holdback=${fmtSec(s.holdbackSec)} target=${fmtSec(s.targetSec)}`);
    }
  }
  if (summary.cohorts.length) {
    console.log('\nStartup cohorts:');
    for (const cohort of summary.cohorts) {
      console.log(`  #${cohort.index}: n=${cohort.count} spread=${cohort.spreadMs}ms lat=${fmtSec(cohort.minLatencySec)}..${fmtSec(cohort.maxLatencySec)}`);
    }
  }
  if (summary.approaches && summary.approaches.length) {
    console.log('\nSync approaches (A/B — best behaved first):');
    for (const a of summary.approaches) {
      const dials = `seek=${a.seek ?? '?'} pin=${a.pin ?? '?'} target=${a.target ?? '?'}s`;
      const silent = a.silent > 0 ? `  ⚠ SILENT=${a.silent}` : '';
      console.log(`  ${a.mode.padEnd(9)} ${dials.padEnd(28)} opened=${a.devicesOpened}/${a.devicesSeen} spread=${a.spreadMs == null ? 'n/a' : `${a.spreadMs}ms`} lat=${fmtSec(a.minLatencySec)}..${fmtSec(a.maxLatencySec)} degraded=${a.degraded} maxSeeks=${a.maxSeeks}${silent}`);
    }
    if (summary.recommendation) {
      console.log(`  → best behaved this session: ${summary.recommendation} (fewest silent, then tightest spread, then lowest latency)`);
    }
  }
  if (summary.clients.length) {
    console.log('\nClient outcomes:');
    for (const cl of summary.clients) {
      const latest = cl.latestHealth ? ` latestHealth=${fmtSec(cl.latestHealth.lat)} buf=${cl.latestHealth.buf ?? 'n/a'}` : '';
      console.log(`  ${cl.name}`);
      console.log(`    events=${cl.events} opens=${cl.opens.length} aligned=${cl.alignedOpens} degraded=${cl.degradedOpens} seeks=${cl.maxSeeks} failures=${cl.failures} watchdog=${cl.watchdogs} stalls=${cl.stalls} reconnects=${cl.reconnects}${latest}`);
    }
  }
  console.log('\nAcceptance:');
  if (!summary.warnings.length) {
    console.log('  PASS: no acceptance warnings found in this log');
  } else {
    for (const w of summary.warnings) {
      console.log(`  ${w.level.toUpperCase()}: ${w.message}`);
    }
  }
}

async function main(argv) {
  const json = argv.includes('--json');
  const strict = argv.includes('--strict');
  const files = argv.filter((a) => !a.startsWith('--'));
  const target = files[0] || latestLog();
  if (!target) {
    console.error('No session log supplied and none found in ~/Library/Logs/partyparty.');
    process.exit(1);
  }
  const text = fs.readFileSync(target, 'utf8');
  const summary = analyzeText(text, target);
  if (json) console.log(JSON.stringify(summary, null, 2));
  else printReport(summary);
  if (strict && summary.warnings.some((w) => w.level === 'fail')) process.exit(2);
}

const self = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === self) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err && err.stack || err);
    process.exit(1);
  });
}
