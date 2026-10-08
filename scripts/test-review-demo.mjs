#!/usr/bin/env node
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { webkit } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const browser = await webkit.launch({ headless: true });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(pathToFileURL(path.join(root, 'web/review-demo.html')).href);

  assert.match(await page.locator('#view-dj').innerText(), /Sunset Soundcheck/);
  assert.equal(await page.locator('#djPosts .post').count(), 3);
  await page.getByRole('button', { name: 'Guest player', exact: true }).click();
  assert.equal(await page.locator('#view-guest').isVisible(), true);
  assert.equal(await page.locator('#guestPosts .post').count(), 3);
  await page.locator('#guestPostInput').fill('<sample guest>');
  await page.locator('#guestPostButton').click();
  assert.equal(await page.locator('#guestPosts .post').count(), 4);
  assert.match(await page.locator('#guestPosts .post').first().innerText(), /<sample guest>/);
  assert.equal(await page.locator('#guestPosts script').count(), 0);
  await page.locator('#guestPosts [data-like]').first().click();
  assert.match(await page.locator('#guestPosts [data-like]').first().innerText(), /1/);
  await page.getByRole('button', { name: 'Play sample audio' }).click();
  assert.equal(await page.locator('#sampleAudio').getAttribute('aria-pressed'), 'true');
  await page.locator('#sampleAudio').click();
  assert.equal(await page.locator('#sampleAudio').getAttribute('aria-pressed'), 'false');
  await page.getByRole('button', { name: 'Party wall' }).click();
  assert.equal(await page.locator('#wallPosts .post').count(), 4);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  assert.equal(await page.locator('#view-settings').isVisible(), true);
  assert.equal(await page.locator('#view-settings input[type=checkbox]').count(), 3);
  assert.deepEqual(errors, []);
  console.log('PASS populated review demo: DJ, guest, wall, settings, posts, reactions, audio');
} finally {
  await browser.close();
}
