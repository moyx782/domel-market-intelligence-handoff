import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openLocalStore} from '../server/local-store.mjs';

const scope={title:'Edge AI',question:'Who ships?',segment:'Automotive',market:'Japan',quarter:'2026-Q3',competitors:['A','B'],focus:['Custom','Technology'],source_urls:['https://example.com/a']};

function source(finding='Mass production starts in Q3 2026.'){
 return {id:'s-1',url:'https://example.com/a',title:'Roadmap',published_at:null,retrieved_at:new Date().toISOString(),text:finding,findings:[{competitor:'A',field:'Custom',text:'Ships in Q3.',quote:finding}]};
}

async function seeded(dir,file='data.json'){
 const store=openLocalStore(join(dir,file));
 const project=await store.createProject(scope);
 const job=await store.enqueue(project.id,'research');
 await store.startJob(job.id);
 await store.completeJob(job.id,{status:'partial',stage:'Ready for evidence review',errors:['Publication date unknown.'],sources:1,findings:1},[source()]);
 return {store,project};
}

test('local store completes collection, review and report',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'domel-local-'));
 try{
  const {store,project}=await seeded(dir);
  let bundle=await store.bundle();
  assert.equal(bundle.projects.length,1);
  assert.equal(bundle.sources.length,1);
  assert.equal(bundle.findings[0].decision,'pending');
  assert.equal(bundle.projects[0].status,'partial');
  assert.equal((await store.jobs())[0].state,'succeeded');

  const finding=bundle.findings[0];
  await assert.rejects(store.generateReport(project.id),/Accept at least one/);
  const accepted=await store.review(finding.id,finding.edited_text,'accepted',finding.revision);
  assert.equal(accepted.decision,'accepted');
  assert.equal(accepted.revision,2);
  assert.equal(accepted.reviewer_id,'local-user');
  await assert.rejects(store.review(finding.id,'Different','accepted',finding.revision),/changed/);

  const report=await store.generateReport(project.id);
  assert.equal(report.version,1);
  assert.equal(report.snapshot.findings.length,1);
  assert.equal(report.snapshot.sources.length,1);
  assert.match(report.snapshot.limitations[1],/Publication date/);

  bundle=await store.bundle();
  assert.equal(bundle.audits.length,1);
  assert.equal(bundle.audits[0].action,'accepted');
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('local store rejects extraction before sources exist and after findings exist',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'domel-local-'));
 try{
  const store=openLocalStore(join(dir,'a.json'));
  const project=await store.createProject(scope);
  await assert.rejects(store.enqueue(project.id,'extract'),/Saved extraction is unavailable/);
  const {store:seededStore,project:seededProject}=await seeded(dir,'b.json');
  await assert.rejects(seededStore.enqueue(seededProject.id,'extract'),/Saved extraction is unavailable/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
