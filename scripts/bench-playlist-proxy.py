#!/usr/bin/env python3
"""Bench proxy: serve the LIVE MediaMTX stream with a candidate manifest
transform, so a muted AVPlayer can soak geometry candidates without touching
the running app. Multivariant playlists get the July-era EXT-X-START pin;
media playlists get the production PART-HOLD-BACK floor."""
import http.server
import ssl
import sys
import urllib.request

UPSTREAM = "https://127.0.0.1:8888"
START_LINE = "#EXT-X-START:TIME-OFFSET=-3.000,PRECISE=YES"
HOLDBACK = "PART-HOLD-BACK=0.90000"

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE


def fetch(path):
    req = urllib.request.Request(UPSTREAM + path)
    with urllib.request.urlopen(req, context=ctx, timeout=5) as r:
        return r.status, r.headers.get("Content-Type", ""), r.read(), r.geturl()


def rewrite_master(text):
    out = []
    for line in text.split("\n"):
        if line.startswith("#EXT-X-START:"):
            continue
        out.append(line)
        if line.startswith("#EXT-X-VERSION:"):
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
    http.server.ThreadingHTTPServer(("127.0.0.1", port), H).serve_forever()
