/** Zapret is managed externally. Never launch, stop, switch or restart user processes. */
import fs from 'node:fs';
import path from 'node:path';
import * as dpi from './dpi.mjs';

export function configure() { /* No strategy cache reads/writes or startup side effects. */ }

export function listStrategies() {
  const folders = dpi.findZapretFolders();
  const folder = folders[0];
  let strategies = [];
  if (folder) {
    try {
      strategies = fs.readdirSync(folder).filter((name) => /^general.*\.bat$/i.test(name))
        .sort().map((name) => ({ name, label: name, remembered: false }));
    } catch { /* Discovery is best effort and read-only. */ }
  }
  return { folder, folders, strategies, current: null, externallyManaged: true };
}

/** Compatibility guard for old startup, login and HTTP callers, including explicit strategies. */
export async function startBypass() {
  return { ok: false, started: false, skipped: true, externallyManaged: true,
    message: 'Плеер не управляет zapret. Выберите и запустите свою стратегию самостоятельно; работающие процессы не изменены.' };
}

export async function status() {
  const running = await dpi.detectRunning();
  return { running: running.running, strategy: null, folders: dpi.findZapretFolders(), externallyManaged: true };
}
