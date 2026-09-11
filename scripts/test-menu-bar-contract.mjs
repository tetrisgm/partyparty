#!/usr/bin/env node
// The menu-bar live-control contract.
//
// This file used to assert an NSMenu of labelled items - "Open Guest QR",
// "Open Console", "Stop Set", "Connection: Direct Wi-Fi" and so on. That menu
// was replaced by a QR popover in 7aa1b11 on 2026-08-04, so every assertion
// here failed on its first line for 349 commits. Nothing noticed, because the
// file was wired into no npm script and no gate. A test that cannot run is not
// a weaker test than one that can; it is a claim of coverage with nothing
// behind it, which is worse than no file at all.
//
// It is rewritten against the surface that ships: a popover holding the QR, a
// listener count, and three buttons, plus the right-click safety menu that
// exists so the app is never uncloseable if the popover misbehaves.
//
// These are source assertions, not behavioural ones: they catch a label or a
// control being renamed or deleted out from under the product, which is exactly
// what went unnoticed before. They cannot prove the popover renders. Only the
// Swift tests and a real launch do that.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

// --- the popover: what a DJ can see and do without opening the console -------
const popover = read('app/Sources/PartyParty/StatusPopover.swift');

// The QR is the product. A guest joins by scanning it, so it is the one thing
// the popover must always be able to show, and it must say so plainly while
// there is not yet a secure link to encode rather than showing a stale code.
assert.match(popover, /qrView\.isHidden = !hasQR/,
  'the popover must hide the QR when there is no guest URL');
assert.match(popover, /qrPending\.isHidden = hasQR/,
  'the popover must show the pending state when there is no guest URL');
assert.ok(popover.includes('Getting the party link…'),
  'the popover must explain that the link is still being provisioned');

// Re-rendering the QR on every poll would rebuild the image several times a
// second behind a popover nobody is looking at.
assert.match(popover, /if hasQR && s\.guestURL != lastQRURL/,
  'the QR must only be regenerated when the guest URL actually changes');

// One control, two states. A separate Start and Stop is how a DJ stops a set
// they have not started.
assert.match(popover, /let broadcasting = s\.state == "live" \|\| s\.state == "starting"/,
  'the popover must treat starting as broadcasting');
assert.match(popover, /toggleButton\.title = broadcasting \? "Stop broadcast" : "Go live"/,
  'the broadcast control must be one button with two titles');

for (const label of ['Nobody listening yet', '1 listener', 'Open PartyParty', 'Quit']) {
  assert.ok(popover.includes(label), `the popover is missing "${label}"`);
}
assert.match(popover, /"\\\(s\.listeners\) listeners"/,
  'the plural listener count must be interpolated from the status');

// --- the status item: left click is the popover, right click is the exit ----
const delegate = read('app/Sources/PartyParty/AppDelegate.swift');
assert.match(delegate, /NSApp\.currentEvent\?\.type == \.rightMouseUp/,
  'right click must open the safety menu rather than the popover');
assert.match(delegate, /item\("Open \\\(appName\)", #selector\(showConsoleFromMenu\)\)/,
  'the safety menu must be able to open the console');
assert.match(delegate, /item\("Quit \\\(appName\)", #selector\(quit\)\)/,
  'the safety menu must be able to quit: the app is never uncloseable');
assert.match(delegate, /popover\.behavior = \.transient/,
  'the popover must dismiss itself when the DJ clicks away');

// Starting a nameless party is refused in the popover exactly as in the
// console, rather than creating a party called nothing.
assert.match(delegate, /if s\.eventTitle\.trimmingCharacters\(in: \.whitespaces\)\.isEmpty/,
  'the popover must refuse to start a nameless party');

// Updates are a STANDALONE-only affordance. The Store build must never carry
// a Sparkle control.
assert.match(delegate, /#if STANDALONE[\s\S]*?Check for Updates[\s\S]*?#endif/,
  'Check for Updates must be compiled out of the Store target');

// --- the client: loopback only, POST for state changes ----------------------
const api = read('app/Sources/PartyParty/APIClient.swift');
assert.match(api, /http:\/\/127\.0\.0\.1:\\\(port\)\/api\/stop/,
  'the app must talk to the server over loopback by address');
assert.match(api, /req\.httpMethod = "POST"/,
  'state changes must be POSTs');
assert.doesNotMatch(api, /http:\/\/localhost:/,
  'localhost resolution is not guaranteed; use 127.0.0.1');
assert.match(api, /urls\["join"\] as\? String/,
  'the app must read the join URL the server advertises');
assert.match(api, /if o\["connection"\] is \[String: Any\]/,
  'a server that reports a connection block must not fall back to the primary URL');

// --- the console window -----------------------------------------------------
const consoleController = read('app/Sources/PartyParty/AdminWindowController.swift');
assert.match(consoleController, /func showGuestQR\(\)/);
assert.match(consoleController, /scrollIntoView/);

console.log('PASS menu-bar live-control contract');
