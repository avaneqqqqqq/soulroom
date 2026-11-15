import test from 'node:test';
import assert from 'node:assert/strict';
import * as proxy from './proxy.mjs';
test('proxy diagnostic compares direct and configured proxy dispatchers separately',async()=>{
const original=globalThis.fetch;const calls=[];
globalThis.fetch=async(url,opts)=>{calls.push(opts);return new Response(null,{status:401})};
try{await proxy.refresh({proxy:'http://user:password@127.0.0.1:8080'});calls.length=0;const result=await proxy.test();assert.equal(result.direct.reachable,true);assert.equal(result.viaProxy.reachable,true);assert.equal(calls.length,2);assert.equal(calls[0].dispatcher,undefined);assert.ok(calls[1].dispatcher);assert.ok(!proxy.status().activeMasked.includes('password'));}finally{await proxy.refresh({});globalThis.fetch=original}
});
test('unsupported proxy schemes are rejected rather than silently treated as working',()=>{
assert.equal(proxy.normalizeProxy('socks5://localhost:1080'),'');assert.equal(proxy.normalizeProxy('http://localhost:8080'),'http://localhost:8080');assert.equal(proxy.normalizeProxy('localhost:8080'),'http://localhost:8080');
});
