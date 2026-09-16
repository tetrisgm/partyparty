// PROGRAM-DATE-TIME must advance with media duration, not packet arrival time.
// A player can report a stable local clock while different joins hear different
// samples if this invariant is broken upstream.
export function programTimelineErrors(text) {
  let previous = null, duration = 0;
  const errors=[];
  for(const line of text.split(/\r?\n/)) {
    if(line==='#EXT-X-DISCONTINUITY') {previous=null;duration=0;}
    if(line.startsWith('#EXTINF:')) duration+=Number(line.slice(8).split(',')[0]);
    if(!line.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) continue;
    const stamp=Date.parse(line.slice(25));
    if(previous!=null) errors.push(stamp-previous-duration*1000);
    previous=stamp;duration=0;
  }
  return errors;
}
