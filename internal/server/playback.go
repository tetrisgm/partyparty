package server

// roomLatencyTarget is the single client-side playout target. The server does
// not add delay to MediaMTX's LL-HLS playlists; native AVPlayer joins the live
// edge and the visible-only governor corrects sustained drift toward this
// target without touching locked/background playback.
const roomLatencyTarget = 1.0
