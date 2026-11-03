import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openLocalStore} from '../server/local-store.mjs';
import {localApiServer} from '../server/local-api.mjs';

const scope={title:'Edge AI',question:'Who ships?',segment:'Automotive',market:'Japan',quarter:'2026-Q3',competitors:['A'],focus:['Custom'],source_urls:['https://example.com/a']};

async function seed(dir){
 const store=openLocalStore(join(dir,'data.json'));
 const project=await store.createProject(scope);
 const job=await store.enqueue(project.id,'research');
 await store.startJob(job.id);
 await store.completeJob(job.id,{status:'partial',stage:'Ready for evidence review',errors:[],sources:1,findings:1},[{
  id:'s-1',url:'https://example.com/a',title:'Roadmap',published_at:null,retrieved_at:new Date().toISOString(),
  text:'Mass production starts in Q3 2026.',findings:[{competitor:'A',field:'Custom',text:'Ships in Q3.',quote:'Mass production starts in Q3 2026.'}],
 }]);
 return {store,project};
}

async function listen(options){
 const server=localApiServer(options);
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 return {server,url:'http://127.0.0.1:'+server.address().port};
}

test('local API serves workspace, validates scope and refuses research without a key',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'domel-api-'));
 const {store,project}=await seed(dir);
 const {server,url}=await listen({store,env:{}});
 try{
  const workspace=await (await fetch(url+'/api/v1/workspace')).json();
  assert.equal(workspace.projects.length,1);
  assert.equal(workspace.findings.length,1);
  const invalid=await fetch(url+'/api/v1/research-tasks',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...scope,focus:[]})});
  assert.equal(invalid.status,400);
  const created=await fetch(url+'/api/v1/research-tasks',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(scope)});
  assert.equal(created.status,201);
  const run=await fetch(url+'/api/v1/research-tasks/'+project.id+'/run',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mode:'collect'})});
  assert.equal(run.status,409);
  assert.match((await run.json()).error,/DEEPSEEK_API_KEY/);
  const capabilities=await (await fetch(url+'/api/v1/capabilities')).json();
  assert.equal(capabilities.ai,false);
  assert.equal(capabilities.assistant,false);
  const jobs=await (await fetch(url+'/api/v1/research-jobs')).json();
  assert.equal(jobs[0].state,'succeeded');
 }finally{
  await new Promise(resolve=>server.close(resolve));
  rmSync(dir,{recursive:true,force:true});
 }
});

test('local API reviews a finding and generates an approved-only report',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'domel-api-'));
 const {store,project}=await seed(dir);
 const {server,url}=await listen({store,env:{}});
 try{
  const workspace=await (await fetch(url+'/api/v1/workspace')).json();
  const finding=workspace.findings[0];
  const review=await fetch(url+'/api/v1/insights/'+finding.id+'/review',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:finding.edited_text,decision:'accepted',revision:finding.revision})});
  assert.equal(review.status,200);
  assert.equal((await review.json()).decision,'accepted');
  const report=await fetch(url+'/api/v1/reports',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({project_id:project.id})});
  assert.equal(report.status,201);
  const body=await report.json();
  assert.equal(body.version,1);
  assert.equal(body.snapshot.findings.length,1);
  const stale=await fetch(url+'/api/v1/insights/'+finding.id+'/review',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:finding.edited_text,decision:'rejected',revision:finding.revision})});
  assert.equal(stale.status,409);
 }finally{
  await new Promise(resolve=>server.close(resolve));
  rmSync(dir,{recursive:true,force:true});
 }
});

test('local API streams the assistant when configured and rejects it otherwise',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'domel-api-'));
 const {store,project}=await seed(dir);
 const assistant=async({projectId,onEvent})=>{
  onEvent({type:'tool_start',tool:'get_project'});
  onEvent({type:'delta',text:'Project '+projectId.slice(0,4)});
  onEvent({type:'done',text:'ok'});
 };
 const {server,url}=await listen({store,assistant,env:{}});
 const plain=await listen({store,env:{}});
 try{
  const response=await fetch(url+'/api/v1/research-tasks/'+project.id+'/assistant',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:'Summarize.'})});
  assert.equal(response.status,200);
  const events=(await response.text()).trim().split('\n\n').map(chunk=>JSON.parse(chunk.replace(/^data: /,'')));
  assert.deepEqual(events.map(event=>event.type),['tool_start','delta','done']);
  const unavailable=await fetch(plain.url+'/api/v1/research-tasks/'+project.id+'/assistant',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:'Summarize.'})});
  assert.equal(unavailable.status,503);
 }finally{
  await new Promise(resolve=>server.close(resolve));
  await new Promise(resolve=>plain.server.close(resolve));
  rmSync(dir,{recursive:true,force:true});
 }
});
