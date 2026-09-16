// The lab and unit tests use the exact native clock reader shipped in the page.
import fs from 'node:fs';
const page = fs.readFileSync(new URL('../../web/listener.html', import.meta.url), 'utf8');
const begin = page.indexOf('    function readNativeTimeline(');
const end = page.indexOf('    function nativeTimelineSample()', begin);
if (begin < 0 || end < 0) throw new Error('listener native clock reader not found');
export const readNativeTimeline = new Function(page.slice(begin, end) + '\nreturn readNativeTimeline;')();
const joinBegin = page.indexOf('    function createPlaybackAlignment(');
const joinEnd = page.indexOf('    let playbackAlignmentTimer', joinBegin);
if (joinBegin < 0 || joinEnd < 0) throw new Error('listener native join controller not found');
export const createPlaybackAlignment = new Function(page.slice(joinBegin, joinEnd) + '\nreturn createPlaybackAlignment;')();
