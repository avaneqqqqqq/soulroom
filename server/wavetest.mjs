import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const filename = new URL('./wave.mjs', import.meta.url);
const code = fs.readFileSync(filename, 'utf8')
  .replace(/^import .*;\r?\n/gm, '')
  .replace(/\bexport /g, '')
  .replaceAll('fileURLToPath(import.meta.url)', JSON.stringify(path.resolve('server/wave.mjs')));
const timers = new Set();
let diskReads = 0;
const context = {
  fs: { existsSync: () => false, mkdirSync() {}, writeFileSync() {} }, path, process,
  store: { log() {}, getHistory: () => [{ track: { id: 'history', artists: ['Artist'] } }], getFeedback: () => [] },
  libraryCache: { loadWave() { diskReads++; return { items: [{ id: 'old' }] }; } },
  setTimeout(fn, ms) { const t = setTimeout(() => { timers.delete(t); fn(); }, ms); timers.add(t); return t; },
  clearTimeout(t) { clearTimeout(t); timers.delete(t); },
};
vm.runInNewContext(code + '\nthis.api = { bind, readyBatch, prepareWave, getWave, wasSeen };', context);
const { api } = context;
let searches = 0;
const tracks = Array.from({ length: 50 }, (_, i) => ({ id: `sc:${i}`, source: 'soundcloud', sourceId: String(i), title: `track ${i}`, artists: ['Artist'], duration: 193, playable: true }));
api.bind({ soundcloud: { status: async () => ({ connected: true }), search: async () => { searches++; return tracks; } } });
const station = 'test:station';
const key = `${station}|soundcloud`;
try {
  assert.equal(api.readyBatch(key, 2), null);
  assert.equal(diskReads, 0, 'a disk snapshot must never masquerade as a prepared fresh batch');
  const [one, same] = await Promise.all([api.prepareWave(2, station, ['soundcloud']), api.prepareWave(2, station, ['soundcloud'])]);
  assert.equal(searches, 1, 'concurrent preparation shares one provider request');
  assert.equal(one.items[0].id, same.items[0].id);
  assert.equal(api.wasSeen(station, one.items[0].id), false, 'background preparation must not consume unheard tracks');
  const first = api.readyBatch(key, 2);
  assert.equal(first.items.length, 2);
  assert.equal(first.items[0].duration, 193);
  assert.equal(first.items[0].artists[0], 'Artist');
  assert.equal(api.wasSeen(station, first.items[0].id), true);
  assert.equal(api.readyBatch(key, 2), null, 'a prepared batch is consumed exactly once');
  await api.prepareWave(2, station, ['soundcloud']);
  const next = api.readyBatch(key, 2);
  assert.ok(next.items.every((t) => !first.items.some((old) => old.id === t.id)), 'same search results must yield unseen tracks, not repeat the first page');
  console.log('Wave lifecycle: 11 offline regression checks passed');
} finally {
  for (const timer of timers) clearTimeout(timer);
}
