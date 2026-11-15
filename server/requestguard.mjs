/** Reject DNS rebinding and browser requests from unrelated websites. */
export function requestIsLocal(req) {
  const port = req.socket?.localPort;
  const allowed = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  const host = String(req.headers.host || '').toLowerCase();
  if (!allowed.has(host)) return false;
  const origin = req.headers.origin;
  if (origin && ![...allowed].some((value) => origin === `http://${value}`)) return false;
  if (String(req.headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') return false;
  return true;
}
