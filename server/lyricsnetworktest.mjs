// Deterministic, offline network regression tests. Run: node server/lyricsnetworktest.mjs
import assert from 'node:assert/strict';
import { clearCache, findLyrics, lookup } from './lyrics.mjs';

const original = { fetch: globalThis.fetch, setTimeout, clearTimeout, now: Date.now };
let now = 0;
let sequence = 0;
const timers = new Map();
const requests = [];
globalThis.setTimeout = (fn, ms = 0) => {
  const id = ++sequence;
  timers.set(id, { at: now + Number(ms), fn });
  return id;
};
globalThis.clearTimeout = (id) => timers.delete(id);
Date.now = () => now;
const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
async function advance(ms) {
  await flush();
  const until = now + ms;
  for (;;) {
    const next = [...timers].sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
    if (!next || next[1].at > until) break;
    now = next[1].at;
    timers.delete(next[0]);
    next[1].fn();
    await flush();
  }
  now = until;
  await flush();
}
const response = (data, status = 200) => ({ ok: status === 200, status, json: async () => data, text: async () => String(data) });
const text = { trackName: 'Example', artistName: 'Artist', duration: 180, syncedLyrics: '[00:01]First verse\n[00:02]Second verse' };
const meta = (title = 'Example') => ({ title, artist: 'Artist', duration: 180 });
function mock(route) {
  requests.length = 0;
  globalThis.fetch = (url, { signal }) => {
    const entry = { url: String(url), signal, aborted: false };
    requests.push(entry);
    const plan = route(entry.url) || { data: null, status: 404 };
    return new Promise((resolve, reject) => {
      let timer;
      const abort = () => {
        entry.aborted = true;
        clearTimeout(timer);
        reject(signal.reason);
      };
      signal.addEventListener('abort', abort, { once: true });
      if (plan.hang) return;
      timer = setTimeout(() => {
        signal.removeEventListener('abort', abort);
        resolve(plan.bodyHang ? {
          ok: true, status: 200,
          json: () => new Promise((_, fail) => signal.addEventListener('abort', () => { entry.aborted = true; fail(signal.reason); }, { once: true })),
        } : response(plan.data, plan.status || 200));
      }, plan.ms || 0);
    });
  };
}
async function test(name, fn) {
  clearCache();
  await fn();
  await flush();
  assert.equal(timers.size, 0, `${name}: leaked timers`);
  console.log(`ok ${name}`);
}
try {
  await test('absolute 8s deadline aborts fetches; TIMEOUT is not cached', async () => {
    mock(() => ({ hang: true }));
    let done = false;
    const p = findLyrics(meta()).then((v) => { done = true; return v; });
    await advance(7999);
    assert.equal(done, false);
    await advance(1);
    assert.equal((await p).reason, 'TIMEOUT');
    assert.ok(requests.length > 0 && requests.every((r) => r.aborted));
    assert.equal(requests.length, 6, 'no full lookup or source retries');
    mock((url) => url.includes('/api/get?') ? { data: text } : undefined);
    const retry = findLyrics(meta());
    await advance(0);
    assert.equal((await retry).available, true);
    assert.ok(requests.length > 0);
  });
  await test('primary success at 3.6s is accepted and losers abort', async () => {
    mock((url) => url.includes('api.lrcmux.dev') ? {
      ms: 3600, data: { track: { title: 'Example', artist: 'Artist', duration: 180 }, lines: [{ start: 1000, end: 2000, text: 'First verse' }] },
    } : { hang: true });
    const p = lookup(meta());
    await advance(3600);
    assert.equal((await p).provider, 'lrcmux');
    assert.ok(requests.filter((r) => !r.url.includes('lrcmux')).every((r) => r.aborted));
  });
  await test('fast fallback wins over hanging fallback', async () => {
    mock((url) => url.includes('lrclib.net/api/search?') ? { ms: 20, data: [text] }
      : url.includes('genius.com') ? { hang: true } : undefined);
    const start = now;
    const p = lookup(meta());
    await advance(20);
    assert.equal((await p).provider, 'lrclib');
    assert.equal(now - start, 20);
    assert.ok(requests.find((r) => r.url.includes('genius.com')).aborted);
    assert.ok(requests.filter((r) => r.url.includes('/api/search?')).every((r) => new URL(r.url).searchParams.get('artist_name') === 'Artist'));
  });
  await test('inflight duplicates share one set of requests; globally only two searches', async () => {
    mock((url) => url.includes('lrclib.net/api/get?') ? { ms: 100, data: text } : { hang: true });
    const one = findLyrics(meta());
    const duplicate = findLyrics(meta());
    const two = lookup(meta('Another'));
    const busy = await findLyrics(meta('Third'));
    assert.equal(busy.reason, 'BUSY');
    await advance(0);
    assert.equal(requests.length, 8);
    await advance(100);
    assert.deepEqual(await one, await duplicate);
    assert.equal((await two).available, true);
    const afterBusy = findLyrics(meta('Third'));
    await advance(100);
    assert.equal((await afterBusy).available, true, 'BUSY must not be cached');
  });
  await test('body reads are aborted at the same absolute deadline', async () => {
    mock((url) => url.includes('genius.com') ? { bodyHang: true } : { hang: true });
    const p = lookup(meta());
    await advance(8000);
    assert.equal((await p).reason, 'TIMEOUT');
    assert.ok(requests.find((r) => r.url.includes('genius.com')).aborted);
  });
  await test('reject mismatched artist in fallback, with no title-only retry', async () => {
    mock((url) => url.includes('lrclib.net/api/search?') ? { data: [{ ...text, artistName: 'Unrelated' }] } : undefined);
    const p = lookup(meta());
    await advance(0);
    assert.equal((await p).available, false);
    assert.equal(requests.length, 6);
  });
  await test('network failures are transient, not cached missing lyrics', async () => {
    mock(() => ({ status: 503 }));
    const failed = findLyrics(meta());
    await advance(0);
    assert.equal((await failed).reason, 'NETWORK');
    assert.equal(requests.length, 6);
    mock((url) => url.includes('lrclib.net/api/get?') ? { data: text } : undefined);
    const retry = findLyrics(meta());
    await advance(0);
    assert.equal((await retry).available, true);
  });
  console.log('All 7 offline network checks passed.');
} finally {
  globalThis.fetch = original.fetch;
  globalThis.setTimeout = original.setTimeout;
  globalThis.clearTimeout = original.clearTimeout;
  Date.now = original.now;
}
