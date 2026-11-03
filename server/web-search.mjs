// Pluggable web search used to find an event's official website.
//
// A search engine is only a candidate source: event-jobs fetches the result and
// checks that the page matches the event before anything becomes "official
// website". Providers:
//
//   WEB_SEARCH_PROVIDER=auto|deepseek|searxng|custom|none
//   WEB_SEARCH_URL=https://search.internal.example        # SearXNG base or custom JSON endpoint
//   SEARXNG_URL=http://127.0.0.1:8080                     # alias for WEB_SEARCH_URL
//   WEB_SEARCH_API_KEY=...                                # optional bearer for a custom gateway
//   WEB_SEARCH_LANGUAGE=zh-CN
//   WEB_SEARCH_TIMEOUT_MS=12000
//
// Local deployment recommendations are documented in docs/SEARCH_ENGINES.md.

import {createDeepSeekWebSearch} from './event-search.mjs';

export function searchProviderConfig(env = process.env) {
 const requested = String(env.WEB_SEARCH_PROVIDER || 'auto').toLowerCase();
 const url = String(env.WEB_SEARCH_URL || env.SEARXNG_URL || '').trim().replace(/\/$/, '');
 const apiKey = String(env.WEB_SEARCH_API_KEY || '');
 const language = String(env.WEB_SEARCH_LANGUAGE || 'zh-CN');
 const timeoutMs = Math.max(1000, Number(env.WEB_SEARCH_TIMEOUT_MS) || 12000);
 if (requested === 'none') return {provider: 'none', url: '', apiKey, language, timeoutMs};
 if (['deepseek', 'searxng', 'custom'].includes(requested)) return {provider: requested, url, apiKey, language, timeoutMs};
 // auto: prefer DeepSeek's search tool when a DeepSeek-keyed model is active,
 // otherwise use a configured local search engine.
 return {provider: url ? 'searxng' : 'auto', url, apiKey, language, timeoutMs};
}

function normalizeResults(results, count) {
 return results.slice(0, count)
  .map(item => ({
   url: String(item?.url ?? item?.link ?? '').trim(),
   title: String(item?.title ?? item?.name ?? '').trim(),
  }))
  .filter(item => /^https?:\/\//i.test(item.url));
}

// SearXNG JSON API: enable `json` in the instance's search.formats setting.
export function createSearxngSearch({url, fetchImpl = fetch, language = 'zh-CN', timeoutMs = 12000}) {
 const base = String(url).replace(/\/$/, '');
 return {
  provider: 'searxng',
  async search({query, count = 8} = {}) {
   const endpoint = new URL(base + '/search');
   endpoint.searchParams.set('q', String(query ?? ''));
   endpoint.searchParams.set('format', 'json');
   endpoint.searchParams.set('language', language);
   endpoint.searchParams.set('safesearch', '1');
   const response = await fetchImpl(endpoint.href, {
    redirect: 'error',
    signal: AbortSignal.timeout(Math.max(1000, timeoutMs)),
    headers: {Accept: 'application/json'},
   });
   if (!response.ok) throw Error('Local search failed (HTTP ' + response.status + ')');
   const payload = await response.json().catch(() => { throw Error('Local search returned invalid JSON'); });
   const results = Array.isArray(payload?.results) ? payload.results : Array.isArray(payload?.items) ? payload.items : [];
   return normalizeResults(results, count);
  },
 };
}

// Generic internal search gateway contract: GET ${url}?q=...&limit=... returning
// {results:[{url,title}]} (SearXNG-shaped). `{query}` in the URL is replaced.
export function createCustomJsonSearch({url, apiKey = '', fetchImpl = fetch, timeoutMs = 12000}) {
 return {
  provider: 'custom',
  async search({query, count = 8} = {}) {
   const encoded = encodeURIComponent(String(query ?? ''));
   const endpoint = String(url).includes('{query}')
    ? String(url).replaceAll('{query}', encoded)
    : String(url) + (String(url).includes('?') ? '&' : '?') + 'q=' + encoded + '&limit=' + count;
   const response = await fetchImpl(endpoint, {
    redirect: 'error',
    signal: AbortSignal.timeout(Math.max(1000, timeoutMs)),
    headers: {Accept: 'application/json', ...(apiKey ? {Authorization: 'Bearer ' + apiKey} : {})},
   });
   if (!response.ok) throw Error('Search gateway failed (HTTP ' + response.status + ')');
   const payload = await response.json().catch(() => { throw Error('Search gateway returned invalid JSON'); });
   const results = Array.isArray(payload?.results) ? payload.results : Array.isArray(payload?.items) ? payload.items : Array.isArray(payload?.data) ? payload.data : [];
   return normalizeResults(results, count);
  },
 };
}

// Build the active web-search adapter for event enrichment, or null when no
// provider is configured. It is resolved at construction time in the task
// runner; callers can inject a stub in tests.
export function createWebSearch({env = process.env, getLlm, fetchImpl = fetch} = {}) {
 const config = searchProviderConfig(env);
 if (config.provider === 'none') return null;
 const llm = typeof getLlm === 'function' ? getLlm() : {};
 const deepseekKey = llm?.provider === 'deepseek' ? (llm.key || env.DEEPSEEK_API_KEY || '') : (env.WEB_SEARCH_PROVIDER === 'deepseek' ? (llm?.key || env.DEEPSEEK_API_KEY || '') : '');
 const deepseek = () => createDeepSeekWebSearch({
  getApiKey: () => deepseekKey,
  baseUrl: env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
  fetchImpl,
  timeoutMs: config.timeoutMs,
 });
 if (config.provider === 'deepseek') return deepseekKey ? deepseek() : null;
 if (config.provider === 'searxng') return config.url ? createSearxngSearch({url: config.url, fetchImpl, language: config.language, timeoutMs: config.timeoutMs}) : null;
 if (config.provider === 'custom') return config.url ? createCustomJsonSearch({url: config.url, apiKey: config.apiKey, fetchImpl, timeoutMs: config.timeoutMs}) : null;
 // auto
 if (deepseekKey) return deepseek();
 if (config.url) return createSearxngSearch({url: config.url, fetchImpl, language: config.language, timeoutMs: config.timeoutMs});
 return null;
}
