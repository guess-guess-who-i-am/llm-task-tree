import test from 'node:test';
import assert from 'node:assert/strict';

test('fresh IDE and isolated worker projects default to the same keyless shared search service', async()=>{
  const {resolveWebSearchConfig}=await import('./web-search-config.js');
  assert.deepEqual(resolveWebSearchConfig({},{}),{provider:'openwebsearch',apiKey:'',hasApiKey:false,requiresApiKey:false,baseUrl:'http://127.0.0.1:3210',enabled:true,maxResults:8});
});

test('explicit saved disabled search remains disabled; selecting a provider must not override it',async()=>{
  const {resolveWebSearchConfig}=await import('./web-search-config.js');
  assert.equal(resolveWebSearchConfig({},{provider:'openwebsearch',enabled:false}).enabled,false);
  assert.equal(resolveWebSearchConfig({WEB_SEARCH_ENABLED:'false'},{enabled:true}).enabled,false);
  assert.equal(resolveWebSearchConfig({WEB_SEARCH_ENABLED:'true'},{enabled:false}).enabled,true);
});

test('explicit provider, key and endpoint override defaults without leaking the key publicly',async()=>{
  const {resolveWebSearchConfig}=await import('./web-search-config.js');
  const env={WEB_SEARCH_PROVIDER:'Tavily',WEB_SEARCH_API_KEY:'test-only',WEB_SEARCH_BASE_URL:'https://example.com/search/'};
  const publicConfig=resolveWebSearchConfig(env,{});
  assert.equal(publicConfig.provider,'tavily');assert.equal(publicConfig.requiresApiKey,true);
  assert.equal(publicConfig.baseUrl,'https://example.com/search');assert.equal(publicConfig.hasApiKey,true);
  assert.equal(publicConfig.apiKey,'');
  assert.equal(resolveWebSearchConfig({WEB_SEARCH_PROVIDER:'tavily'},{}).baseUrl,'');
  assert.equal(resolveWebSearchConfig(env,{},{includeKey:true}).apiKey,'test-only');
  assert.equal(resolveWebSearchConfig({},{provider:'brave',baseUrl:'https://example.com/brave',apiKey:'saved-key'}).provider,'brave');
});

test('an explicitly enabled upstream proxy keeps its address, not the upstream default port',async()=>{
  const {searchDaemonEnvironment}=await import('./open-websearch-installation.js');
  const env=searchDaemonEnvironment({USE_PROXY:'true',HTTPS_PROXY:'http://127.0.0.1:8888'});
  assert.equal(env.PROXY_URL,'http://127.0.0.1:8888');
});
