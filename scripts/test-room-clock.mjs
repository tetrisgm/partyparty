import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { readNativeTimeline } from './lib/native-clock.mjs';

const html = fs.readFileSync(new URL('../web/listener.html', import.meta.url), 'utf8');
const clockCode = html.slice(html.indexOf('    // Room clock.'), html.indexOf('    function currentTimelineOrigin'));
assert.ok(clockCode.length > 1000);
let mono = 1000, wall = 1700000000000, uncertainty = 0, override = null;
const context = vm.createContext({
  performance: { now: () => mono }, Date: { now: () => wall },
  selectedDJId: '', discoveredPeers: [], AbortController,
  logEvent() {}, rnd: x => x,
  setTimeout: (fn, ms) => { if (ms === 80) { mono += ms; wall += ms; queueMicrotask(fn); } return 1; },
  clearTimeout() {},
  fetch: async () => {
    mono += 10; wall += 10;
    return { ok: true, json: async () => override || { received: wall - 5, sent: wall - 5, uncertaintyMs: uncertainty } };
  },
});
vm.runInContext(clockCode, context);
const read = expression => vm.runInContext(expression, context);
await read('syncClock()');
assert.equal(read('clockReliable()'), true);
assert.ok(Math.abs(read('serverNow()') - wall) < 0.001);
const previous = read('serverNow()');
wall += 60000; mono += 100;
assert.equal(read('serverNow()'), previous + 100, 'phone wall-clock change must not change source time');
assert.equal(read('clockReliable()'), false, 'sleep/clock discontinuity requires recalibration');
await read('syncClock()');
assert.equal(read('clockReliable()'), true);
mono += 76000; wall += 76000;
assert.equal(read('clockReliable()'), false, 'old clock estimate must expire');
uncertainty = 150;
await read('syncClock()');
assert.equal(read('clockReliable()'), false, 'relay uncertainty must propagate to the listener');
const normalFetch = context.fetch;
const delays = [10,40,80,120,140,180];
context.fetch = async () => {
  const delay = delays.shift();
  mono += delay; wall += delay;
  return {ok:true, json:async()=>({received:wall-delay/2, sent:wall-delay/2})};
};
await read('syncClock()');
assert.ok(read('clockUncertainty') >= 40, 'uncertainty must cover all selected exchanges, not only the fastest RTT');
const upstreamBounds=[100,80,60,2,1,0];
context.fetch=async()=>{
  mono+=10;wall+=10;
  return {ok:true,json:async()=>({received:wall-5,sent:wall-5,uncertaintyMs:upstreamBounds.shift()})};
};
await read('syncClock()');
assert.ok(read('clockUncertainty')<10,'fresh relay calibrations were displaced by fast but uncertain responses');
context.fetch = normalFetch;
uncertainty = 0;
override = { received: null, sent: null, t: null };
assert.equal(await read('clockSample("/api/time")'), null, 'null timestamps are not epoch zero');
override = { received: wall, sent: wall + 500 };
assert.equal(await read('clockSample("/api/time")'), null, 'impossible server duration must be rejected');

// A reset can occur while a fetch awaits a reply, including A -> B -> A DJs.
// A stale reply must neither install an estimate nor clear the new flight.
override = null;
let resolveOld;
context.fetch = () => new Promise(resolve => { resolveOld = resolve; });
const oldFlight = read('syncClock()');
read('resetClock()');
context.fetch = async () => ({ ok: true, json: async () => ({ received: wall, sent: wall }) });
const newFlight = read('syncClock()');
resolveOld({ ok: true, json: async () => ({ received: wall + 999999, sent: wall + 999999 }) });
await Promise.all([oldFlight, newFlight]);
assert.ok(Math.abs(read('serverNow()') - wall) < 100, 'old generation contaminated the new room clock');
assert.equal(read('clockReliable()'), true);

const origin = 1700000000255;
const cue = (start, offset=0) => ({ startTime: start, type:'com.apple.quicktime.HLS', value:{key:'X-PP-TIME',data:String(origin+start*1000+offset)} });
const metadataMedia = {textTracks:[{kind:'metadata',mode:'disabled',cues:[cue(1),cue(2),cue(3)]}]};
assert.equal(readNativeTimeline(metadataMedia, 1700000000000), origin, 'date-range cues recover fractional origin');
assert.equal(metadataMedia.textTracks[0].mode, 'hidden');
assert.equal(readNativeTimeline(metadataMedia, 1700000004000), null, 'old attachment cues must be rejected');
metadataMedia.textTracks[0].cues = [cue(1),cue(2,100)];
assert.equal(readNativeTimeline(metadataMedia, 1700000000000), null, 'disagreeing cue timestamps must not steer playback');
metadataMedia.textTracks[0].cues = [cue(0),cue(1)];
assert.equal(readNativeTimeline(metadataMedia, 1700000000000), null, 'a clamped cue is not a valid reference');
console.log('PASS room clock: monotonic anchor, expiry, uncertainty, malformed replies, reset race, native cue precision');
