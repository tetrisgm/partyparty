#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createServer } from "node:https";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { networkInterfaces } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runDir = join(root, "build", "multidj-lab");
const cert = process.env.PP_LAB_CERT ||
  join(process.env.HOME, "Library", "Application Support", "partyparty", "live-cert.pem");
const key = process.env.PP_LAB_KEY ||
  join(process.env.HOME, "Library", "Application Support", "partyparty", "live-key.pem");
const installRecord = JSON.parse(readFileSync(
  join(process.env.HOME, "Library", "Application Support", "partyparty", "install.json"),
  "utf8",
));
const installLabel = installRecord.HostLabel || installRecord.hostLabel || installRecord.Slug || installRecord.slug;
const installBase = installRecord.Base || installRecord.base || "party.partyparty.party";
if (!installLabel) {
  throw new Error(`No LAN hostname found in ${INSTALL_RECORD}`);
}
const host = process.env.PP_LAB_HOST || `${installLabel}.${installBase}`;
const pagePort = Number(process.env.PP_LAB_PAGE_PORT || 9443);
const hlsPort = Number(process.env.PP_LAB_HLS_PORT || 9888);
const rtspPort = Number(process.env.PP_LAB_RTSP_PORT || 9554);
const mediamtx = join(root, "assets", "mediamtx");
const ffmpeg = join(root, "assets", "ffmpeg");

const channels = [
  {
    id: "beethoven",
    dj: "DJ Pink",
    title: "Beethoven - Coriolan Overture",
    color: "#ff2d6f",
    file: "beethoven-coriolan-overture.flac",
  },
  {
    id: "grieg",
    dj: "DJ Green",
    title: "Grieg - In the Hall of the Mountain King",
    color: "#30d158",
    file: "grieg-in-the-hall-of-the-mountain-king.flac",
  },
  {
    id: "mozart",
    dj: "DJ Blue",
    title: "Mozart - Magic Flute Overture",
    color: "#0a84ff",
    file: "mozart-magic-flute-overture.flac",
  },
];

for (const channel of channels) {
  statSync(join(root, "testdata", "music", channel.file));
}
mkdirSync(runDir, { recursive: true });

const paths = channels.flatMap(({ id }) => [`  ${id}-warm:`, `  ${id}-full:`]).join("\n");
const configPath = join(runDir, "mediamtx.yml");
writeFileSync(configPath, `logLevel: warn
api: no
metrics: no
playback: no
rtmp: no
srt: no
webrtc: no
rtsp: yes
rtspAddress: 127.0.0.1:${rtspPort}
rtspTransports: [tcp]
moq: no
hls: yes
hlsAddress: 0.0.0.0:${hlsPort}
hlsEncryption: yes
hlsServerCert: ${cert}
hlsServerKey: ${key}
hlsVariant: lowLatency
hlsAlwaysRemux: yes
hlsSegmentCount: 12
hlsSegmentDuration: 500ms
hlsPartDuration: 150ms
hlsAllowOrigins: ['*']
authInternalUsers:
- user: any
  pass:
  permissions:
  - action: publish
  - action: read
paths:
${paths}
`);

const children = [];
let server;
function launch(name, command, args) {
  const child = spawn(command, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  const log = (data) => process.stderr.write(`[${name}] ${data}`);
  child.stdout.on("data", log);
  child.stderr.on("data", log);
  child.on("exit", (code, signal) => {
    if (!stopping) {
      console.error(`${name} exited unexpectedly (${signal || code})`);
      shutdown(1);
    }
  });
  children.push(child);
  return child;
}

let stopping = false;
function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  server?.close();
  for (const child of children) child.kill("SIGTERM");
  setTimeout(() => {
    for (const child of children) {
      if (child.exitCode === null) child.kill("SIGKILL");
    }
    process.exit(code);
  }, 1200).unref();
}
process.on("SIGINT", () => shutdown());
process.on("SIGTERM", () => shutdown());

launch("mediamtx", mediamtx, [configPath]);
await new Promise((resolveReady, reject) => {
  const deadline = Date.now() + 8000;
  const tryConnect = () => {
    const socket = createConnection({ host: "127.0.0.1", port: hlsPort });
    socket.once("connect", () => {
      socket.destroy();
      resolveReady();
    });
    socket.once("error", () => {
      socket.destroy();
      if (Date.now() >= deadline) reject(new Error("MediaMTX did not start"));
      else setTimeout(tryConnect, 150);
    });
  };
  tryConnect();
});

for (const channel of channels) {
  const input = join(root, "testdata", "music", channel.file);
  launch(channel.id, ffmpeg, [
    "-hide_banner", "-loglevel", "warning",
    "-re", "-stream_loop", "-1", "-i", input,
    "-filter_complex", "[0:a]asplit=2[full][warm]",
    "-map", "[full]", "-c:a", "aac_at", "-b:a", "320k", "-ar", "48000", "-ac", "2",
    "-f", "rtsp", "-rtsp_transport", "tcp", `rtsp://127.0.0.1:${rtspPort}/${channel.id}-full`,
    "-map", "[warm]", "-c:a", "aac_at", "-b:a", "64k", "-ar", "48000", "-ac", "1",
    "-f", "rtsp", "-rtsp_transport", "tcp", `rtsp://127.0.0.1:${rtspPort}/${channel.id}-warm`,
  ]);
}

const page = readFileSync(join(root, "testdata", "multidj", "index.html"), "utf8");
const qr = readFileSync(join(root, "web", "vendor", "qrcode.min.js"));
const channelPayload = JSON.stringify(channels.map(({ file, ...channel }) => ({
  ...channel,
  warm: `https://${host}:${hlsPort}/${channel.id}-warm/index.m3u8`,
  full: `https://${host}:${hlsPort}/${channel.id}-full/index.m3u8`,
})));
server = createServer({ cert: readFileSync(cert), key: readFileSync(key) }, (request, response) => {
  const url = new URL(request.url, `https://${host}:${pagePort}`);
  if (url.pathname === "/api/channels") {
    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(channelPayload);
    return;
  }
  if (url.pathname === "/vendor/qrcode.min.js") {
    response.writeHead(200, { "content-type": "text/javascript", "cache-control": "public, max-age=3600" });
    response.end(qr);
    return;
  }
  if (url.pathname === "/" || url.pathname === "/index.html") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(page);
    return;
  }
  if (url.pathname === "/favicon.ico") {
    response.writeHead(204);
    response.end();
    return;
  }
  response.writeHead(404);
  response.end("not found");
});

server.listen(pagePort, "0.0.0.0", () => {
  const lan = Object.values(networkInterfaces()).flat().find((item) =>
    item && item.family === "IPv4" && !item.internal);
  console.log("\nMulti-DJ switching lab is running.");
  console.log(`Phone URL: https://${host}:${pagePort}/`);
  console.log(`LAN IP:    ${lan?.address || "unknown"}`);
  console.log("Press Control-C to stop all test processes.\n");
});
