import test from 'node:test';
import assert from 'node:assert/strict';
import {extractionConfig,extractCandidates} from '../supabase/functions/_shared/ai-extraction.mjs';
import {validateFindings} from '../supabase/functions/_shared/research-validation.mjs';
const config=extractionConfig(k=>({DEEPSEEK_API_KEY:'test-only-key'}[k]));
const source={text:'This is an exact supporting passage with enough characters for validation.',published_at:null};
const project={competitors:['A'],focus:['Custom focus']};
const finding={competitor:'A',field:'Custom focus',text:'Background information; quarter relevance requires verification.',quote:source.text};
const response=(content,finish_reason='stop')=>new Response(JSON.stringify({choices:[{message:{content},finish_reason}]}));
test('DeepSeek key configures extraction; partial custom config never silently falls back',()=>{
 assert.equal(config.model,'deepseek-flash');assert.equal(config.deepseek,true);
 assert.equal(extractionConfig(k=>({AI_MODEL:'custom',DEEPSEEK_API_KEY:'test'}[k])),null);
 assert.equal(extractionConfig(()=>undefined),null);
});
test('provider result requires exact quotation and user supplied focus',async()=>{
 let request;
 const result=await extractCandidates(project,source,config,validateFindings,async(url,init)=>{request={url,...init};return response(JSON.stringify({findings:[finding]}));});
 assert.equal(result.length,1);assert.equal(request.url,'https://api.deepseek.com/chat/completions');assert.equal(request.redirect,'error');
 const body=JSON.parse(request.body);assert.equal(body.thinking.type,'disabled');assert.equal(body.response_format.type,'json_object');
 await assert.rejects(extractCandidates(project,source,config,validateFindings,async()=>response(JSON.stringify({findings:[{...finding,quote:'Invented quotation that is not present in the source.'}]}))),/evidence failed/);
});
test('provider failures, truncated output and invalid JSON cannot create findings or leak keys',async()=>{
 for(const status of [401,402,429])await assert.rejects(extractCandidates(project,source,config,validateFindings,async()=>new Response('test-only-key',{status})),e=>e.message.includes('HTTP '+status)&&!e.message.includes('test-only-key'));
 for(const output of [response('invalid'),response('{"findings":[]}','length')])await assert.rejects(extractCandidates(project,source,config,validateFindings,async()=>output),/invalid JSON/);
});
test('credentials never follow redirects and insecure endpoints are rejected before I/O',async()=>{
 let called=false;await assert.rejects(extractCandidates(project,source,{...config,baseUrl:'http://example.com'},validateFindings,async()=>{called=true;}),/HTTPS/);assert.equal(called,false);
});
