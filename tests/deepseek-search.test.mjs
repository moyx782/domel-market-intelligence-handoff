import test from 'node:test';
import assert from 'node:assert/strict';
import {createDeepSeekSources,discoveryQueries} from '../supabase/functions/_shared/deepseek-search.mjs';
import {collectResearch} from '../supabase/functions/_shared/research-workflow.mjs';
const project={question:'Which public product information supports our review?',segment:'EC motors',market:'EU',quarter:'2026-Q3',focus:['Technology'],competitors:['ebm-papst'],source_urls:[]};
const url='https://www.ebmpapst.com/gb/en/home.html';
function allowUrl(raw){const u=new URL(raw);if(u.protocol!=='https:'||u.hostname!=='www.ebmpapst.com'||u.username||u.password||u.port)throw Error('Excluded');return u.href;}
const setup=fetchImpl=>createDeepSeekSources({apiKey:'test-secret-do-not-log',allowedDomains:['www.ebmpapst.com'],allowUrl,fetchImpl});
const json=value=>Response.json(value);

test('search uses official endpoint and bearer key, excludes hostile URLs, and fetch saves actual content only',async()=>{
 const calls=[];const adapter=setup(async(endpoint,options)=>{calls.push({endpoint,options});return endpoint.endsWith('/search')?json({results:[{url,title:'indexed title',date:'2026-08-01',summary:'A fabricated claim'},{url:'https://attacker.test/page'},{url:'http://www.ebmpapst.com/page'},{url}]}):json({title:'Actual title',content:'Actual source text. '.repeat(12)});});
 assert.deepEqual(await adapter.discover(project),[url]);
 const source=await adapter.fetchSource(url);
 assert.equal(source.title,'Actual title');assert.equal(source.published_at,null);assert.ok(!source.text.includes('fabricated'));
 assert.equal(calls[0].endpoint,'https://api.deepseek.com/v1/tools/search');
 assert.equal(calls[0].options.headers.Authorization,'Bearer test-secret-do-not-log');
 assert.equal(calls[0].options.redirect,'error');
 assert.equal(JSON.parse(calls[0].options.body).need_content,false);
 assert.match(JSON.parse(calls[0].options.body).query,/site:www\.ebmpapst\.com$/);
 assert.equal(calls[1].endpoint,'https://api.deepseek.com/v1/tools/fetch');
 assert.deepEqual(JSON.parse(calls[1].options.body),{url});
 assert.match(adapter.notices.join(' '),/2 search result/);
});

test('query limits count Unicode characters and preserve administrator site constraints',()=>{
 const queries=discoveryQueries({...project,segment:'机'.repeat(300),question:'🤖'.repeat(200)},['www.ebmpapst.com']);
 assert.ok(queries.every(q=>Array.from(q).length<=128&&q.endsWith('site:www.ebmpapst.com')));
 const open=discoveryQueries(project,[]);assert.ok(open.length);assert.ok(open.every(q=>!q.includes('site:')&&Array.from(q).length<=128));
});

test('a failed search branch preserves successful results and records partial coverage',async()=>{
 let n=0;const adapter=setup(async()=>++n===1?new Response('private error',{status:429}):json({results:[{url}]}));
 assert.deepEqual(await adapter.discover({...project,competitors:['ebm-papst','Nidec']}),[url]);
 assert.match(adapter.notices.join(' '),/429/);
});

test('balance errors are actionable but provider bodies and keys never reach the error',async()=>{
 const adapter=setup(async()=>new Response('test-secret-do-not-log private payload',{status:402}));
 await assert.rejects(adapter.discover(project),e=>e.message.includes('balance')&&!e.message.includes('test-secret')&&!e.message.includes('private payload'));
});

test('disallowed explicit source URLs are rejected before a provider call',async()=>{
 let calls=0;const adapter=setup(async()=>{calls++;return json({});});
 await assert.rejects(adapter.fetchSource('https://evil.test/secret'));
 assert.equal(calls,0);
});

test('empty, malformed and oversized fetch results cannot become evidence',async()=>{
 for(const response of [json({title:'No content',content:''}),new Response('not json'),new Response('x',{headers:{'content-length':'2000001'}})]){
  await assert.rejects(setup(async()=>response).fetchSource(url));
 }
});

test('five-page budget and provider notices survive into the saved project coverage log',async()=>{
 let saved=0;const result=await collectResearch({...project,source_urls:Array.from({length:7},(_,i)=>url+'?n='+i)}, {
  now:()=>0,aiReady:false,maxSources:5,notices:['One search branch timed out.'],stage:async()=>{},
  fetchSource:async url=>({url,text:'Actual source text',published_at:null}),saveSource:async()=>String(++saved),finish:async()=>{}
 });
 assert.equal(saved,5);assert.equal(result.findings,0);assert.match(result.errors.join(' '),/processing 5 of 7/);assert.ok(result.errors.includes('One search branch timed out.'));
});

