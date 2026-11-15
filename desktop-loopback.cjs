// Keep browser storage and IPC tied to the original origin while a second server owns its port.
module.exports = function forward(request, origin, backendOrigin) {
  const url = new URL(request.url);
  if (url.origin !== origin || (request.initiatorOrigin && request.initiatorOrigin !== origin)) {
    return new Response(null, {status: 403});
  }
  const headers = new Headers(request.headers);
  headers.delete('host');
  if (headers.get('origin') === origin) headers.set('origin', backendOrigin);
  return fetch(backendOrigin + url.pathname + url.search, {
    method: request.method, headers, body: request.body, duplex: 'half',
    redirect: 'manual', signal: request.signal
  });
};
