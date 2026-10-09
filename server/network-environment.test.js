import test from 'node:test';
import assert from 'node:assert/strict';
import { localNetworkEnvironment } from './network-environment.js';

test('Finder startup uses macOS proxy and keeps local task-tree HTTP outside it', async () => {
  const env=await localNetworkEnvironment({NO_PROXY:'example.local'}, {platform:'darwin',readProxy:async()=>'<dictionary> {\n HTTPEnable : 1\n HTTPProxy : 127.0.0.1\n HTTPPort : 7890\n HTTPSEnable : 1\n HTTPSProxy : 127.0.0.1\n HTTPSPort : 7890\n}'});
  assert.equal(env.HTTPS_PROXY,'http://127.0.0.1:7890');
  assert.equal(env.HTTP_PROXY,'http://127.0.0.1:7890');
  assert.equal(env.NODE_USE_ENV_PROXY,'1');
  assert.match(env.NO_PROXY,/127\.0\.0\.1/);assert.match(env.NO_PROXY,/example\.local/);
});
test('explicit proxy settings are respected; proxy-disabled hosts stay direct', async () => {
  const env=await localNetworkEnvironment({https_proxy:'http://example.local:1234'},{platform:'darwin',readProxy:async()=>{throw new Error('must not read system proxy');}});
  assert.equal(env.https_proxy,'http://example.local:1234');
  assert.equal(env.HTTPS_PROXY,undefined);
  assert.deepEqual(await localNetworkEnvironment({},{platform:'linux'}),{});
});
