// Search/Fetch only. This adapter never calls a model or treats summaries as evidence.
const DEEPSEEK_ORIGIN = 'https://api.deepseek.com';
const takeCharacters = (value, count) => Array.from(String(value)).slice(0, count).join('');

export function discoveryQueries(project, allowedDomains = []) {
 const sites = allowedDomains.map(d => `site:${d}`).join(' OR ');
 if (Array.from(sites).length > 96) throw Error('Use a small approved domain list for DeepSeek discovery (site filters must fit within 96 characters).');
 const room = sites ? 127 - Array.from(sites).length : 128;
 return [...new Set(project.competitors.map(competitor =>
  takeCharacters([competitor, project.segment, project.market, project.quarter, ...project.focus, project.question].join(' ').replace(/\s+/g, ' ').trim(), room) + (sites ? ' ' + sites : '')
 ))].slice(0, 3);
}

export function createDeepSeekSources({apiKey, allowedDomains = [], allowUrl, fetchImpl = fetch, requestTimeoutMs = 12000}) {
 const notices = [], metadata = new Map();
 async function request(tool, payload) {
  let res;
  try {
   res = await fetchImpl(`${DEEPSEEK_ORIGIN}/v1/tools/${tool}`, {
    method:'POST', redirect:'error', signal:AbortSignal.timeout(Math.min(60000,Math.max(1000,requestTimeoutMs))),
    headers:{Authorization:`Bearer ${apiKey}`, 'Content-Type':'application/json'},
    body:JSON.stringify(payload)
   });
  } catch { throw Error(`DeepSeek ${tool} could not connect or timed out.`); }
  if (!res.ok) {
   const hint = {401:'Check the backend DEEPSEEK_API_KEY.',402:'DeepSeek account balance is insufficient.',403:'The provider rejected this public page.',404:'No readable page content was available.',429:'Provider rate limit reached; retry later.'}[res.status] || 'Retry later or check provider availability.';
   // Do not forward provider bodies: they may contain credentials or submitted content.
   throw Error(`DeepSeek ${tool} failed (HTTP ${res.status}). ${hint}`);
  }
  if (Number(res.headers.get('content-length') || 0) > 2000000) throw Error('DeepSeek response exceeds 2 MB limit.');
  const reader = res.body?.getReader();
  if (!reader) throw Error('DeepSeek returned an empty response.');
  const chunks = []; let bytes = 0;
  try {
   while (true) {
    const {done,value} = await reader.read(); if (done) break;
    bytes += value.byteLength; if (bytes > 2000000) throw Error('DeepSeek response exceeds 2 MB limit.');
    chunks.push(value);
   }
  } finally { await reader.cancel(); }
  const buffer = new Uint8Array(bytes); let offset = 0;
  for (const chunk of chunks) { buffer.set(chunk,offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(buffer)); }
  catch { throw Error('DeepSeek returned invalid JSON.'); }
 }
 return {
  notices,
  async discover(project) {
   const queries = discoveryQueries(project, allowedDomains);
   const responses = await Promise.allSettled(queries.map(query => request('search', {
    query, count:5, need_content:false, ori_question:takeCharacters(project.question,128)
   })));
   const urls = []; let success = 0, skipped = 0;
   for (const result of responses) {
    if (result.status === 'rejected') { notices.push(result.reason.message); continue; }
    if (!Array.isArray(result.value.results)) { notices.push('DeepSeek search response did not contain a results array.'); continue; }
    success++;
    for (const item of result.value.results) {
     try {
      const url = allowUrl(item.url);
      if (!urls.includes(url)) { urls.push(url); metadata.set(url,item); }
     } catch { skipped++; }
    }
   }
   if (skipped) notices.push(`${skipped} search result(s) were excluded by the public HTTPS source policy.`);
   if (!success) throw Error(notices.join(' ') || 'DeepSeek search failed.');
   return urls;
  },
  async fetchSource(raw) {
   const url = allowUrl(raw);
   const page = await request('fetch', {url});
   if (typeof page.content !== 'string' || page.content.trim().length < 120) throw Error('DeepSeek Fetch returned insufficient readable source text.');
   // Fetch returns title/content, without a verified publication date. Do not turn
   // the search index date into a source-verified publication date.
   const item = metadata.get(url);
   const title = [page.title,item?.title,new URL(url).hostname].find(t => typeof t === 'string' && t.trim());
   return {url,title:title.trim().slice(0,1000),text:page.content.trim().slice(0,24000),published_at:null};
  }
 };
}

