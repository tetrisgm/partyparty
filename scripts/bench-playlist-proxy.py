#!/usr/bin/env python3
"""Bench proxy: serve the LIVE MediaMTX stream with a candidate manifest
transform, so a muted AVPlayer can soak geometry candidates without touching
the running app. Multivariant playlists get the July-era EXT-X-START pin;
media playlists get the production PART-HOLD-BACK floor.

PP_BENCH_PIN selects where the attachment pin goes:

  master  (default) what production ships - pin on the multivariant only.
  media             pin on the MEDIA playlist too, WITH PRECISE.
  none              no pin anywhere, to measure the bare live edge.

The `media` form is not the never-again one. AGENTS.md rules out EXT-X-START
in a media playlist WITHOUT PRECISE, which measured 25s because the offset was
applied from the oldest end; PRECISE is the difference, and whether AVPlayer
honours it there has never been measured. This flag exists so it can be,
against the live stream, without shipping anything."""
import http.client
import http.cookiejar
import http.server
import os
import ssl
import sys
import urllib.request

UPSTREAM = "https://127.0.0.1:8888"
START_LINE = "#EXT-X-START:TIME-OFFSET=-3.000,PRECISE=YES"
HOLDBACK = "PART-HOLD-BACK=0.90000"
PIN = os.environ.get("PP_BENCH_PIN", "master")

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

# MediaMTX hands out a session cookie on the MULTIVARIANT request and answers
# 401 on the media playlist without it. A plain urlopen per request therefore
# proxies the master fine and fails everything under it - which is why this
# tool could never soak a media-playlist candidate. One jar, shared across
# requests and redirects, is the whole fix.
_jar = http.cookiejar.CookieJar()
_opener = urllib.request.build_opener(
    urllib.request.HTTPSHandler(context=ctx),
    urllib.request.HTTPCookieProcessor(_jar),
)


def fetch(path):
    with _opener.open(urllib.request.Request(UPSTREAM + path), timeout=5) as r:
        return r.status, r.headers.get("Content-Type", ""), r.read(), r.geturl()


def prime():
    """Take the cookie the way a player does: ask for the master first."""
    try:
        fetch("/party/index.m3u8")
    except Exception:
        pass


def rewrite_master(text):
    out = []
    for line in text.split("\n"):
        if line.startswith("#EXT-X-START:"):
            continue
        out.append(line)
        if line.startswith("#EXT-X-VERSION:") and PIN in ("master", "media"):
            out.append(START_LINE)
    return "\n".join(out)


def rewrite_media(text):
    out = []
    for line in text.split("\n"):
        if line.startswith("#EXT-X-START:"):
            continue
        if line.startswith("#EXT-X-SERVER-CONTROL:"):
            parts = []
            for attr in line[len("#EXT-X-SERVER-CONTROL:"):].split(","):
                if attr.strip().startswith("PART-HOLD-BACK="):
                    parts.append(HOLDBACK)
                else:
                    parts.append(attr)
            line = "#EXT-X-SERVER-CONTROL:" + ",".join(parts)
        out.append(line)
        # Directly after SERVER-CONTROL so it reads as part of the header, the
        # same place the multivariant pin goes.
        if line.startswith("#EXT-X-SERVER-CONTROL:") and PIN == "media":
            out.append(START_LINE)
    return "\n".join(out)


class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        try:
            status, ctype, body, final = self.fetch_follow(self.path)
        except Exception as e:
            self.send_response(502)
            self.end_headers()
            self.wfile.write(str(e).encode())
            return
        if self.path.endswith(".m3u8") or ".m3u8?" in self.path:
            text = body.decode("utf-8", "replace")
            if "#EXT-X-STREAM-INF" in text:
                text = rewrite_master(text)
            elif "#EXT-X-SERVER-CONTROL" in text:
                text = rewrite_media(text)
            body = text.encode()
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def fetch_follow(self, path):
        status, ctype, body, final = fetch(path)
        return status, ctype, body, final

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8901
    prime()
    print(f"bench proxy on {port}, pin={PIN}, cookies={len(_jar)}", file=sys.stderr, flush=True)
    http.server.ThreadingHTTPServer(("127.0.0.1", port), H).serve_forever()
