const {test} = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const {fork} = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const forward = require('../desktop-loopback.cjs');

test('an occupied UI port keeps its origin and forwards to the packaged server', {timeout: 15000}, async () => {
  const old = http.createServer((_req, res) => res.end('wrong backend'));
  await new Promise(resolve => old.listen(0, '127.0.0.1', resolve));
  const port = old.address().port;
  const origin = 'http://127.0.0.1:' + port;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'soulroom-port-'));
  const server = fork(path.join(__dirname, 'index.mjs'), [], {
    env: {...process.env, PORT: String(port), PLAYER_DATA_DIR: dir},
    stdio: ['ignore', 'ignore', 'ignore', 'ipc']
  });
  try {
    const ready = await new Promise((resolve,reject) => {
      server.once('message',resolve);
      server.once('error',reject);
      server.once('exit',() => reject(Error('Server exited before binding')));
    });
    assert.equal(ready.type, 'listening');
    assert.notEqual(ready.port, port);
    const backend = 'http://127.0.0.1:' + ready.port;
    const req = new Request(origin + '/api/health', {headers:{origin}});
    const response = await forward(req,origin,backend);
    assert.equal((await response.json()).pid,server.pid);
    req.initiatorOrigin = 'https://another-site.example';
    assert.equal((await forward(req,origin,backend)).status,403);
  } finally {
    const stopped = new Promise(resolve => server.once('exit',resolve));
    server.kill();
    await stopped;
    await new Promise(resolve => old.close(resolve));
    await fs.rm(dir,{recursive:true,force:true});
  }
});
