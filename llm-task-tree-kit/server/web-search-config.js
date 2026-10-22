export function defaultWebSearchConfig() {
  return {provider:'openwebsearch',apiKey:'',baseUrl:'http://127.0.0.1:3210',enabled:true,maxResults:8};
}
export function normalizeWebSearchProvider(value) {
  const compact=String(value || '').trim().toLowerCase().replace(/[\s_-]+/g,'');
  return ['openwebsearch','searxng','tavily','brave','exa'].includes(compact)?compact:String(value || '').trim().toLowerCase();
}
export function resolveWebSearchConfig(env={},saved={}, {includeKey=false}={}) {
  const defaults=defaultWebSearchConfig();
  const provider=normalizeWebSearchProvider(env.WEB_SEARCH_PROVIDER || saved.provider || defaults.provider);
  const key=env.WEB_SEARCH_API_KEY || env.TAVILY_API_KEY || env.BRAVE_SEARCH_API_KEY || env.EXA_API_KEY || saved.apiKey || saved.api_key || '';
  const baseUrl=String(env.WEB_SEARCH_BASE_URL || saved.baseUrl || saved.base_url || '').trim().replace(/\/+$/,'') || (provider==='openwebsearch'?defaults.baseUrl:'');
  const enabled=String(env.WEB_SEARCH_ENABLED || '').trim()
    ? !['false','0','no','off'].includes(String(env.WEB_SEARCH_ENABLED).trim().toLowerCase())
    : typeof saved.enabled==='boolean'?saved.enabled:true;
  return {provider,apiKey:includeKey?String(key):'',hasApiKey:Boolean(key),requiresApiKey:!['searxng','openwebsearch'].includes(provider),baseUrl,enabled,
    maxResults:Math.max(1,Math.min(15,Number(env.WEB_SEARCH_MAX_RESULTS || saved.maxResults)||defaults.maxResults))};
}
