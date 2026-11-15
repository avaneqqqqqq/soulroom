/** Read-only zapret discovery/probes and explicitly confirmed, per-file domain appends. */

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Домены, которые нужно обходить для работы SoundCloud. */
export const TARGET_DOMAINS = [
  'soundcloud.com',
  'sndcdn.com',
  'soundcloud.cloud',
  'api-v2.soundcloud.com',
  'api-auth.soundcloud.com',
  'soundcloud.app.goo.gl',
  // YouTube нужен для клипов: без него поиск видео возвращает пустоту
  'youtube.com',
  'www.youtube.com',
  'youtu.be',
  'youtube-nocookie.com',
  'googlevideo.com',
  'ytimg.com',
];

/** Домены, которые НЕ трогаем — у пользователя свой обход для них. */
/**
 * Домены, которые НЕ трогаем.
 *
 * Discord не трогаем: у пользователя своя стратегия для него, и наши
 * правки могли помешать голосовой связи. YouTube, наоборот, нам нужен —
 * он в TARGET_DOMAINS, потому что без него не работают клипы.
 */
export const AVOID_DOMAINS = [
  'discord.com',
  'discordapp.com',
  'discord.gg',
];

let dir = '';

/** Каталог для наших файлов (если понадобится свой обход). */
export function configure({ dataDir } = {}) {
  const base = dataDir || process.env.PLAYER_DATA_DIR || path.join(HERE, '..', 'data');
  dir = path.join(base, 'zapret');
  // Configuration and diagnostics must never create files or directories.
}

/**
 * Найти папки установленного zapret.
 *
 * Признак установки — файл bin\winws.exe. Сборку кладут куда угодно,
 * поэтому проверяем:
 *   • стандартные папки на системном диске;
 *   • рабочий стол и «Загрузки» — в том числе внутри OneDrive,
 *     потому что у многих папки профиля перенесены туда;
 *   • корни ВСЕХ локальных дисков (D:, E: и т.д.);
 *   • один уровень вглубь от каждого корня.
 *
 * Раньше искали только в C:\ и профиле — и у людей с другим диском
 * плеер отвечал «сборка не найдена», хотя она была.
 */
export function findZapretFolders() {
  if (process.platform !== 'win32') return [];

  const home = process.env.USERPROFILE || '';

  /* --- 1. папки-кандидаты: смотрим в них и одним уровнем ниже --- */
  const roots = [
    'C:\\',
    'C:\\Program Files',
    'C:\\Program Files (x86)',
    'C:\\ProgramData',
    path.join(home, 'Desktop'),
    path.join(home, 'Downloads'),
    path.join(home, 'Documents'),
    path.join(home, 'AppData', 'Local', 'Programs'),
    path.join(home, 'AppData', 'Roaming'),
  ];

  // OneDrive: у многих профиль перенесён, и рабочий стол живёт там
  for (const dir of [home, 'C:\\Users\\Public']) {
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (!/^OneDrive/i.test(entry.name)) continue;
        const base = path.join(dir, entry.name);
        roots.push(base, path.join(base, 'Desktop'), path.join(base, 'Downloads'), path.join(base, 'Documents'));
      }
    } catch { /* нет доступа */ }
  }

  /* --- 2. корни всех локальных дисков --- */
  try {
    for (const letter of 'DEFGHIJKLMNOPQRSTUVWXYZ') {
      const drive = `${letter}:\\`;
      try {
        if (fs.existsSync(drive)) roots.push(drive);
      } catch { /* диска нет */ }
    }
  } catch { /* ignore */ }

  const found = new Set();

  const consider = (candidate) => {
    try {
      if (fs.existsSync(path.join(candidate, 'bin', 'winws.exe'))) found.add(candidate);
    } catch {
      /* путь недоступен */
    }
  };

  for (const root of roots.filter(Boolean)) {
    consider(root);
    try {
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        // сначала точное имя, потом любые папки с ключевым словом
        if (/zapret|byedpi|goodbye/i.test(entry.name)) consider(path.join(root, entry.name));
      }
    } catch {
      /* каталога нет или нет доступа */
    }
  }

  return [...found];
}

/**
 * Списки zapret, куда дописываем домены SoundCloud.
 *
 * ТОЛЬКО пользовательский список. `list-general.txt` и `list-google.txt`
 * приходят из репозитория zapret и принадлежат автору сборки: правки там
 * теряются при обновлении и могут совпасть с его собственной задумкой.
 * `list-general-user.txt` создан именно для записей пользователя — его
 * обновление не перезаписывает, и его легко откатить, просто удалив строки.
 *
 * Исключения НЕ трогаем: `list-exclude*.txt` — это «не обходить», запись
 * туда сделала бы хуже.
 */
export const WRITABLE_LISTS = [
  'list-general-user.txt',
];

/** Only strict UTF-8 (with optional BOM) is supported. Never transcode a list. */
export function createDomainEditor({ filesystem = fs, discover = findZapretFolders } = {}) {
  const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
  const samePath = (a, b) => process.platform === 'win32'
    ? a.toLowerCase() === b.toLowerCase() : a === b;
  function validate(file) {
    if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error('Нужен полный путь выбранного файла');
    const folder = discover().find((candidate) => samePath(path.join(path.resolve(candidate), 'lists', WRITABLE_LISTS[0]), file));
    if (!folder) throw new Error('Файл не принадлежит найденной установке zapret');
    // Refuse junctions, symlinks and hardlinks: the consent must name the actual file.
    for (const item of [path.resolve(folder), path.join(path.resolve(folder), 'lists'), file]) {
      if (filesystem.lstatSync(item).isSymbolicLink() || !samePath(filesystem.realpathSync(item), item)) {
        throw new Error('Ссылки и перенаправленные пути не поддерживаются');
      }
    }
    const stat = filesystem.statSync(file);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error('Нужен обычный файл без жёстких ссылок');
    return stat;
  }
  function preview(file) {
    validate(file);
    const bytes = filesystem.readFileSync(file);
    // NUL/UTF-16/legacy codepages are not safe to reinterpret as UTF-8.
    if (bytes.includes(0)) throw new Error('Неподдерживаемая кодировка списка');
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw new Error('Неподдерживаемая кодировка: требуется UTF-8'); }
    const known = new Set(text.split(/\r?\n/).map((line) => line.trim().toLowerCase().replace(/^\^/, '')));
    const missingDomains = TARGET_DOMAINS.filter((domain) => !known.has(domain));
    return { file, revision: hash(bytes), missingDomains, bytes, text };
  }
  function inspect() {
    return discover().map((folder) => {
      const file = path.join(path.resolve(folder), 'lists', WRITABLE_LISTS[0]);
      try {
        const { revision, missingDomains } = preview(file);
        return { folder, file, exists: true, supported: true, revision, missingDomains };
      } catch (error) {
        return { folder, file, exists: filesystem.existsSync(file), supported: false, missingDomains: [], error: error.message };
      }
    });
  }
  function apply(options = {}) {
    // Old folder-array callers and force/apply flags do not authorize anything.
    if (options?.confirmed !== true || typeof options.target !== 'string' ||
        typeof options.revision !== 'string' || !Array.isArray(options.domains)) {
      return { ok: false, added: 0, message: 'Требуется явное согласие на один выбранный файл и полный список доменов' };
    }
    let fd;
    let backup;
    try {
      const current = preview(options.target);
      if (current.revision !== options.revision || JSON.stringify(current.missingDomains) !== JSON.stringify(options.domains)) {
        throw new Error('Список изменился: повторите просмотр и подтверждение');
      }
      if (!current.missingDomains.length) return { ok: true, added: 0, files: 0, restarted: false, message: 'Менять нечего' };
      fd = filesystem.openSync(current.file, 'r+');
      const stat = filesystem.fstatSync(fd);
      const named = validate(current.file);
      if (stat.dev !== named.dev || stat.ino !== named.ino || !filesystem.readFileSync(fd).equals(current.bytes)) {
        throw new Error('Файл изменился: повторите подтверждение');
      }
      // Unique exclusive backup; any backup failure aborts BEFORE the target is touched.
      backup = current.file + '.labsoul-backup-' + randomUUID();
      filesystem.writeFileSync(backup, current.bytes, { flag: 'wx' });
      if (!filesystem.readFileSync(backup).equals(current.bytes)) throw new Error('Не удалось проверить резервную копию');
      const newline = current.text.includes('\r\n') ? '\r\n' : '\n';
      const prefix = current.bytes.length && !current.text.endsWith('\n') ? newline : '';
      const appended = Buffer.from(prefix + current.missingDomains.map((domain) => '^' + domain).join(newline) + newline, 'utf8');
      const next = Buffer.concat([current.bytes, appended]);
      const latest = validate(current.file);
      if (latest.dev !== stat.dev || latest.ino !== stat.ino || !filesystem.readFileSync(current.file).equals(current.bytes)) {
        throw new Error('Файл изменился во время создания копии: повторите подтверждение');
      }
      try {
        // Append only: all original bytes, including comments/placeholders/BOM, remain intact.
        let written = 0;
        while (written < appended.length) {
          const count = filesystem.writeSync(fd, appended, written, appended.length - written, current.bytes.length + written);
          if (!count) throw new Error('Неполная запись');
          written += count;
        }
        filesystem.fsyncSync(fd);
        if (!filesystem.readFileSync(current.file).equals(next)) throw new Error('Проверка записи не прошла');
      } catch (error) {
        // The writer only touched bytes after the original EOF: remove the partial append,
        // never truncate/rewrite original entries. The verified backup remains available.
        filesystem.ftruncateSync(fd, current.bytes.length);
        filesystem.fsyncSync(fd);
        throw error;
      }
      return { ok: true, added: current.missingDomains.length, files: 1, target: current.file, backup,
        restarted: false, needsRestart: true,
        message: 'Домены добавлены в выбранный файл. Плеер не запускает и не перезапускает zapret.' };
    } catch (error) {
      return { ok: false, added: 0, backup, message: error.message };
    } finally {
      if (fd !== undefined) filesystem.closeSync(fd);
    }
  }
  return { inspect, apply };
}

export function inspectDomainLists() { return createDomainEditor().inspect(); }
export function addDomainsToZapret(options = {}) { return createDomainEditor().apply(options); }

/** Есть ли запущенный обход (чужой или наш). */
export function detectRunning() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      resolve({ running: false });
      return;
    }
    execFile(
      'tasklist',
      ['/FI', 'IMAGENAME eq winws.exe', '/FO', 'CSV', '/NH'],
      { timeout: 5000, windowsHide: true },
      (err, stdout) => {
        if (err || !stdout) {
          resolve({ running: false });
          return;
        }
        const running = /winws\.exe/i.test(stdout);
        resolve({ running, name: running ? 'winws.exe' : null });
      },
    );
  });
}

/**
 * Проверка, открывается ли SoundCloud прямо сейчас.
 *
 * Через обход первые соединения после запуска часто обрываются по
 * таймауту, а следующие проходят за 70–200 мс (проверено: 17 из 20
 * успешных, все три сбоя — самые первые). Поэтому делаем несколько
 * попыток с коротким таймаутом, а не одну длинную: одна неудачная
 * проверка показывала в интерфейсе «SoundCloud не открывается», хотя
 * всё работало.
 */
export async function probe() {
  const started = Date.now();
  let lastError = null;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const res = await fetch('https://soundcloud.com/', {
        signal: AbortSignal.timeout(6000),
        headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/136.0.0.0' },
      });
      await res.body?.cancel();
      if (res.status < 500) {
        return { ok: true, status: res.status, ms: Date.now() - started, attempt };
      }
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      lastError = (err.cause && err.cause.code) || err.name;
    }

    if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 400));
  }

  return { ok: false, error: lastError, ms: Date.now() - started, attempt: 3 };
}

/** Состояние для интерфейса. */
export function status() {
  return {
    dir,
    domains: TARGET_DOMAINS,
    avoid: AVOID_DOMAINS,
  };
}
