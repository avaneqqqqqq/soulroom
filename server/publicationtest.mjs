import assert from 'node:assert/strict';
import { isPublicPath } from '../tools/push-github.mjs';
import { requestIsLocal } from './requestguard.mjs';

const local = (headers) => ({ socket: { localPort: 5270 }, headers });
assert.equal(requestIsLocal(local({ host: '127.0.0.1:5270' })), true);
assert.equal(requestIsLocal(local({ host: '127.0.0.1:5270', origin: 'http://127.0.0.1:5270' })), true);
for (const headers of [
  { host: 'attacker.example:5270' },
  { host: '127.0.0.1:5270', origin: 'https://attacker.example' },
  { host: '127.0.0.1:5270', origin: 'null' },
  { host: '127.0.0.1:5270', 'sec-fetch-site': 'cross-site' },
]) assert.equal(requestIsLocal(local(headers)), false);

for (const name of ['cert-test.pfx', 'NOTES.md', '.devdata2/out.log', 'data/settings.json', 'data/.github-token', 'server/data/settings.json', 'server/node_modules/foo/index.js', 'web/.env', 'tools/sign-installer.ps1', 'app/dist/app.exe', 'server/../data/token.json', '_pub.mjs']) {
  assert.equal(isPublicPath(name), false, `private path must be blocked: ${name}`);
}
for (const name of ['package.json', '.gitignore', 'server/index.mjs', 'web/js/screens/tokenhelp.js', 'web/css/nowplaying.css', 'app/build/afterpack.cjs', 'relay/relay.mjs', 'tools/push-github.mjs']) {
  assert.equal(isPublicPath(name), true, `source path must be allowed: ${name}`);
}
console.log('Publication allowlist: 20 checks passed');
