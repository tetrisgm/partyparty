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

export function analyzeText(text, source = '<stdin>') {
  const counts = {};
  const clients = new Map();
  const opens = [];
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
        ref: fields.ref || '',
        why: fields.why || '',
      };
      opens.push(open);
      client.opens.push(open);
    }
  }

  const cohorts = summarizeCohorts(opens);
  const clientsOut = [...clients.values()].map((c) => ({
    ...c,
    alignedOpens: c.opens.filter((o) => o.aligned).length,
    degradedOpens: c.opens.filter((o) => o.degraded || !o.aligned).length,
    maxSeeks: Math.max(0, ...c.opens.map((o) => o.seeks || 0), c.alignRequests),
  })).sort((a, b) => a.name.localeCompare(b.name));

  const degraded = opens.filter((o) => o.degraded || !o.aligned).length;
  const joinMs = opens.map((o) => o.joinMs).filter((v) => num(v) !== null);
  const maxJoinMs = joinMs.length ? Math.max(...joinMs) : null;
  const maxOpenSeeks = Math.max(0, ...opens.map((o) => o.seeks || 0));
  const maxCohortSpreadMs = Math.max(0, ...cohorts.map((c) => c.spreadMs));
  const warnings = [];

  for (const s of streamReady) {
    if (Math.abs(s.targetSec - 7) > 0.05) {
      warnings.push({ level: 'warn', message: `stream target is ${s.targetSec.toFixed(3)}s, expected 7.000s until physical evidence says otherwise` });
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
  console.log(`Problems: sync-failed=${c['sync-failed'] || 0} watchdog=${c['sync-watchdog'] || 0} stall=${c.stall || 0} rebuffer=${c.rebuffer || 0} reconnect=${c.reconnect || 0} audible-seek=${c['audible-seek'] || 0}`);
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
