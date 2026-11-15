/** Read-only zapret diagnostics. Only repair() with file-bound consent may append domains. */
import * as dpi from './dpi.mjs';

const CHECK_HOSTS = [
  { name: 'soundcloud.com', url: 'https://soundcloud.com/', label: 'сайт SoundCloud' },
  { name: 'api-v2', url: 'https://api-v2.soundcloud.com/', label: 'API SoundCloud' },
  { name: 'CDN', url: 'https://i1.sndcdn.com/', label: 'хранилище обложек' },
];
const state = { lastCheck: 0, lastRepair: 0, lastResult: null, log: [] };

async function checkHost(host) {
  const started = Date.now();
  try {
    const response = await fetch(host.url, {
      signal: AbortSignal.timeout(7000),
      headers: { 'user-agent': 'Mozilla/5.0' },
    });
    const status = response.status;
    // We need headers only. Always release successful and failed HTTP response bodies.
    await response.body?.cancel();
    return { host: host.name, label: host.label, ok: status < 500, status, ms: Date.now() - started };
  } catch (error) {
    return { host: host.name, label: host.label, ok: false, error: error.code || error.name, ms: Date.now() - started };
  }
}

export async function check() {
  const results = await Promise.all(CHECK_HOSTS.map(checkHost));
  state.lastCheck = Date.now();
  state.lastResult = { ok: results.every((item) => item.ok), results,
    failed: results.filter((item) => !item.ok).map((item) => item.label) };
  return state.lastResult;
}

export async function inspect() {
  const result = await check();
  const folders = dpi.inspectDomainLists();
  return { ...result, folders, zapretFound: folders.length > 0,
    needsDomains: folders.some((entry) => entry.supported && entry.missingDomains.length > 0),
    readOnly: true, suggestion: 'Диагностика не меняет файлы и не управляет zapret.' };
}

/** POST only: confirmed + exact target + preview revision + full missing domain array. */
export async function repair(options = {}) {
  const result = dpi.addDomainsToZapret(options);
  if (result.ok && result.added) state.lastRepair = Date.now();
  return result;
}

/** Historical background/startup callers remain diagnostic, even with force/apply flags. */
export async function ensure() {
  return { ...(await check()), checked: true, repaired: false, readOnly: true };
}

export function report() { return { ...state, cooldownMs: 0 }; }
export function resetCooldown() { /* Retained for API compatibility; no mutation authorization. */ }
