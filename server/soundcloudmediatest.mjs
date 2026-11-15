/** Isolated transport fixtures only: never make a real request or use account data. */
import test from 'node:test';
import assert from 'node:assert/strict';

const originalFetch = globalThis.fetch;
const originalEnv = process.env.SOUNDCLOUD_CLIENT_ID;
process.env.SOUNDCLOUD_CLIENT_ID = '';
let instance = 0;
const key = 'A'.repeat(32);
const json = data => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
async function provider(relays = []) {
  const mod = await import(`./providers/soundcloud.mjs?media-test=${++instance}`);
  mod.configure({ clientId: key, relays, cookies: '' });
  return mod;
}
function fixture(protocol, media, mime = protocol === 'hls' ? 'audio/mp4' : 'audio/mpeg') {
  return async (url, options) => {
    const u = new URL(url);
    if (u.pathname === '/search/tracks') return json({ collection: [] });
    if (u.pathname === '/tracks/1') return json({ id: 1, streamable: true, media: { transcodings: [
      { url: 'https://api-v2.soundcloud.com/transcode', format: { protocol, mime_type: mime } },
    ] } });
    if (u.pathname === '/transcode') return json({ url: 'https://cdn.example/media' });
    return media(url, options);
  };
}
function stalled(options, onFinish = () => {}) {
  let finished = false;
  const finish = () => { if (!finished) { finished = true; onFinish(); } };
  return new Response(new ReadableStream({
    start(controller) {
      options.signal.addEventListener('abort', () => { finish(); try { controller.error(options.signal.reason); } catch {} }, { once: true });
    },
    cancel() { finish(); },
  }));
}

test.after(() => {
  globalThis.fetch = originalFetch;
  if (originalEnv === undefined) delete process.env.SOUNDCLOUD_CLIENT_ID;
  else process.env.SOUNDCLOUD_CLIENT_ID = originalEnv;
});

test('configured client_id validates first, without any scraping', async () => {
  const sc = await provider();
  const calls = [];
  globalThis.fetch = async url => { calls.push(url); assert.equal(new URL(url).pathname, '/search/tracks'); return json({ collection: [] }); };
  assert.equal(await sc.acquireClientId(), key);
  assert.equal(calls.length, 1);
});

test('environment client_id also validates before scraping', async () => {
  const sc = await provider();
  sc.configure({ clientId: '', relays: [], cookies: '' });
  process.env.SOUNDCLOUD_CLIENT_ID = key;
  let count = 0;
  globalThis.fetch = async url => {
    count++;
    assert.equal(new URL(url).pathname, '/search/tracks');
    return json({ collection: [] });
  };
  try { assert.equal(await sc.acquireClientId(), key); assert.equal(count, 1); }
  finally { process.env.SOUNDCLOUD_CLIENT_ID = ''; }
});

test('progressive is complete buffered media via configured relay, not a raw URL', async () => {
  const sc = await provider(['https://relay.example']);
  let mediaCalls = 0;
  globalThis.fetch = fixture('progressive', async (url, options) => {
    mediaCalls++;
    assert.equal(options.method, 'GET');
    assert.equal(options.headers.has('range'), false);
    assert.ok(options.signal);
    if (url === 'https://cdn.example/media') throw Error('mock direct outage');
    assert.ok(url.startsWith('https://relay.example/p/'));
    return new Response(Buffer.from('complete mp3'), { headers: { 'content-type': 'audio/mpeg', 'content-length': '12' } });
  });
  const result = await sc.stream('1');
  assert.deepEqual(result.buffer, Buffer.from('complete mp3'));
  assert.equal(result.contentType, 'audio/mpeg');
  assert.equal(result.url, undefined);
  assert.equal(mediaCalls, 2);
});

test('HLS uses one GET per object, modest concurrency, and ordered init+segments', async () => {
  const sc = await provider();
  let active = 0, peak = 0;
  const calls = [];
  globalThis.fetch = fixture('hls', async (url, options) => {
    calls.push(url);
    assert.equal(options.method, 'GET');
    assert.equal(options.headers.has('range'), false);
    const pathname = new URL(url).pathname;
    if (pathname === '/media') return new Response('#EXTM3U\n#EXT-X-MAP:URI="init"\n1\n2\n3\n4\n5\n#EXT-X-ENDLIST\n');
    if (pathname === '/init') return new Response('INIT');
    const n = Number(pathname.slice(1));
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, (6 - n) * 2));
    active--;
    return new Response(`SEG${n}`);
  });
  const result = await sc.stream('1');
  assert.equal(result.buffer.toString(), 'INITSEG1SEG2SEG3SEG4SEG5');
  assert.equal(result.contentType, 'audio/mp4');
  assert.equal(calls.length, 7);
  assert.equal(peak, 3);
  assert.equal(active, 0);
});

test('HLS first failure cancels and settles every in-flight sibling', async () => {
  const sc = await provider();
  let active = 0, cancelled = 0;
  globalThis.fetch = fixture('hls', async (url, options) => {
    const pathname = new URL(url).pathname;
    if (pathname === '/media') return new Response('#EXTM3U\n1\n2\n3\n4\n#EXT-X-ENDLIST');
    if (pathname === '/1') { await new Promise(resolve => setTimeout(resolve, 10)); return new Response('no', { status: 403 }); }
    active++;
    return stalled(options, () => { active--; cancelled++; });
  }, 'audio/mpeg');
  await assert.rejects(sc.stream('1'), /HLS segment/);
  assert.equal(active, 0);
  assert.equal(cancelled, 2);
});

test('body deadline triggers relay fallback and cancels stalled original body', async () => {
  const sc = await provider(['https://relay.example']);
  let cancelled = 0, count = 0;
  globalThis.fetch = async (url, options) => {
    count++;
    if (url === 'https://cdn.example/media') return stalled(options, () => cancelled++);
    return new Response('complete', { headers: { 'content-type': 'audio/mpeg' } });
  };
  const result = await sc._debug.httpBuffer('https://cdn.example/media', { timeout: 20 });
  assert.equal(result.buffer.toString(), 'complete');
  assert.equal(cancelled, 1);
  assert.equal(count, 2);
});

test('absolute track deadline and external cancellation propagate to fetch/body', async () => {
  for (const callerCancel of [false, true]) {
    const sc = await provider();
    let active = 0;
    globalThis.fetch = fixture('progressive', async (_url, options) => {
      active++;
      return stalled(options, () => active--);
    });
    const controller = new AbortController();
    const timer = callerCancel ? setTimeout(() => controller.abort(new Error('caller cancelled')), 20) : null;
    const started = Date.now();
    await assert.rejects(sc.stream('1', { timeoutMs: callerCancel ? 1000 : 25, signal: controller.signal }), /deadline|cancelled/);
    if (timer) clearTimeout(timer);
    assert.ok(Date.now() - started < 500);
    assert.equal(active, 0);
  }
});

test('reject partial 206 and oversized/unknown-length bodies', async () => {
  const sc = await provider();
  globalThis.fetch = fixture('progressive', async () => new Response('partial', { status: 206, headers: { 'content-range': 'bytes 0-6/999', 'content-type': 'audio/mpeg' } }));
  await assert.rejects(sc.stream('1'), /частичный/);
  globalThis.fetch = async () => new Response('too long');
  await assert.rejects(sc._debug.httpBuffer('https://cdn.example/a', { maxBytes: 3 }), /лимит/);
});

test('oversized HLS request counts and unsafe concatenation fail before media downloads', async () => {
  for (const playlist of [
    '#EXTM3U\n' + Array.from({ length: 500 }, (_, i) => String(i)).join('\n') + '\n#EXT-X-ENDLIST',
    '#EXTM3U\n#EXT-X-BYTERANGE:100@0\n1\n#EXT-X-ENDLIST',
    '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\n1\n#EXT-X-ENDLIST',
  ]) {
    const sc = await provider();
    let calls = 0;
    globalThis.fetch = fixture('hls', async url => {
      calls++; assert.equal(new URL(url).pathname, '/media'); return new Response(playlist);
    });
    await assert.rejects(sc.stream('1'), { code: 'NOT_SUPPORTED' });
    assert.equal(calls, 1);
  }
});

test('deadline also aborts acquisition before response headers', async () => {
  const sc = await provider();
  let active = 0;
  globalThis.fetch = async (_url, options) => {
    active++;
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => { active--; reject(options.signal.reason); }, { once: true });
    });
  };
  await assert.rejects(sc.stream('1', { timeoutMs: 20 }), /deadline/);
  assert.equal(active, 0);
});

test('sensitive headers are never forwarded to public relays or redirects', async () => {
  const sc = await provider(['https://relay.example']);
  let calls = 0;
  globalThis.fetch = async (url, options) => {
    calls++;
    assert.equal(url, 'https://api-v2.soundcloud.com/test');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.get('authorization'), 'test-only-secret');
    throw Error('mock failure');
  };
  await assert.rejects(sc._debug.httpText('https://api-v2.soundcloud.com/test', { headers: { authorization: 'test-only-secret' } }));
  assert.equal(calls, 1);
});

test('public profile likes and playlists parse HTTP response bodies, not response wrappers', async () => {
  const sc = await provider();
  const rawTrack = { id: 12, title: 'Fixture', duration: 193000, streamable: true, user: { id: 7, username: 'Artist' } };
  globalThis.fetch = async url => {
    const u = new URL(url);
    if (u.pathname === '/resolve') return json({ id: 7 });
    if (u.pathname === '/users/7/likes') return json({ collection: [{ track: rawTrack }] });
    if (u.pathname === '/users/7/playlists') return json({ collection: [{ id: 20, title: 'Fixture list', user: { id: 7 } }] });
    if (u.pathname === '/playlists/20') return json({ tracks: [rawTrack] });
    throw Error(`Unexpected request ${u.pathname}`);
  };
  const likes = await sc.likes(10, 'https://soundcloud.com/fixture');
  assert.equal(likes.items.length, 1);
  assert.equal(likes.items[0].duration, 193);
  const lists = await sc.playlists({ owner: 'https://soundcloud.com/fixture' });
  assert.equal(lists.items[0].kind, '20');
  const tracks = await sc.playlistTracks('soundcloud:20');
  assert.equal(tracks.items[0].title, 'Fixture');
});

test('relay mode reaches catalog and audio without contacting blocked direct hosts', async () => {
  const sc = await provider(['https://relay.example']);
  sc.configure({clientId:key,relays:['https://relay.example'],transportMode:'relay',cookies:''});
  let direct = 0, relay = 0;
  const serve=fixture('progressive',async()=>new Response(Buffer.from('relay audio'),{headers:{'content-type':'audio/mpeg'}}));
  globalThis.fetch=async(url,options)=>{
    if(!url.startsWith('https://relay.example/p/')){direct++;throw Error('blocked direct network')}
    relay++;return serve(decodeURIComponent(new URL(url).pathname.slice(3)),options);
  };
  const result=await sc.stream('1');
  assert.equal(result.buffer.toString(),'relay audio');
  assert.equal(direct,0);assert.ok(relay>=3);
});

test('automatic mode remembers relay and avoids repeating failed direct requests', async () => {
  const sc=await provider(['https://relay.example']);let direct=0,relay=0;
  const serve=fixture('progressive',async()=>new Response(Buffer.from('relay audio'),{headers:{'content-type':'audio/mpeg'}}));
  globalThis.fetch=async(url,options)=>{
    if(!url.startsWith('https://relay.example/p/')){direct++;throw Error('blocked direct network')}
    relay++;return serve(decodeURIComponent(new URL(url).pathname.slice(3)),options);
  };
  await sc.stream('1');const before=direct;await sc.stream('1');
  assert.equal(direct,before);assert.ok(relay>=4);
});
