/** Offline only: temporary directories, no application data or network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.PLAYER_CACHE_BYTES = '4096';
const cache = await import('./audiocache.mjs?isolated-test');
const temporary = () => fs.mkdtempSync(path.join(os.tmpdir(), 'player-audiocache-test-'));

test('MIME and bytes survive a cold module restart', async () => {
  const dir = temporary();
  try {
    cache.configure(dir);
    const buffer = Buffer.from('real MP4 fixture bytes');
    assert.equal(cache.write('soundcloud', '1', buffer, 'audio/mp4'), true);
    const cold = await import('./audiocache.mjs?cold-test');
    cold.configure(dir);
    assert.equal(cold.has('soundcloud', '1'), true);
    assert.deepEqual(cold.read('soundcloud', '1'), { buffer, contentType: 'audio/mp4' });
    assert.equal(cold.write('soundcloud', '2', buffer), false);
    assert.equal(cold.write('soundcloud', '2', buffer, 'text/html'), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('hard TTL does not extend with access; read and has both expire', () => {
  const dir = temporary();
  const now = Date.now;
  let clock = now();
  Date.now = () => clock;
  try {
    cache.configure(dir);
    assert.equal(cache.write('sc', '1', Buffer.from('abc'), 'audio/mpeg'), true);
    clock += 6 * 24 * 60 * 60 * 1000;
    assert.ok(cache.read('sc', '1'));
    clock += 24 * 60 * 60 * 1000;
    assert.equal(cache.read('sc', '1'), null);
    assert.equal(cache.has('sc', '1'), false);
    assert.equal(cache.stats().files, 0);
  } finally { Date.now = now; fs.rmSync(dir, { recursive: true, force: true }); }
});

test('size bounds, legacy invalidation and corrupt envelopes are safe misses', () => {
  const dir = temporary();
  try {
    cache.configure(dir);
    const audioDir = path.join(dir, 'audio-cache');
    fs.writeFileSync(path.join(audioDir, 'legacy.bin'), Buffer.from('old raw MP4'));
    const abandoned = 'a'.repeat(64) + '.audio.12345678-1234-1234-1234-123456789012.tmp';
    fs.writeFileSync(path.join(audioDir, abandoned), Buffer.from('unpublished'));
    cache.configure(dir);
    assert.equal(fs.existsSync(path.join(audioDir, 'legacy.bin')), false);
    assert.equal(fs.existsSync(path.join(audioDir, abandoned)), false);
    assert.equal(cache.write('sc', 'big', Buffer.alloc(4096), 'audio/mp4'), false);
    assert.equal(cache.write('sc', 'a', Buffer.alloc(2300), 'audio/mp4'), true);
    assert.equal(cache.write('sc', 'b', Buffer.alloc(2300), 'audio/mpeg'), true);
    assert.ok(cache.stats().bytes <= 4096);
    assert.equal(cache.stats().files, 1);
    const file = path.join(audioDir, fs.readdirSync(audioDir).find(v => v.endsWith('.audio')));
    fs.writeFileSync(file, Buffer.from('corrupt'));
    assert.equal(cache.stats().files, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('failed atomic replacement retains previous bytes and metadata', () => {
  const dir = temporary();
  const rename = fs.renameSync;
  try {
    cache.configure(dir);
    assert.equal(cache.write('sc', '1', Buffer.from('old'), 'audio/mpeg'), true);
    fs.renameSync = () => { throw Error('simulated rename failure'); };
    assert.equal(cache.write('sc', '1', Buffer.from('new'), 'audio/mp4'), false);
    assert.deepEqual(cache.read('sc', '1'), { buffer: Buffer.from('old'), contentType: 'audio/mpeg' });
    assert.equal(fs.readdirSync(path.join(dir, 'audio-cache')).some(v => v.endsWith('.tmp')), false);
  } finally { fs.renameSync = rename; fs.rmSync(dir, { recursive: true, force: true }); }
});
