#!/usr/bin/env node
import assert from 'node:assert/strict';
import { analyzeText, parseFields } from './analyze-session-log.mjs';

assert.deepEqual(parseFields('+1200ms #7 lat=6.982 aligned=true degraded=false joinMs=6123 seeks=1 ref=pdt'), {
  t: 1200,
  n: 7,
  lat: 6.982,
  aligned: true,
  degraded: false,
  joinMs: 6123,
  seeks: 1,
  ref: 'pdt',
});

const sample = `
03:01:01.100 | stream sync ready: generation=1 real=8.021s gaps=14.037s holdback=2.507s target=7.000s playlist=https://127.0.0.1/live/party/index.m3u8
03:01:02.000 | ev[iPhone A | 192.168.1.10 cid-a.tab-a v48.59 guest] open +0ms #1 ua=Mobile
03:01:04.000 | ev[iPhone A | 192.168.1.10 cid-a.tab-a v48.59 guest] align-request +2000ms #2 lat=8.200 target=7.000 correction=1.200 seek=1
03:01:07.000 | ev[iPhone A | 192.168.1.10 cid-a.tab-a v48.59 guest] audio-open +5000ms #3 why=join aligned=true degraded=false ref=pdt lat=6.980 joinMs=5200 error=-0.020 maxError=0.050 rate=1 seeks=1
03:01:07.120 | ev[iPhone B | 192.168.1.11 cid-b.tab-b v48.59 guest] audio-open +5120ms #4 why=join aligned=true degraded=false ref=pdt lat=7.120 joinMs=6100 error=0.120 maxError=0.160 rate=1 seeks=0
03:01:17.000 | ev[iPhone A | 192.168.1.10 cid-a.tab-a v48.59 guest] health +15000ms #5 lat=6.990 buf=3.5 ref=pdt
`;

let summary = analyzeText(sample, 'sample.log');
assert.equal(summary.eventCount, 5);
assert.equal(summary.clientCount, 2);
assert.equal(summary.startup.audioOpens, 2);
assert.equal(summary.startup.alignedOpens, 2);
assert.equal(summary.startup.degradedOpens, 0);
assert.equal(summary.startup.maxOpenSeeks, 1);
assert.equal(summary.startup.maxCohortSpreadMs, 140);
assert.equal(summary.cohorts.length, 1);
assert.equal(summary.streamReady[0].targetSec, 7);
assert.deepEqual(summary.warnings, []);

const bad = sample
  .replace('target=7.000s', 'target=5.000s')
  + '03:01:20.000 | ev[iPad | 192.168.1.12 cid-c.tab-c v48.59 guest] sync-watchdog +15000ms #9 lat=16.4 ref=pdt seeks=4\n'
  + '03:01:20.500 | ev[iPad | 192.168.1.12 cid-c.tab-c v48.59 guest] sync-failed +15500ms #10 why=join lat=16.4 seeks=4\n';
summary = analyzeText(bad, 'bad.log');
assert.equal(summary.counts['sync-watchdog'], 1);
assert.equal(summary.counts['sync-failed'], 1);
assert.ok(summary.warnings.some((w) => w.message.includes('expected 7.000s')));
assert.ok(summary.warnings.some((w) => w.message.includes('sync-watchdog')));
assert.ok(summary.warnings.some((w) => w.message.includes('sync-failed')));

console.log('PASS session log analyzer');
