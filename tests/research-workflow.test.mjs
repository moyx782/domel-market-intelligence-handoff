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
import {extractSavedResearch,validateSavedExtraction} from '../supabase/functions/_shared/research-workflow.mjs';

test('saved-source extraction preserves provenance and never retrieves or reinserts sources',async()=>{
 const saved=[{id:'saved-1',project_id:'p',url:'https://example.com/news',text:'Previously retrieved source text',retrieved_at:'2026-10-20T00:00:00Z',published_at:'2026-08-01'}];
 const stages=[];
 const h=harness({aiReady:true,stage:async s=>stages.push(s),discover:async()=>{throw Error('Must not search');},fetchSource:async()=>{throw Error('Must not fetch');},saveSource:async()=>{throw Error('Must not insert');},extract:async(p,s)=>{assert.equal(s.id,'saved-1');assert.equal(s.retrieved_at,'2026-10-20T00:00:00Z');return [{text:'Candidate'}];}});
 const r=await extractSavedResearch({id:'p',source_urls:[],errors:['Source collection only. AI extraction has not run; old status.']},saved,h.io);
 assert.equal(r.findings,1);assert.equal(r.status,'completed');assert.equal(h.batches[0].id,'saved-1');assert.equal(h.saved.length,0);assert.match(stages[0],/Reading saved source/);assert.equal(h.results.length,1);
});
test('saved-source extraction keeps previous coverage failures and handles provider failure honestly',async()=>{
 const saved=[{id:'s',project_id:'p',url:'https://example.com',text:'Saved text',published_at:null}];
 const h=harness({aiReady:true,extract:async()=>{throw Error('HTTP 402');}});
 const r=await extractSavedResearch({id:'p',errors:['One original URL failed']},saved,h.io);
 assert.equal(r.status,'partial');assert.equal(r.sources,1);assert.equal(r.findings,0);assert.match(r.errors.join(' '),/Prior collection notice: One original URL failed/);assert.match(r.errors.join(' '),/HTTP 402/);assert.equal(h.batches.length,0);
});
test('resume rules reject running projects, missing sources, cross-project sources and existing findings',()=>{
 const p={id:'p',status:'partial'},sources=[{id:'s',project_id:'p'}];
 assert.doesNotThrow(()=>validateSavedExtraction(p,sources,[]));
 assert.throws(()=>validateSavedExtraction({...p,status:'running'},sources,[]),/Finish source collection/);
 assert.throws(()=>validateSavedExtraction(p,[],[]),/No saved sources/);
 assert.throws(()=>validateSavedExtraction(p,[{project_id:'other'}],[]),/does not belong/);
 assert.throws(()=>validateSavedExtraction(p,sources,[{id:'existing'}]),/already has candidate/);
});
