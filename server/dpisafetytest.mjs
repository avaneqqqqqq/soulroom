/** Isolated regression suite: node server/dpisafetytest.mjs. No real network/processes/user config. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import * as dpi from './dpi.mjs';
import * as auto from './dpiauto.mjs';
import * as watcher from './dpiwatcher.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'labsoul-dpi-safety-'));
const here = path.dirname(fileURLToPath(import.meta.url));
const originalFetch = globalThis.fetch;
let tests = 0;
function test(name, fn) { fn(); tests++; console.log('ok - ' + name); }
async function asyncTest(name, fn) { await fn(); tests++; console.log('ok - ' + name); }
function fixture(name, bytes = Buffer.from('domain.example.abc\r\n^soundcloud.com\r\n# keep me\r\n')) {
  const folder = path.join(root, name);
  fs.mkdirSync(path.join(folder, 'lists'), { recursive: true });
  const file = path.join(folder, 'lists', 'list-general-user.txt');
  fs.writeFileSync(file, bytes);
  return { folder, file, bytes };
}
function payload(entry) {
  return { confirmed: true, target: entry.file, revision: entry.revision, domains: [...entry.missingDomains] };
}
function stripImports(text) {
  return text.replace(/^import\s+[\s\S]*?;\s*$/gm, '').replace(/^export default .*;$/gm, '')
    .replace(/^export \{[^}]*\};$/gm, '').replace(/^export /gm, '');
}
try {
  const first = fixture('one');
  const second = fixture('two');
  const editor = dpi.createDomainEditor({ discover: () => [first.folder, second.folder] });
  test('preview is complete, exact and read-only', () => {
    const before = fs.readdirSync(path.dirname(first.file));
    const list = editor.inspect();
    assert.equal(list.length, 2);
    assert.equal(list[0].supported, true);
    assert.deepEqual(list[0].missingDomains, dpi.TARGET_DOMAINS.filter((d) => d !== 'soundcloud.com'));
    assert.deepEqual(fs.readdirSync(path.dirname(first.file)), before);
    assert.deepEqual(fs.readFileSync(first.file), first.bytes);
  });
  test('default, cancelled, legacy and partial consent perform zero writes', () => {
    const before = fs.readdirSync(path.dirname(first.file));
    for (const input of [undefined, {}, [first.folder], { force: true }, { apply: true },
      { ...payload(editor.inspect()[0]), confirmed: false }, { confirmed: true, target: first.file }]) {
      assert.equal(editor.apply(input).ok, false);
    }
    assert.deepEqual(fs.readFileSync(first.file), first.bytes);
    assert.deepEqual(fs.readdirSync(path.dirname(first.file)), before);
  });
  test('reject foreign, main-list, traversal, incomplete and stale targets', () => {
    const consent = payload(editor.inspect()[0]);
    for (const target of [path.join(root, 'foreign', 'lists', 'list-general-user.txt'),
      path.join(first.folder, 'lists', 'ipset-all.txt'), path.join(first.folder, 'lists', 'list-general.txt'),
      path.dirname(first.file) + path.sep + '..' + path.sep + 'lists' + path.sep + 'list-general-user.txt']) {
      assert.equal(editor.apply({ ...consent, target }).ok, false);
    }
    assert.equal(editor.apply({ ...consent, domains: consent.domains.slice(0, 1) }).ok, false);
    assert.equal(editor.apply({ ...consent, revision: 'stale' }).ok, false);
    assert.deepEqual(fs.readFileSync(first.file), first.bytes);
    assert.equal(fs.readdirSync(path.dirname(first.file)).length, 1);
  });
  test('one selected file only; byte-preserving append and exact backup', () => {
    const consent = payload(editor.inspect()[0]);
    const result = editor.apply(consent);
    assert.equal(result.ok, true, result.message);
    assert.equal(result.files, 1);
    assert.deepEqual(fs.readFileSync(result.backup), first.bytes);
    const next = fs.readFileSync(first.file);
    assert.deepEqual(next.subarray(0, first.bytes.length), first.bytes);
    assert.equal(next.subarray(first.bytes.length).toString(), consent.domains.map((d) => '^' + d).join('\r\n') + '\r\n');
    assert.deepEqual(fs.readFileSync(second.file), second.bytes);
    assert.equal(editor.apply(consent).ok, false, 'reusing stale consent must fail');
    assert.equal(editor.inspect()[0].missingDomains.length, 0);
  });
  test('UTF-8 BOM, comments, blank entries, placeholder and no-final-newline are preserved', () => {
    const item = fixture('bom', Buffer.from('\ufeff# комментарий\n\ndomain.example.abc'));
    const local = dpi.createDomainEditor({ discover: () => [item.folder] });
    const result = local.apply(payload(local.inspect()[0]));
    assert.equal(result.ok, true, result.message);
    assert.deepEqual(fs.readFileSync(item.file).subarray(0, item.bytes.length), item.bytes);
    assert.deepEqual(fs.readFileSync(result.backup), item.bytes);
  });
  test('UTF-16 and invalid UTF-8 are refused without changing bytes', () => {
    for (const [name, bytes] of [['utf16', Buffer.from('\ufefforiginal', 'utf16le')], ['legacy', Buffer.from([0xff, 0xfe, 0x81])]]) {
      const item = fixture(name, bytes);
      const local = dpi.createDomainEditor({ discover: () => [item.folder] });
      assert.equal(local.inspect()[0].supported, false);
      assert.equal(local.apply({ confirmed: true, target: item.file, revision: '', domains: [] }).ok, false);
      assert.deepEqual(fs.readFileSync(item.file), bytes);
      assert.equal(fs.readdirSync(path.dirname(item.file)).length, 1);
    }
  });
  test('backup failure prevents every target write', () => {
    const item = fixture('backup-failure');
    let targetWrites = 0;
    const filesystem = { ...fs, writeFileSync() { throw new Error('backup denied'); },
      writeSync(...args) { targetWrites++; return fs.writeSync(...args); } };
    const local = dpi.createDomainEditor({ discover: () => [item.folder], filesystem });
    const result = local.apply(payload(local.inspect()[0]));
    assert.equal(result.ok, false);
    assert.match(result.message, /backup denied/);
    assert.equal(targetWrites, 0);
    assert.deepEqual(fs.readFileSync(item.file), item.bytes);
  });
  test('partial append failure restores original bytes and retains backup', () => {
    const item = fixture('append-failure');
    let count = 0;
    const filesystem = { ...fs, writeSync(...args) {
      if (++count === 1) return fs.writeSync(args[0], args[1], args[2], 2, args[4]);
      if (count === 2) throw new Error('simulated partial failure');
      return fs.writeSync(...args);
    } };
    const local = dpi.createDomainEditor({ discover: () => [item.folder], filesystem });
    const result = local.apply(payload(local.inspect()[0]));
    assert.equal(result.ok, false);
    assert.deepEqual(fs.readFileSync(item.file), item.bytes);
    assert.deepEqual(fs.readFileSync(result.backup), item.bytes);
  });
  test('concurrent change during backup aborts before target append', () => {
    const item = fixture('changed-during-backup');
    const changed = Buffer.concat([item.bytes, Buffer.from('# external change\n')]);
    let targetWrites = 0;
    const filesystem = { ...fs,
      writeFileSync(...args) { fs.writeFileSync(...args); fs.writeFileSync(item.file, changed); },
      writeSync(...args) { targetWrites++; return fs.writeSync(...args); },
    };
    const local = dpi.createDomainEditor({ discover: () => [item.folder], filesystem });
    assert.equal(local.apply(payload(local.inspect()[0])).ok, false);
    assert.equal(targetWrites, 0);
    assert.deepEqual(fs.readFileSync(item.file), changed);
  });
  test('junction-backed lists directory is refused', () => {
    const item = fixture('junction-source');
    const folder = path.join(root, 'junction-owner');
    fs.mkdirSync(folder);
    fs.symlinkSync(path.join(item.folder, 'lists'), path.join(folder, 'lists'), process.platform === 'win32' ? 'junction' : 'dir');
    const local = dpi.createDomainEditor({ discover: () => [folder] });
    assert.equal(local.inspect()[0].supported, false);
    assert.deepEqual(fs.readFileSync(item.file), item.bytes);
  });
  test('hardlinked user list is refused', () => {
    const item = fixture('hardlink');
    fs.linkSync(item.file, path.join(item.folder, 'alias.txt'));
    const local = dpi.createDomainEditor({ discover: () => [item.folder] });
    assert.equal(local.inspect()[0].supported, false);
  });
  await asyncTest('old background/default paths cannot write/start/restart', async () => {
    const mutators = ['writeFileSync', 'mkdirSync', 'copyFileSync', 'writeSync', 'openSync'];
    const saved = Object.fromEntries(mutators.map((key) => [key, fs[key]]));
    let writes = 0;
    try {
      for (const key of mutators) fs[key] = () => { writes++; throw new Error('forbidden write'); };
      globalThis.fetch = async () => ({ status: 503, body: { cancel: async () => {} } });
      dpi.configure({ dataDir: root });
      watcher.configure({ dataDir: root });
      assert.equal((await auto.repair()).ok, false);
      assert.equal((await auto.repair({ force: true })).ok, false);
      assert.equal(dpi.addDomainsToZapret([first.folder]).ok, false);
      assert.equal((await auto.ensure({ force: true })).repaired, false);
      assert.equal((await watcher.startBypass()).started, false);
      assert.equal((await watcher.startBypass({ strategy: 'general.bat' })).started, false);
      assert.equal(writes, 0);
    } finally { Object.assign(fs, saved); }
  });
  await asyncTest('all host probes release successful and failed response bodies', async () => {
    let cancelled = 0;
    globalThis.fetch = async () => ({ status: 503, body: { cancel: async () => { cancelled++; } } });
    assert.equal((await auto.check()).ok, false);
    assert.equal(cancelled, 3);
    globalThis.fetch = async () => ({ status: 200, body: { cancel: async () => { cancelled++; } } });
    assert.equal((await dpi.probe()).ok, true);
    assert.equal(cancelled, 4);
  });
  await asyncTest('UI cancel, close and invalid selections never submit mutation', async () => {
    let posts = 0;
    let confirmCalls = 0;
    let promptResult = null;
    let agreed = false;
    const candidates = editor.inspect().filter((entry) => entry.missingDomains.length);
    candidates.push({ ...candidates[0], file: candidates[0].file + '-second' });
    const context = vm.createContext({ console, setTimeout, clearTimeout,
      window: { prompt: () => promptResult, confirm: () => { confirmCalls++; return agreed; } },
      toast() {}, autoFixDpiRequest: async () => ({ folders: candidates, results: [] }),
      applyDpi: async () => { posts++; return { ok: true }; } });
    vm.runInContext(stripImports(fs.readFileSync(path.join(here, '../web/js/screens/sources.js'), 'utf8')) +
      '\nglobalThis.test = { autoFixDpi, confirmDomains };', context);
    for (const answer of [null, '', '0', '999', 'invalid']) {
      promptResult = answer;
      await context.test.autoFixDpi();
    }
    assert.equal(posts, 0);
    assert.equal(confirmCalls, 0);
    promptResult = '1';
    await context.test.autoFixDpi();
    assert.equal(posts, 0);
    agreed = true;
    const chosen = await context.test.confirmDomains({ folders: candidates });
    assert.equal(chosen.target, candidates[0].file);
    assert.deepEqual([...chosen.domains], candidates[0].missingDomains);
    assert.equal(chosen.revision, candidates[0].revision);
  });
  await asyncTest('client default diagnostics GET; mutation POST includes complete consent', async () => {
    const calls = [];
    const context = vm.createContext({ console, setTimeout, clearTimeout, AbortController,
      fetch: async (url, options) => { calls.push({ url, ...options }); return { ok: true, text: async () => '{"ok":true}' }; } });
    vm.runInContext(stripImports(fs.readFileSync(path.join(here, '../web/js/api.js'), 'utf8')) +
      '\nglobalThis.test = { autoFixDpiRequest, applyDpi };', context);
    await context.test.autoFixDpiRequest({ apply: true, force: true });
    assert.equal(calls[0].url, '/api/dpi/check');
    assert.equal(calls[0].method, 'GET');
    await context.test.applyDpi();
    assert.equal(calls.length, 1);
    const consent = payload(editor.inspect()[1]);
    await context.test.applyDpi(consent);
    assert.equal(calls[1].method, 'POST');
    assert.equal(calls[1].url, '/api/dpi/apply');
    assert.deepEqual(JSON.parse(calls[1].body), consent);
  });
  test('autofix and sign-in contain no bypass starts or list repair calls', () => {
    const autofix = fs.readFileSync(path.join(here, 'autofix.mjs'), 'utf8');
    assert.doesNotMatch(autofix, /startBypass|dpiauto\.repair|addDomainsToZapret/);
    const sources = fs.readFileSync(path.join(here, '../web/js/screens/sources.js'), 'utf8');
    assert.doesNotMatch(sources, /startBypassRequest|autoEnableBypass|MutationObserver/);
    assert.doesNotMatch(fs.readFileSync(path.join(here, 'dpiwatcher.mjs'), 'utf8'), /taskkill|child_process|spawn\(/);
  });
  console.log(`Passed ${tests} isolated safety checks.`);
} finally {
  globalThis.fetch = originalFetch;
  // root is created above with mkdtemp, always under the OS temp directory.
  assert.equal(path.dirname(root), os.tmpdir());
  assert.ok(path.basename(root).startsWith('labsoul-dpi-safety-'));
  fs.rmSync(root, { recursive: true, force: true });
}
