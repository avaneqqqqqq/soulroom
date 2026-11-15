/** Offline UI regressions: node server/lyricsuitest.mjs. No browser or server required. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const uiSource = readFileSync(new URL('../web/js/ui.js', import.meta.url), 'utf8');
const storeSource = readFileSync(new URL('../web/js/store.js', import.meta.url), 'utf8');
function section(source, from, to) {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start);
  assert.ok(start >= 0 && end > start, `source boundaries: ${from}`);
  return source.slice(start, end);
}
class NodeStub {
  constructor() {
    this.style = { transform: '', setProperty(key, value) { this[key] = value; } };
    this.classes = new Set();
    this.classList = {
      add: (name) => this.classes.add(name),
      remove: (name) => this.classes.delete(name),
      toggle: (name, on) => on ? this.classes.add(name) : this.classes.delete(name),
    };
    this.children = [];
    this.dataset = {};
    this.scrollTop = 0;
    this.clientHeight = 100;
  }
  setAttribute() {}
  hasAttribute(name) { return name === 'data-lyric' && this.dataset.lyric !== undefined; }
  addEventListener() {}
  querySelector() { return null; }
}
function harness() {
  const selectors = Object.fromEntries([
    '[data-np-lyrics]', '[data-np-lyrics-track]', '[data-np-lyrics-scroll]',
    '[data-np-lyrics-badge]', '[data-np="lyrics"]', '.np__seek', '[data-np-time]',
    '.pl-seek', '[data-pl-time]',
  ].map((key) => [key, new NodeStub()]));
  const el = new NodeStub();
  el.querySelector = (selector) => selectors[selector] || null;
  const requests = [];
  const context = vm.createContext({
    HTMLElement: NodeStub,
    trace() {}, icon: () => '', esc: (value) => String(value),
    fmtClock: (value) => `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`,
    player: { getState: () => ({ time: 0, current: { source: 'test', sourceId: 'a' } }) },
    ui: { playerHost: el, seeking: false },
    getLyrics: (...args) => new Promise((resolve, reject) => requests.push({ args, resolve, reject })),
  });
  vm.runInContext(section(uiSource, 'const nowPlaying =', '/* --------------------------- клипы к треку'), context);
  vm.runInContext(section(uiSource, 'function syncProgressClock(', '/** Обновить нижний бар'), context);
  context.el = el;
  vm.runInContext('nowPlaying.el = el; lyricsState().open = true;', context);
  return {
    selectors, requests,
    run: (code) => vm.runInContext(code, context),
    state: () => vm.runInContext('lyricsState()', context),
  };
}
const a = { source: 'test', sourceId: 'a' };
const b = { source: 'test', sourceId: 'b' };
const text = (value) => ({ available: true, plain: value, synced: [], provider: 'lrclib' });
let passed = 0;
async function check(name, fn) {
  await fn();
  passed += 1;
  console.log(`ok ${passed} - ${name}`);
}
const load = (h, track) => h.run(`loadLyrics(${JSON.stringify(track)})`);

await check('fullscreen progress tick updates both clocks without ReferenceError', () => {
  const h = harness();
  h.run('syncProgressClock({ duration: 100, time: 25 })');
  assert.equal(h.selectors['[data-np-time]'].textContent, '0:25');
  assert.equal(h.selectors['[data-pl-time]'].textContent, '0:25');
  assert.equal(h.selectors['.np__seek'].value, '250');
});
await check('synced-to-loading/missing/instrumental resets translated content', async () => {
  const h = harness();
  const rail = h.selectors['[data-np-lyrics-track]'];
  const scroll = h.selectors['[data-np-lyrics-scroll]'];
  const active = new NodeStub();
  active.dataset.lyric = '0'; active.offsetTop = 500; active.offsetHeight = 40;
  rail.children = [active];
  Object.assign(h.state(), { status: 'ready', synced: [{ time: 0, text: 'line' }] });
  h.run('syncLyrics(0, true)');
  assert.equal(rail.style.transform, 'translateY(-470px)');
  const pending = load(h, a);
  assert.equal(rail.style.transform, '');
  assert.match(rail.innerHTML, /Ищем текст/);
  rail.style.transform = 'translateY(-470px)';
  scroll.classList.add('is-plain'); scroll.scrollTop = 100;
  h.requests[0].resolve({ available: false }); await pending;
  assert.equal(rail.style.transform, '');
  assert.equal(scroll.scrollTop, 0);
  assert.equal(scroll.classes.has('is-plain'), false);
  assert.match(rail.innerHTML, /Текст не найден/);
  rail.style.transform = 'translateY(-470px)';
  h.run('applyLyricsResult({ available: false, instrumental: true })');
  assert.equal(rail.style.transform, '');
  assert.match(rail.innerHTML, /Инструментальная композиция/);
  assert.doesNotMatch(rail.innerHTML, /Текст не найден/);
  Object.assign(h.state(), { status: 'ready', synced: [{ time: 0, text: 'instrumental' }] });
  rail.style.transform = 'translateY(-470px)'; h.run('renderLyrics()');
  assert.equal(rail.style.transform, '');
});
await check('reopening absent lyrics is visible and manual retry can succeed', async () => {
  const h = harness(); const pending = load(h, a);
  h.requests[0].resolve({ available: false }); await pending;
  h.run('toggleLyrics(); toggleLyrics()');
  await load(h, a);
  assert.equal(h.requests.length, 1);
  assert.match(h.selectors['[data-np-lyrics-track]'].innerHTML, /Текст не найден/);
  h.state().notFoundAt = 0;
  const retry = load(h, a);
  h.requests.at(-1).resolve(text('found')); await retry;
  assert.equal(h.state().plain, 'found');
});
await check('successful lyrics reopen from session memo without another request', async () => {
  const h = harness(); const pending = load(h, a);
  h.requests[0].resolve(text('remembered')); await pending;
  h.run('nowPlaying.lyrics = null; lyricsState().open = true');
  await load(h, a);
  assert.equal(h.requests.length, 1);
  assert.equal(h.state().plain, 'remembered');
});
await check('duplicate in-flight loads do not request the same lyrics twice', async () => {
  const h = harness(); const first = load(h, a);
  await load(h, a);
  assert.equal(h.requests.length, 1);
  h.requests[0].resolve(text('once')); await first;
});
await check('old fullscreen response cannot mutate new state or populate memo', async () => {
  const h = harness(); const old = load(h, a);
  h.run('nowPlaying.lyrics = null; lyricsState().open = true');
  const current = load(h, b);
  h.requests[0].resolve(text('stale')); await old;
  assert.equal(h.state().status, 'loading');
  assert.equal(h.run('lyricsMemo.has("test:a")'), false);
  h.requests[1].resolve(text('new')); await current;
  assert.equal(h.state().plain, 'new');
});
await check('A/B/A generations reject old same-key success and stale rejection', async () => {
  const h = harness(); const oldA = load(h, a); const oldB = load(h, b); const newA = load(h, a);
  h.requests[0].resolve(text('old A')); await oldA;
  h.requests[1].reject(new Error('old B failed')); await oldB;
  assert.equal(h.state().status, 'loading');
  h.requests[2].resolve(text('new A')); await newA;
  assert.equal(h.state().plain, 'new A');
});
await check('clearing the track invalidates pending lyrics', async () => {
  const h = harness(); const old = load(h, a); await load(h, null);
  h.requests[0].resolve(text('old')); await old;
  assert.equal(h.state().key, null);
  assert.equal(h.state().status, 'none');
  assert.equal(h.state().plain, '');
});
await check('wave appends deduplicate existing, within-batch and replayed IDs', () => {
  const app = { wave: { items: [{ id: 'a' }, { id: 'b' }] } };
  const trackBatch = new Map([['a', 'original']]);
  const context = vm.createContext({ app, trackBatch });
  vm.runInContext(section(storeSource, 'function stateAppendWave(', '/**'), context);
  vm.runInContext('stateAppendWave([{id:"a"},{id:"c"},{id:"b"},{id:"c"},{id:"d"}], "batch"); stateAppendWave([{id:"c"},{id:"d"}], "replay")', context);
  assert.deepEqual(app.wave.items.map((track) => track.id), ['a', 'b', 'c', 'd']);
  assert.equal(trackBatch.get('a'), 'original');
  assert.equal(trackBatch.get('c'), 'batch');
});
console.log(`${passed} UI regression checks passed`);
