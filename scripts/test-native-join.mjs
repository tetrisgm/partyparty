import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createNativeJoin } from './lib/native-clock.mjs';

// Exercise the actual guest controller against an asynchronous media engine:
// seeking freezes progression for a nonzero, variable duration. An idealized
// instantaneous setter concealed the original controller's completion error.
function rig({ delay=1.2, metadataAt=0, seekDelays=[200], floor=-Infinity }={}) {
  let ms=0, position=100-delay, permitted=true, foreground=true, clock=true;
  let pending=null, seekIndex=0;
  const origin=1700000000000, moves=[], results=[];
  const media={
    muted:false, paused:false, seeking:false, readyState:4, playbackRate:1,
    get currentTime(){ return position; },
    set currentTime(value){
      moves.push({value, muted:this.muted, at:ms}); position=value;
      this.seeking=true;
      pending=ms+seekDelays[seekIndex++ % seekDelays.length];
    },
    seekable:{length:1,start:()=>76+ms/1000,end:()=>100+ms/1000},
  };
  const join=createNativeJoin({
    media, now:()=>origin+100000+ms, monotonic:()=>ms,
    reference:()=>({rounded:origin,origin:ms>=metadataAt ? origin : null}),
    reliable:()=>clock, target:()=>3, eligible:()=>permitted, visible:()=>foreground,
    earliest:()=>floor,
    finish:result=>{results.push(result); if(permitted) media.muted=false;}, event:()=>{},
  });
  return {join,media,moves,results,
    step(seconds){for(let i=0;i<seconds*50;i++){
      ms+=20;
      if(pending!=null && ms>=pending){pending=null;media.seeking=false;}
      if(!media.paused && !media.seeking)position+=.02;
      join.tick();
    }},
    error:()=>100+ms/1000-position-3,
    allow:value=>{permitted=value;}, visible:value=>{foreground=value;}, clock:value=>{clock=value;},
  };
}
for(const delay of [1.2,3,5.8]) for(const metadataAt of [0,4800]) {
  const r=rig({delay,metadataAt,seekDelays:[200,220,180]});
  r.join.start();r.step(14);
  assert.equal(r.join.active,false);
  assert.equal(r.media.muted,false);
  assert.equal(r.results[0]?.reason,'aligned');
  assert.ok(Math.abs(r.error())<=.04,`completion error ${r.error()} from ${delay}s`);
  assert.ok(r.moves.every(s=>s.muted),'a seek occurred after audio opened');
  assert.ok(r.moves.length<=8,'unbounded positioning retries');
  const count=r.moves.length;r.step(600);
  assert.equal(r.moves.length,count,'healthy playback was repositioned');
  assert.equal(r.media.playbackRate,1,'native rate was changed');
}
const missing=rig();missing.clock(false);missing.join.start();missing.step(7);
assert.equal(missing.results[0]?.reason,'clock-unavailable');
assert.equal(missing.media.muted,false,'missing telemetry stranded startup');
assert.equal(missing.moves.length,0);
const cancelled=rig();cancelled.join.start();cancelled.step(.1);cancelled.allow(false);cancelled.step(15);
assert.equal(cancelled.join.active,false);
assert.equal(cancelled.results.length,0,'stale completion unmuted a cancelled join');
assert.equal(cancelled.media.muted,true);
const hidden=rig();hidden.join.start();hidden.visible(false);hidden.step(1);
assert.equal(hidden.results[0]?.reason,'background');
assert.equal(hidden.moves.length,0,'background playback was positioned');
const capped=rig({seekDelays:[2000]});capped.join.start();capped.step(15);
assert.equal(capped.join.active,false,'slow decoder never timed out');
assert.ok(capped.moves.length<=8);
// Re-attachment must not replay source samples heard on the previous session.
const floor=1700000000000+98500;
const rejoin=rig({floor,delay:12});rejoin.join.start();rejoin.step(14);
assert.ok(rejoin.moves.every(s=>1700000000000+s.value*1000>=floor));
assert.ok(Math.abs(rejoin.error())<=.04);
assert.ok(rejoin.results[0]?.elapsed<6000,'stale attachment waited to play through old audio instead of seeking forward');

// Exercise the real page's lifecycle wiring as well as the controller. A
// correct standalone controller is insufficient if Resume or a queued callback
// can bypass it and open cancelled audio.
const page=fs.readFileSync(new URL('../web/listener.html',import.meta.url),'utf8');
function block(begin,end){
  const a=page.indexOf(begin),b=page.indexOf(end,a);
  assert.ok(a>=0 && b>a,`page block missing: ${begin}`);
  return page.slice(a,b);
}
let mono=0, timerID=0, visibilityHandler;
const intervals=new Map();
const media={muted:false,paused:false,seeking:false,readyState:4,currentTime:97,error:null,
  play(){this.paused=false;return Promise.resolve();},pause(){this.paused=true;}};
const context=vm.createContext({
  createNativeJoin, player:media, useNative:true, live:true, streamReady:true, started:true,
  attachGeneration:1,audibleGeneration:-1,openedGeneration:-1,attachSafe:()=>true,
  userPaused:false,yielded:false,playBlocked:false,tabId:'this-tab',myClaim:0,
  audibleReason:'join',listenRequestedAt:0,sumPlayStart:0,JOIN_WATCHDOG_MS:15000,
  clockUncertainty:1,clockReliable:()=>true,currentTimelineOrigin:()=>1700000000000,
  readNativeTimeline:()=>null,roomTarget:()=>3,chosenStream:()=>'/live/party/index.m3u8',
  serverNow:()=>1700000100000+mono,performance:{now:()=>mono},
  setInterval:fn=>{intervals.set(++timerID,fn);return timerID;},clearInterval:id=>intervals.delete(id),
  setTimeout:()=>1,logEvent(){},setPlayingUI(){},setStatus(){},reportAudioOpen(){},
  measureLatency:()=>3,rnd3:x=>x,stale:()=>false,ico:{},btnlabel:{},
  document:{visibilityState:'visible',addEventListener:(_name,fn)=>{visibilityHandler=fn;}},
  syncClock(){},poll(){},recoverPlayback(){},
});
context.claimAudio=()=>{context.yielded=false;};
context.play=()=>media.play();
const read=source=>vm.runInContext(source,context);
read(block('    let nativeJoinTimer','    function reportAudioOpen'));
read(block('    function pauseGuest(){','    // Fast, bounded retries'));
read(block('    function showPlayFailure(message){','    // Idle-state button'));
read(block('    function onClaim(msg){','    if (bchan)'));
read(block("    document.addEventListener('visibilitychange', () => {\n      // Finish",'    // AirPods / audio-route change'));
read("beginAudible('join')");
assert.equal(media.muted,true);
const queued=intervals.values().next().value;
read('pauseGuest()');mono+=15000;queued();
assert.equal(media.muted,true,'queued startup callback overrode Pause');
assert.equal(intervals.size,0);
read('resumeGuest()');
assert.equal(read('nativeJoin.active'),true,'Resume bypassed a cancelled alignment');
assert.equal(media.muted,true);
read("onClaim({tabId:'other-tab',ts:9999999999999})");
assert.equal(context.yielded,true,'muted startup ignored a newer audio owner');
assert.equal(read('nativeJoin.active'),false);
read("showPlayFailure('test'); retryPlayback('test')");
assert.equal(read('nativeJoin.active'),true,'Retry did not start a fresh alignment');
media.seeking=true;context.document.visibilityState='hidden';visibilityHandler();
assert.equal(read('nativeJoin.active'),false);
assert.equal(media.muted,false,'hiding the page stranded startup behind a suspended timer');
assert.equal(intervals.size,0);
console.log('PASS native startup: asynchronous seeks, delayed clock cues, bounded retries, cancellation, visibility, no replay, passive continuation');
