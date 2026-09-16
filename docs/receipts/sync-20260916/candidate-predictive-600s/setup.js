window.readNativeTimeline = function readNativeTimeline(media, roundedOrigin) {
      if (!Number.isFinite(roundedOrigin)) return null;
      const observations = new Map();
      for (const track of media.textTracks) {
        if (track.kind !== 'metadata') continue;
        track.mode = 'hidden';
        const cues = track.cues;
        if (!cues) continue;
        for (let i = cues.length-1; i >= 0 && observations.size < 8; i--) {
          const cue = cues[i];
          if (cue.type !== 'com.apple.quicktime.HLS' || cue.value?.key !== 'X-PP-TIME'
              || !Number.isFinite(cue.startTime) || cue.startTime <= 0) continue;
          const stamp = Number(cue.value.data);
          const origin = stamp - cue.startTime*1000;
          if (!Number.isFinite(stamp) || Math.abs(origin-roundedOrigin) > 502) continue;
          observations.set(stamp, origin);
        }
      }
      const origins = [...observations.values()].sort((a,b)=>a-b);
      if (origins.length < 2 || origins[origins.length-1]-origins[0] > 10) return null;
      return origins[Math.floor(origins.length/2)];
    };
