/** Atomic, versioned audio+MIME cache. mtime is LRU only; createdAt enforces hard TTL. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const positive = (value, fallback) => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : fallback;
const MAX_BYTES = positive(process.env.PLAYER_CACHE_BYTES, 2 * 1024 ** 3);
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAGIC = Buffer.from('PLAYERAUDIO1\n');
const MAX_HEADER = 1024;
let dir = '';
const validMime = value => typeof value === 'string' && value.length <= 200 && /^(audio\/[\w.+-]+|application\/ogg)(;[\x20-\x7e]*)?$/i.test(value);

export function configure(dataDir) {
  const base = dataDir || process.env.PLAYER_DATA_DIR || path.join(process.cwd(), 'data');
  dir = path.join(base, 'audio-cache');
  try {
    fs.mkdirSync(dir, { recursive: true });
    // A crashed writer can leave an unpublished temp file. These names are
    // exclusively ours; a live synchronous write cannot interleave configure().
    for (const name of fs.readdirSync(dir)) {
      if (/^[a-f0-9]{64}\.audio\.[a-f0-9-]{36}\.tmp$/.test(name)) discard(path.join(dir, name));
    }
    trim();
  } catch { dir = ''; }
}
function fileFor(source, sourceId) {
  const hash = crypto.createHash('sha256').update(JSON.stringify([String(source), String(sourceId)])).digest('hex');
  return path.join(dir, `${hash}.audio`);
}
function discard(file) { try { fs.unlinkSync(file); } catch { /* optional cache */ } }
function descriptor(file, includeBuffer = false) {
  let fd;
  try {
    const stat = fs.statSync(file);
    if (stat.size > MAX_BYTES || stat.size <= MAGIC.length + 4) throw Error('size');
    fd = fs.openSync(file, 'r');
    const prefix = Buffer.alloc(MAGIC.length + 4);
    if (fs.readSync(fd, prefix, 0, prefix.length, 0) !== prefix.length || !prefix.subarray(0, MAGIC.length).equals(MAGIC)) throw Error('legacy');
    const length = prefix.readUInt32BE(MAGIC.length);
    if (!length || length > MAX_HEADER || prefix.length + length >= stat.size) throw Error('header');
    const header = Buffer.alloc(length);
    if (fs.readSync(fd, header, 0, length, prefix.length) !== length) throw Error('truncated');
    const meta = JSON.parse(header.toString('utf8'));
    if (meta.version !== 1 || !validMime(meta.contentType) || !Number.isSafeInteger(meta.createdAt)
        || meta.createdAt > Date.now() || Date.now() - meta.createdAt >= MAX_AGE_MS
        || meta.bytes !== stat.size - prefix.length - length) throw Error('metadata');
    const result = { ...meta, size: stat.size, accessedAt: stat.mtimeMs };
    if (includeBuffer) {
      result.buffer = Buffer.alloc(meta.bytes);
      if (fs.readSync(fd, result.buffer, 0, meta.bytes, prefix.length + length) !== meta.bytes) throw Error('truncated');
    }
    return result;
  } catch {
    if (fd !== undefined) { fs.closeSync(fd); fd = undefined; }
    discard(file); return null;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
export function has(source, sourceId) { return Boolean(dir && descriptor(fileFor(source, sourceId))); }
/** Returns null or {buffer,contentType}; callers MUST retain MIME on cold hits. */
export function read(source, sourceId) {
  if (!dir) return null;
  const file = fileFor(source, sourceId);
  const entry = descriptor(file, true);
  if (!entry) return null;
  try { fs.utimesSync(file, new Date(), new Date()); } catch { /* LRU only */ }
  return { buffer: entry.buffer, contentType: entry.contentType };
}
export function write(source, sourceId, buffer, contentType) {
  if (!dir || !Buffer.isBuffer(buffer) || !buffer.length || !validMime(contentType)) return false;
  const meta = Buffer.from(JSON.stringify({ version: 1, createdAt: Date.now(), bytes: buffer.length, contentType }));
  if (meta.length > MAX_HEADER || MAGIC.length + 4 + meta.length + buffer.length > MAX_BYTES) return false;
  const file = fileFor(source, sourceId);
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  let fd;
  try {
    const prefix = Buffer.alloc(MAGIC.length + 4);
    MAGIC.copy(prefix); prefix.writeUInt32BE(meta.length, MAGIC.length);
    fd = fs.openSync(temp, 'wx');
    fs.writeFileSync(fd, Buffer.concat([prefix, meta, buffer]));
    fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    fs.renameSync(temp, file);
    trim();
    return fs.existsSync(file);
  } catch { return false; }
  finally { if (fd !== undefined) fs.closeSync(fd); discard(temp); }
}
function entries() {
  const result = [];
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!item.isFile()) continue;
    const file = path.join(dir, item.name);
    // Old raw .bin files have no trustworthy MIME/creation timestamp: never serve them.
    if (item.name.endsWith('.bin')) { discard(file); continue; }
    if (!/^[a-f0-9]{64}\.audio$/.test(item.name)) continue;
    const meta = descriptor(file);
    if (meta) result.push({ file, ...meta });
  }
  return result;
}
function trim() {
  if (!dir) return;
  try {
    const files = entries().sort((a, b) => a.accessedAt - b.accessedAt);
    let total = files.reduce((sum, e) => sum + e.size, 0);
    for (const entry of files) {
      if (total <= MAX_BYTES) break;
      discard(entry.file);
      if (!fs.existsSync(entry.file)) total -= entry.size;
    }
  } catch { /* optional cache */ }
}
export function stats() {
  try {
    trim(); const files = dir ? entries() : [];
    return { dir, files: files.length, bytes: files.reduce((sum, e) => sum + e.size, 0), maxBytes: MAX_BYTES };
  } catch { return { dir, files: 0, bytes: 0, maxBytes: MAX_BYTES }; }
}
export function clear() {
  if (!dir) return 0;
  let count = 0;
  try {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!item.isFile() || !(/^[a-f0-9]{64}\.audio$/.test(item.name) || item.name.endsWith('.bin'))) continue;
      const file = path.join(dir, item.name); discard(file);
      if (!fs.existsSync(file)) count++;
    }
  } catch { /* optional cache */ }
  return count;
}
