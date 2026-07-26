#!/usr/bin/env node
import assert from 'node:assert/strict';
import { analyzeText, parseFields } from './analyze-session-log.mjs';

assert.deepEqual(parseFields('+1200ms #7 lat=3.125 target=3 app=true why=join'), {
  t: 1200,
  n: 7,
  app: true,
  lat: 3.125,
  target: 3,
  why: 'join',
});

const good = `
03:01:01.100 | stream sync ready: generation=1 real=3.021s gaps=14.037s holdback=0.513s part=0.171s target=3.000s playlist=2026-07-26T03:01:01Z
03:01:04.000 | ev[iPhone A | 192.168.1.10 cid-a.tab-a v115.87 guest] audio-open +2900ms #1 why=join target=3 lat=3.050 joinMs=2900 ref=pdt rate=1 seeks=0
03:01:04.200 | ev[iPhone B | 192.168.1.11 cid-b.tab-b v115.87 guest] audio-open +3100ms #1 why=join target=3 lat=3.350 joinMs=3100 ref=pdt rate=1 seeks=0
03:01:12.000 | ev[iPhone A | 192.168.1.10 cid-a.tab-a v115.87 guest] health +10900ms #2 lat=3.100 buf=2.5 ref=pdt
03:01:12.200 | ev[iPhone B | 192.168.1.11 cid-b.tab-b v115.87 guest] health +11100ms #2 lat=3.400 buf=2.2 ref=pdt
03:01:20.000 | ev[iPhone A | 192.168.1.10 cid-a.tab-a v115.87 guest] gov-seek +18900ms #3 lat=4.1 late=1.1 before=20 want=21.1
03:01:20.010 | ev[iPhone A | 192.168.1.10 cid-a.tab-a v115.87 guest] audible-seek +18910ms #4 pos=21.1 lat=3 app=true
`;

let summary = analyzeText(good, 'good.log');
assert.equal(summary.eventCount, 6);
assert.equal(summary.clientCount, 2);
assert.equal(summary.startup.audioOpens, 2);
assert.equal(summary.startup.maxSpreadMs, 300);
assert.equal(summary.steady.maxSpreadMs, 300);
assert.equal(summary.streamReady[0].partTargetSec, 0.171);
assert.equal(summary.clients[0].governorSeeks, 1);
assert.deepEqual(summary.warnings, []);

const badContract = good
  .replace('holdback=0.513s', 'holdback=0.400s')
  .replace('target=3.000s', 'target=4.000s');
summary = analyzeText(badContract, 'bad-contract.log');
assert.ok(summary.warnings.some((warning) => warning.message.includes('fixed room contract')));
assert.ok(summary.warnings.some((warning) => warning.message.includes('below 3x PART-TARGET')));

const wide = `
03:02:00.000 | ev[iPhone A] audio-open +3000ms #1 why=join target=3 lat=3.0 joinMs=3000 ref=pdt
03:02:00.100 | ev[iPhone B] audio-open +3100ms #1 why=join target=3 lat=4.2 joinMs=3100 ref=pdt
03:02:12.000 | ev[iPhone A] health +15000ms #2 lat=3.0 buf=2 ref=pdt
03:02:12.100 | ev[iPhone B] health +15100ms #2 lat=4.3 buf=2 ref=pdt
`;
summary = analyzeText(wide, 'wide.log');
assert.equal(summary.startup.maxSpreadMs, 1200);
assert.equal(summary.steady.maxSpreadMs, 1300);
assert.ok(summary.warnings.some((warning) => warning.level === 'fail' && warning.message.includes('startup cohort')));
assert.ok(summary.warnings.some((warning) => warning.level === 'fail' && warning.message.includes('steady-state room')));

const external = analyzeText(good + '\n03:03:00.000 | ev[iPhone A] external-seek +50000ms #5 pos=50 lat=9 app=false\n', 'external.log');
assert.ok(external.warnings.some((warning) => warning.level === 'warn' && warning.message.includes('external seek')));

const duplicate = '03:04:00.000 | ev[iPhone C] stall +9000ms #5 buf=0 lat=5\n';
summary = analyzeText(duplicate + duplicate + duplicate, 'duplicate.log');
assert.equal(summary.counts.stall, 1);

console.log('PASS session log analyzer');
