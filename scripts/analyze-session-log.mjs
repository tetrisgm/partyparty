#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EVENT_RE = /^(\d\d):(\d\d):(\d\d)\.(\d{3}) \| ev\[(.*?)\] ([^ ]+)(?: (.*))?$/;
const STREAM_READY_RE = /stream sync ready: generation=(\d+) real=([0-9.]+)s gaps=([0-9.]+)s holdback=([0-9.]+)s part=([0-9.]+)s target=([0-9.]+)s playlist=(.*)$/;
const ROOM_TARGET_SEC = 3;
const MAX_ROOM_SPREAD_MS = 1000;
const KNOWN_KEYS = [
  'app', 'audible', 'audibleSeeks', 'before', 'buf', 'committed', 'err',
  'first', 'gen', 'joinMs', 'lat', 'late', 'll', 'maxStallMs', 'ms', 'muted',
  'pdt', 'pos', 'progressAge', 'rate', 'ready', 'real', 'ref', 'rs', 'samples',
  'seeks', 'stallMs', 'stalls', 'staleMs', 'streamReady', 'target', 'used',
  'v', 'want', 'warm', 'why',
];

function timeToMs(h, m, s, ms) {
  return (((Number(h) * 60 + Number(m)) * 60 + Number(s)) * 1000) + Number(ms);
}

function scalar(value) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null') return null;
  if (/^-?(?:\d+|\d*\.\d+)$/.test(value)) return Number(value);
  return value;
}

function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function parseFields(raw = '') {
  const out = {};
  const elapsed = raw.match(/^\+([0-9.]+)ms(?: |$)/);
  if (elapsed) out.t = Number(elapsed[1]);
  const sequence = raw.match(/(?:^| )#([0-9.]+)(?: |$)/);
  if (sequence) out.n = Number(sequence[1]);
  for (const key of KNOWN_KEYS) {
    const match = raw.match(new RegExp(`(?:^| )${key}=([^ ]*)`));
    if (match) out[key] = scalar(match[1]);
  }
  return out;
}

function inc(object, key) {
  object[key] = (object[key] || 0) + 1;
}

function emptyClient(name) {
  return {
    name,
    events: 0,
    counts: {},
    opens: [],
    health: [],
    stalls: 0,
    reconnects: 0,
    governorSeeks: 0,
    externalSeeks: 0,
    latestHealth: null,
  };
}

function startupCohorts(opens, windowMs = 30000) {
  const usable = opens
    .filter((sample) => num(sample.lat) !== null)
    .sort((a, b) => a.timeMs - b.timeMs);
  const groups = [];
  for (const sample of usable) {
    const last = groups[groups.length - 1];
    if (!last || sample.timeMs - last.firstMs > windowMs) {
      groups.push({ samples: [], firstMs: sample.timeMs });
    }
    groups[groups.length - 1].samples.push(sample);
  }
  return groups.map((group, index) => summarizeSpread(group.samples, index + 1));
}

function healthWindows(samples, windowMs = 15000) {
  const buckets = new Map();
  for (const sample of samples) {
    if (num(sample.lat) === null) continue;
    const key = Math.floor(sample.timeMs / windowMs);
    if (!buckets.has(key)) buckets.set(key, new Map());
    buckets.get(key).set(sample.client, sample);
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([key, byClient]) => summarizeSpread([...byClient.values()], key))
    .filter((window) => window.count >= 2);
}

function summarizeSpread(samples, index) {
  const lats = samples.map((sample) => sample.lat);
  const min = Math.min(...lats);
  const max = Math.max(...lats);
  return {
    index,
    count: samples.length,
    spreadMs: Math.round((max - min) * 1000),
    minLatencySec: min,
    maxLatencySec: max,
    clients: samples.map((sample) => sample.client),
  };
}

function spreadWarnings(warnings, label, windows) {
  const max = Math.max(0, ...windows.map((window) => window.spreadMs));
  if (max > MAX_ROOM_SPREAD_MS) {
    warnings.push({ level: 'fail', message: `${label} spread reached ${max}ms; room ceiling is ${MAX_ROOM_SPREAD_MS}ms` });
  } else if (max > 500) {
    warnings.push({ level: 'warn', message: `${label} spread reached ${max}ms; preferred band is <=500ms` });
  }
  return max;
}

export function analyzeText(text, source = '<stdin>') {
  const counts = {};
  const seen = new Set();
  const clients = new Map();
  const opens = [];
  const health = [];
  const streamReady = [];
  const lines = text.split(/\r?\n/);

  for (const line of lines) {
    const ready = line.match(STREAM_READY_RE);
    if (ready) {
      streamReady.push({
        generation: Number(ready[1]),
        realHistorySec: Number(ready[2]),
        gapHistorySec: Number(ready[3]),
        holdbackSec: Number(ready[4]),
        partTargetSec: Number(ready[5]),
        targetSec: Number(ready[6]),
        playlist: ready[7],
      });
    }

    const event = line.match(EVENT_RE);
    if (!event) continue;
    const [, hh, mm, ss, ms, who, kind, rawFields = ''] = event;
    const timeMs = timeToMs(hh, mm, ss, ms);
    const fields = parseFields(rawFields);
    if (fields.n != null) {
      const duplicateKey = `${who}#${fields.n}`;
      if (seen.has(duplicateKey)) continue;
      seen.add(duplicateKey);
    }

    inc(counts, kind);
    if (!clients.has(who)) clients.set(who, emptyClient(who));
    const client = clients.get(who);
    client.events++;
    inc(client.counts, kind);
    if (kind === 'stall' || kind === 'rebuffer') client.stalls++;
    if (kind === 'reconnect' || kind === 'untracked-reconnect') client.reconnects++;
    if (kind === 'audible-seek' && fields.app === true) client.governorSeeks++;
    if (kind === 'external-seek' || (kind === 'audible-seek' && fields.app !== true)) client.externalSeeks++;

    if (kind === 'audio-open') {
      const open = {
        client: who,
        timeMs,
        lat: num(fields.lat),
        target: num(fields.target),
        joinMs: num(fields.joinMs),
        rate: num(fields.rate),
        ref: fields.ref || '',
        why: fields.why || '',
      };
      opens.push(open);
      client.opens.push(open);
    }
    if (kind === 'health' && num(fields.lat) !== null) {
      const sample = { client: who, timeMs, lat: fields.lat, buf: num(fields.buf), ref: fields.ref || '' };
      health.push(sample);
      client.health.push(sample);
      client.latestHealth = sample;
    }
  }

  const cohorts = startupCohorts(opens);
  const steadyWindows = healthWindows(health);
  const joinTimes = opens.map((open) => open.joinMs).filter((value) => num(value) !== null);
  const maxJoinMs = joinTimes.length ? Math.max(...joinTimes) : null;
  const warnings = [];

  for (const ready of streamReady) {
    if (Math.abs(ready.targetSec - ROOM_TARGET_SEC) > 0.01) {
      warnings.push({ level: 'fail', message: `stream target is ${ready.targetSec.toFixed(3)}s; fixed room contract is ${ROOM_TARGET_SEC.toFixed(3)}s` });
    }
    if (ready.partTargetSec <= 0 || ready.holdbackSec + 0.001 < ready.partTargetSec * 3) {
      warnings.push({ level: 'fail', message: `playlist PART-HOLD-BACK ${ready.holdbackSec.toFixed(3)}s is below 3x PART-TARGET ${ready.partTargetSec.toFixed(3)}s` });
    }
  }
  for (const open of opens) {
    if (open.target !== null && Math.abs(open.target - ROOM_TARGET_SEC) > 0.01) {
      warnings.push({ level: 'fail', message: `${open.client} opened against target ${open.target.toFixed(3)}s instead of ${ROOM_TARGET_SEC.toFixed(3)}s` });
    }
    if (open.lat !== null && open.lat > ROOM_TARGET_SEC + 6) {
      warnings.push({ level: 'fail', message: `${open.client} opened ${open.lat.toFixed(3)}s behind, more than 6s past target` });
    } else if (open.lat !== null && open.lat > ROOM_TARGET_SEC + 1) {
      warnings.push({ level: 'warn', message: `${open.client} opened ${open.lat.toFixed(3)}s behind, outside the target +1s band` });
    }
  }
  if (opens.length === 0) {
    warnings.push({ level: 'warn', message: 'no audio-open events found; listener startup acceptance cannot be computed' });
  }
  if (maxJoinMs !== null && maxJoinMs > 15000) {
    warnings.push({ level: 'fail', message: `slowest audio-open took ${Math.round(maxJoinMs)}ms; join watchdog is 15000ms` });
  }
  if ((counts['gov-error'] || 0) > 0) {
    warnings.push({ level: 'fail', message: `${counts['gov-error']} native governor error event(s)` });
  }
  if ((counts['external-seek'] || 0) > 0) {
    warnings.push({ level: 'warn', message: `${counts['external-seek']} external seek(s); verify the governor returned each visible phone to the room band` });
  }
  if ((counts['untracked-reconnect'] || 0) > 0) {
    warnings.push({ level: 'warn', message: `${counts['untracked-reconnect']} untracked timeline reattachment(s)` });
  }

  const maxStartupSpreadMs = spreadWarnings(warnings, 'startup cohort', cohorts);
  const maxSteadySpreadMs = spreadWarnings(warnings, 'steady-state room', steadyWindows);
  const clientsOut = [...clients.values()].sort((a, b) => a.name.localeCompare(b.name));

  return {
    source,
    totalLines: lines.length,
    eventCount: Object.values(counts).reduce((sum, count) => sum + count, 0),
    clientCount: clients.size,
    counts,
    startup: { audioOpens: opens.length, maxJoinMs, maxSpreadMs: maxStartupSpreadMs },
    steady: { samples: health.length, windows: steadyWindows.length, maxSpreadMs: maxSteadySpreadMs },
    streamReady,
    cohorts,
    steadyWindows,
    clients: clientsOut,
    warnings,
  };
}

function latestLog() {
  const dir = path.join(os.homedir(), 'Library', 'Logs', 'partyparty');
  try {
    return fs.readdirSync(dir)
      .filter((name) => /^session-.*\.log$/.test(name))
      .map((name) => {
        const file = path.join(dir, name);
        return { file, mtime: fs.statSync(file).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime)[0]?.file || null;
  } catch {
    return null;
  }
}

function fmtSec(value) {
  return value == null ? 'n/a' : `${Number(value).toFixed(3)}s`;
}

function printReport(summary) {
  const counts = summary.counts;
  console.log(`Session log: ${summary.source}`);
  console.log(`Events: ${summary.eventCount} across ${summary.clientCount} client(s)`);
  console.log(`Startup: opens=${summary.startup.audioOpens} maxJoin=${summary.startup.maxJoinMs == null ? 'n/a' : `${Math.round(summary.startup.maxJoinMs)}ms`} maxSpread=${summary.startup.maxSpreadMs}ms`);
  console.log(`Steady room: samples=${summary.steady.samples} comparedWindows=${summary.steady.windows} maxSpread=${summary.steady.maxSpreadMs}ms`);
  console.log(`Playback: stalls=${counts.stall || 0} rebuffer=${counts.rebuffer || 0} reconnect=${counts.reconnect || 0} governorSeeks=${counts['audible-seek'] || 0} externalSeeks=${counts['external-seek'] || 0}`);

  if (summary.streamReady.length) {
    console.log('\nStream readiness:');
    for (const ready of summary.streamReady) {
      console.log(`  gen ${ready.generation}: real=${fmtSec(ready.realHistorySec)} holdback=${fmtSec(ready.holdbackSec)} part=${fmtSec(ready.partTargetSec)} target=${fmtSec(ready.targetSec)}`);
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
    for (const client of summary.clients) {
      const latest = client.latestHealth ? ` latest=${fmtSec(client.latestHealth.lat)} buf=${client.latestHealth.buf ?? 'n/a'}` : '';
      console.log(`  ${client.name}: opens=${client.opens.length} stalls=${client.stalls} reconnects=${client.reconnects} governorSeeks=${client.governorSeeks} externalSeeks=${client.externalSeeks}${latest}`);
    }
  }
  console.log('\nAcceptance:');
  if (!summary.warnings.length) console.log('  PASS: no acceptance warnings found in this log');
  for (const warning of summary.warnings) console.log(`  ${warning.level.toUpperCase()}: ${warning.message}`);
}

async function main(argv) {
  const json = argv.includes('--json');
  const strict = argv.includes('--strict');
  const files = argv.filter((arg) => !arg.startsWith('--'));
  const target = files[0] || latestLog();
  if (!target) {
    console.error('No session log supplied and none found in ~/Library/Logs/partyparty.');
    process.exit(1);
  }
  const summary = analyzeText(fs.readFileSync(target, 'utf8'), target);
  if (json) console.log(JSON.stringify(summary, null, 2));
  else printReport(summary);
  if (strict && summary.warnings.some((warning) => warning.level === 'fail')) process.exit(2);
}

const self = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === self) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error?.stack || error);
    process.exit(1);
  });
}
