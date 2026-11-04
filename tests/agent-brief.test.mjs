import test from 'node:test';
import assert from 'node:assert/strict';
import {agentBriefProject} from '../src/agent-brief.mjs';
import {validateScope} from '../supabase/functions/_shared/research-validation.mjs';
import {buildAgentResearchPrompt,validateAgentResult} from '../server/agent-research.mjs';
test('free brief preserves user requirements and the evidence review contract',()=>{
 const p=agentBriefProject(' China HVAC exhibitions ','Find dates in 2027 and official sources.',new Date('2026-11-04T12:00:00Z'));
 validateScope(p);assert.equal(p.title,'China HVAC exhibitions');assert.match(p.question,/2027/);assert.deepEqual(p.source_urls,[]);
 assert.match(buildAgentResearchPrompt({project:p,apiBase:'http://localhost',workspace:'/tmp'}),/NOT a research date restriction/);
 const quote='Official exhibition information with publicly documented dates.';
 const r=validateAgentResult({sources:[{url:'https://example.com/events',text:quote}],findings:[{competitor:'Research subject',field:'Research findings',text:'Candidate for review.',quote,source_url:'https://example.com/events'}]},p,{});
 assert.equal(r.findings,1);
});
test('empty and oversized briefs are rejected',()=>{
 for(const [d,q] of [[' ','Q'],['D',' '],['x'.repeat(121),'Q'],['D','x'.repeat(1501)]])assert.throws(()=>agentBriefProject(d,q));
});
