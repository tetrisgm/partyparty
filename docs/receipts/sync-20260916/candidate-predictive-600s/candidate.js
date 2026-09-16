(function installPlaybackSyncCandidate(create, timelineReader) {
  const media = document.getElementById('player');
  let knownOrigin = null;
  const origin = () => {
    const rounded = currentTimelineOrigin();
    const fresh = timelineReader(media, rounded);
    if (fresh != null) knownOrigin = fresh;
    return knownOrigin != null && rounded != null && Math.abs(knownOrigin-rounded) <= 502 ? knownOrigin : null;
  };
  const sync = create({
    media, now: serverNow, target: roomTarget,
    reliable: () => clockReliable() && clockUncertainty < 40 && (!useNative || origin() != null),
    programTime: () => {
      if (hls?.playingDate) return hls.playingDate.getTime();
      const stamp = origin();
      return stamp == null ? null : stamp + media.currentTime * 1000;
    },
    permitted: () => live && streamReady && !userPaused && !yielded,
    visible: () => document.visibilityState === 'visible',
    steerRate: !useNative,
    event: (kind, data) => logEvent('candidate-' + kind, data),
  });
  const begin = beginAudible;
  beginAudible = reason => { const changed = begin(reason); if (changed) { knownOrigin = null; sync.start(); } return changed; };
  const recover = recoverPlayback;
  recoverPlayback = reason => { if (!sync.holding) recover(reason); };
  considerNativeOutlier = () => {};
  // Disable the second controller on the hls.js path. These are edge-relative
  // controls; the candidate alone owns correction against source wall time.
  setInterval(() => {
    if (hls) {
      hls.config.maxLiveSyncPlaybackRate = 1;
      hls.config.liveSyncOnStallIncrease = 0;
      hls.config.liveMaxLatencyDuration = Infinity;
    }
    sync.tick();
  }, 20);
  window.playbackSyncCandidate = sync;
})(function createPlaybackSync({ media, now, monotonic = () => performance.now(), programTime, reliable, target, permitted, visible, steerRate = true, event = () => {} }) {
  let phase = 'idle', began = 0, lastRepair = -Infinity, attempts = 0;
  let playing = false, correction = false, serial = 0, lastRate = -Infinity, joining = true;
  let seekCost = 0;
  const error = () => {
    const pdt = programTime();
    return reliable() && Number.isFinite(pdt) ? (now() - pdt) / 1000 - target() : null;
  };
  function rate(value) {
    if (Math.abs(media.playbackRate - value) > 0.0005) media.playbackRate = value;
  }
  function resume() {
    if (!media.paused || playing) return;
    playing = true;
    const token = serial;
    Promise.resolve(media.play()).catch(() => event('play-rejected')).finally(() => {
      if (token === serial) playing = false;
    });
  }
  function release(reason) {
    phase = 'playing';
    rate(1);
    if (permitted()) { resume(); media.muted = false; }
    event(reason, { error: error() });
  }
  function start() {
    serial++;
    playing = false; correction = false; joining = true; seekCost = 0;
    phase = 'acquiring'; began = monotonic(); attempts = 0;
    rate(1); media.muted = true;
  }
  function repair(initial = false) {
    phase = 'holding';
    media.muted = true;
    rate(1);
    attempts++;
    lastRepair = monotonic();
    // Keep decoding through a seek. Pausing AVPlayer and resuming at a JS
    // deadline induced fresh buffering and missed that deadline in the lab.
    // Backward positioning is allowed ONLY before the first audible sample of
    // a fresh attachment. Recovery can skip forward but never replay music.
    const pdt = programTime();
    const jump = (now() - target()*1000 - pdt) / 1000 + seekCost;
    if (Number.isFinite(jump) && (jump > 0.03 || (initial && jump < -0.03))) {
      const position = media.currentTime + jump;
      let available = false;
      for (let i = 0; i < media.seekable.length; i++) {
        if (position >= media.seekable.start(i) && position < media.seekable.end(i) - 0.1) available = true;
      }
      if (available) {
        media.currentTime = position;
        event('position-align', { position, initial, jump, seekCost });
      }
    }
  }
  function stop() {
    serial++;
    phase = 'idle'; playing = false; correction = false;
    rate(1);
  }
  function tick() {
    if (phase === 'idle') return;
    if (!permitted()) { stop(); return; }
    // Background JavaScript cannot be a dependable scheduler. Leave the native
    // engine running at its normal rate, and assess again on foregrounding.
    if (!visible()) { if (phase !== 'playing') release('background'); else rate(1); return; }
    const e = error();
    if (e == null) {
      rate(1);
      if (phase !== 'playing' && monotonic() - began > 6000) release('clock-unavailable');
      return;
    }
    if (phase !== 'playing' && monotonic() - began > 12000) { release('alignment-timeout'); return; }
    if (media.seeking || media.readyState < 3) { rate(1); return; }
    if (phase === 'acquiring') {
      if (Math.abs(e) < 0.04) release('aligned');
      else repair(true);
      return;
    }
    if (phase === 'holding') {
      if (monotonic()-lastRepair < 800) return;
      // Re-read the actual landed timeline; don't spin a retry loop when a
      // player cannot honor the requested position. Drift control is bounded.
      seekCost = Math.max(0, Math.min(.8, seekCost + e));
      if (Math.abs(e) > .04 && attempts < 8 && (e > 0 || joining)) { repair(joining); return; }
      release(Math.abs(e) <= .08 ? 'aligned' : 'alignment-missed');
      joining = false;
      return;
    }
    if (media.paused || media.muted) { rate(1); return; }
    if (e > 0.5 && monotonic() - lastRepair > 15000) {
      began = monotonic(); attempts = 0; joining = false; repair(); return;
    }
    // Hysteresis leaves healthy playback passive and avoids reacting to every
    // currentTime quantization. Small drift gets a bounded ±2% pitch-preserving
    // correction; hls.js's own adaptive latency controller must be disabled.
    if (!steerRate) { rate(1); return; }
    if (Math.abs(e) < 0.015) correction = false;
    else if (Math.abs(e) > 0.04) correction = true;
    if (monotonic() - lastRate >= 1000) {
      rate(correction ? 1 + Math.sign(e)*(Math.abs(e) > .1 ? .02 : .005) : 1);
      lastRate = monotonic();
    }
  }
  return { start, stop, tick, error, get phase() { return phase; }, get holding() { return phase === 'holding'; } };
}, window.readNativeTimeline);