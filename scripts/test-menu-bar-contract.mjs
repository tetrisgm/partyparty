#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

const delegate = read('app/Sources/PartyParty/AppDelegate.swift');
for (const label of ['Open Guest QR', 'Open Console', 'Stop Set', 'Audio capture: Healthy']) {
  assert.ok(delegate.includes(label), `menu-bar contract is missing "${label}"`);
}
assert.match(delegate, /s\.listeners == 1 \? "1 listener" : "\\\(s\.listeners\) listeners"/);
assert.match(delegate, /stop\.isEnabled = broadcasting/);
assert.match(delegate, /qr\.isEnabled = !s\.guestURL\.isEmpty/);
for (const label of [
  'Connection: Direct Wi-Fi',
  'Connection: Internet relay',
  'Connection: Reconnecting relay',
  'Connection: Checking Wi-Fi',
]) {
  assert.ok(delegate.includes(label), `menu-bar contract is missing "${label}"`);
}

const api = read('app/Sources/PartyParty/APIClient.swift');
assert.match(api, /http:\/\/127\.0\.0\.1:\\\(port\)\/api\/stop/);
assert.match(api, /req\.httpMethod = "POST"/);
assert.doesNotMatch(api, /http:\/\/localhost:/);
assert.match(api, /urls\["join"\] as\? String/);
assert.match(api, /if o\["connection"\] is \[String: Any\]/);

const consoleController = read('app/Sources/PartyParty/AdminWindowController.swift');
assert.match(consoleController, /func showGuestQR\(\)/);
assert.match(consoleController, /scrollIntoView/);

console.log('PASS menu-bar live-control contract');
