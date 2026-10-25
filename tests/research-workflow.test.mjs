import test from 'node:test';
import assert from 'node:assert/strict';
import {collectResearch} from '../supabase/functions/_shared/research-workflow.mjs';
const p={source_urls:['https://example.com/news']};
function harness(patch={}) {
 const saved=[],batches=[],results=[];
 const io={now:()=>0,aiReady:false,stage:async()=>{},discover:async()=>{throw Error('Search is not configured. Enter source URLs.');},fetchSource:async url=>({url,text:'Real fetched text',published_at:null}),saveSource:async s=>{saved.push(s);return 'source-1';},extract:async()=>{throw Error('AI must not run');},saveFindings:async(id,fs)=>batches.push({id,fs}),finish:async r=>results.push(r),...patch};
 return {io,saved,batches,results};
}
test('without AI, real source text is saved and no candidates are fabricated',async()=>{
 const h=harness();const r=await collectResearch(p,h.io);
 assert.equal(r.status,'partial');assert.equal(h.saved.length,1);assert.equal(h.saved[0].text,'Real fetched text');assert.equal(r.findings,0);assert.equal(h.batches.length,0);assert.match(r.errors.join(' '),/AI extraction has not run/);assert.match(r.errors.join(' '),/Quarter relevance/);
});
test('one failed page does not discard another successfully stored source',async()=>{
 const h=harness({fetchSource:async url=>{if(url.endsWith('/bad'))throw Error('HTTP 404');return {url,published_at:'2026-08-01'};}});
 const r=await collectResearch({source_urls:['https://example.com/bad',...p.source_urls,...p.source_urls]},h.io);
 assert.equal(r.sources,1);assert.equal(h.saved.length,1);assert.match(r.errors.join(' '),/HTTP 404/);
});
test('missing search and AI config fail honestly before making up sources',async()=>{
 const h=harness();assert.equal((await collectResearch({source_urls:[]},h.io)).status,'failed');
 const r=await collectResearch(p,h.io,true);assert.equal(r.sources,0);assert.equal(r.status,'failed');assert.match(r.errors[0],/awaiting API/);
});
test('AI extraction failure preserves source but cannot claim completed research',async()=>{
 const h=harness({aiReady:true,extract:async()=>{throw Error('Provider unavailable');}});
 const r=await collectResearch(p,h.io,true);assert.equal(r.sources,1);assert.equal(r.findings,0);assert.equal(r.status,'partial');assert.match(r.errors.join(' '),/Provider unavailable/);
});
test('validated AI results reference their saved source and finish once',async()=>{
 const f={text:'Validated finding'};const h=harness({aiReady:true,fetchSource:async url=>({url,published_at:'2026-08-01'}),extract:async()=>[f]});
 const r=await collectResearch(p,h.io,true);assert.equal(r.status,'completed');assert.deepEqual(h.batches,[{id:'source-1',fs:[f]}]);assert.equal(h.results.length,1);
});
test('execution budget stops further retrieval and records incomplete coverage',async()=>{
 let time=0;const h=harness({now:()=>time,fetchSource:async url=>{time=90000;return {url,published_at:null};}});
 const r=await collectResearch({source_urls:[...p.source_urls,'https://example.com/second']},h.io);assert.equal(r.sources,1);assert.match(r.errors.join(' '),/Execution time limit/);
});
