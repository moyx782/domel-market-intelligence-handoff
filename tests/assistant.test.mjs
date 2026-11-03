import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fauxAssistantMessage, fauxProvider, fauxText, fauxThinking, fauxToolCall} from '@earendil-works/pi-ai';
import {ModelRuntime} from '@earendil-works/pi-coding-agent';
import {createAssistantRunner} from '../server/assistant.mjs';

const PROJECT='00000000-0000-4000-8000-000000000031';

function fakeReader({projects=[],sources=[],findings=[]}={}){
 return {
  project:async id=>projects.find(project=>project.id===id)??null,
  sources:async id=>sources.filter(source=>source.project_id===id).slice(0,50),
  findings:async id=>findings.filter(finding=>finding.project_id===id).slice(0,20),
 };
}

async function fauxRuntime(){
 const faux=fauxProvider();
 const runtime=await ModelRuntime.create({authPath:join(tmpdir(),'domel-test-auth.json'),modelsPath:null,refreshOnCreate:false});
 runtime.registerNativeProvider(faux.provider);
 await runtime.setRuntimeApiKey(faux.provider.id,'test').catch(()=>{});
 return {faux,runtime,model:faux.getModel()};
}

test('assistant answers through read-only tools and keeps a session file',async()=>{
 const root=mkdtempSync(join(tmpdir(),'domel-assistant-'));
 try{
  const reader=fakeReader({
   projects:[{id:PROJECT,title:'Edge AI',question:'Who ships?',segment:'Automotive',market:'Japan',quarter:'2026-Q3',competitors:['A'],focus:['Custom'],status:'partial',stage:'Collected',errors:[]}],
   sources:[{id:'s-1',project_id:PROJECT,title:'Roadmap',url:'https://example.com/roadmap',text:'Mass production starts in Q3 2026.',published_at:null,retrieved_at:'2026-10-01T00:00:00Z'}],
   findings:[{id:'f-1',project_id:PROJECT,competitor:'A',field:'Custom',original_text:'Ships in Q3.',quote:'Mass production starts in Q3 2026.',decision:'pending'}],
  });
  const {faux,runtime,model}=await fauxRuntime();
  faux.setResponses([
   fauxAssistantMessage([fauxThinking('Read the brief first.'),fauxToolCall('get_project',{})],{stopReason:'toolUse'}),
   fauxAssistantMessage([fauxToolCall('search_sources',{query:'Q3'})],{stopReason:'toolUse'}),
   fauxAssistantMessage([fauxText('Project Edge AI is partial; source s-1 says mass production starts in Q3 2026.')]),
  ]);
  const runner=createAssistantRunner({model,modelRuntime:runtime,sessionRoot:root,cwd:root});
  const events=[];
  const answer=await runner({reader,userId:'user-1',projectId:PROJECT,message:'Summarize this project.',onEvent:event=>events.push(event)});
  assert.match(answer,/s-1/);
  assert.deepEqual(events.filter(event=>event.type==='tool_start').map(event=>event.tool),['get_project','search_sources']);
  assert.ok(events.every(event=>event.type!=='tool_end'||event.ok===true));
  assert.equal(events.at(-1).type,'done');
  assert.ok(events.some(event=>event.type==='delta'));
  const {SessionManager}=await import('@earendil-works/pi-coding-agent');
  const sessions=await SessionManager.listAll(join(root,'user-1',PROJECT));
  assert.equal(sessions.length,1);
  assert.ok(sessions[0].messageCount>=4);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('assistant rejects projects the signed-in user cannot read',async()=>{
 const root=mkdtempSync(join(tmpdir(),'domel-assistant-'));
 try{
  const {runtime,model}=await fauxRuntime();
  const runner=createAssistantRunner({model,modelRuntime:runtime,sessionRoot:root,cwd:root});
  await assert.rejects(
   runner({reader:fakeReader(),userId:'user-1',projectId:PROJECT,message:'Summarize.',onEvent:()=>{}}),
   /Project not accessible/,
  );
 }finally{rmSync(root,{recursive:true,force:true});}
});
