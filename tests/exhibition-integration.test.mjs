import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openExhibitionStudies,createExhibitionHandler,createExhibitionAnalysisHandler} from '../server/exhibition-study.mjs';
import {openLocalStore} from '../server/local-store.mjs';
import {openTaskQueue} from '../server/task-queue.mjs';
import {localApiServer} from '../server/local-api.mjs';

test('HTTP API and durable queue traverse all exhibitors to products then human review/report without live model calls',async()=>{
 const root=mkdtempSync(join(tmpdir(),'exhibition-integration-'));
 const studies=openExhibitionStudies({file:join(root,'studies.json'),artifactRoot:join(root,'artifacts')});
 const store=openLocalStore(join(root,'projects.json'));
 const pages={
  'https://example.com/event':{text:'Official 2027 exhibit list includes Appliance Maker and Motor Competitor. Total exhibitors: 2.',result:{companies:[{name:'Appliance Maker',profileUrl:'/appliance',quote:'Appliance Maker'},{name:'Motor Competitor',profileUrl:'/competitor',quote:'Motor Competitor'}],expectedTotal:{value:2,edition:'2027',quote:'Total exhibitors: 2'},directoryComplete:true}},
  'https://example.com/appliance':{text:'Appliance Maker manufactures vacuum cleaners. Its model VC1 is detailed in the public product catalogue.',result:{products:[{name:'Vacuum cleaner',model:'VC1',company:'Appliance Maker',url:'/vc1',quote:'model VC1 is detailed in the public product catalogue'}],facts:[{field:'application',value:'vacuum cleaners',quote:'manufactures vacuum cleaners'}]}},
  'https://example.com/competitor':{text:'Motor Competitor offers electric motors and published model M1 for industrial applications.',result:{products:[{name:'Electric motor',model:'M1',company:'Motor Competitor',url:'/m1',quote:'published model M1 for industrial applications'}]}},
  'https://example.com/vc1':{text:'Model VC1 rated power is 600 W at 48 V. Public list price is USD 120 for 100 units excluding tax and shipping.',result:{facts:[{field:'rated power',value:'600',unit:'W',conditions:'48 V',quote:'Model VC1 rated power is 600 W at 48 V.'},{field:'price',value:'120',currency:'USD',priceBasis:'100 units excluding tax and shipping',quote:'Public list price is USD 120 for 100 units excluding tax and shipping.'}]}},
  'https://example.com/m1':{text:'Motor model M1 rated voltage is 230 V. The manufacturer requires a quotation for pricing.',result:{facts:[{field:'rated voltage',value:'230',unit:'V',quote:'Motor model M1 rated voltage is 230 V.'},{field:'price availability',value:'needs quotation',quote:'The manufacturer requires a quotation for pricing.'}]}},
 };
 const collector={collect:async url=>{const p=pages[url];assert.ok(p,'Unexpected crawl URL: '+url);return {ok:true,url,finalUrl:url,title:url,text:p.text,html:'<article>'+p.text+'</article>',engine:'fixture-http'};}};
 const getAgentRuntime=async()=>async({message})=>{const url=/URL: (https:\/\/[^\s]+)\./.exec(message)?.[1];if(!url)throw Error('Missing source URL');return {text:JSON.stringify(pages[url].result)};};
 let queue;
 const handler=createExhibitionHandler({studies,collector,getAgentRuntime,getQueue:()=>queue});
 queue=openTaskQueue({file:join(root,'tasks.json'),handlers:{'exhibition.capture':handler,'exhibition.analyse':createExhibitionAnalysisHandler({studies,getAgentRuntime})},retryDelaysMs:[5]});
 const server=localApiServer({store,tasks:{exhibitionStudies:studies,queue},env:{}});await new Promise(r=>server.listen(0,'127.0.0.1',r));queue.start();
 const base='http://127.0.0.1:'+server.address().port;
 const request=async(path,body)=>{const r=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:r.status,data:await r.json()};};
 try{
  const created=await request('/api/v1/exhibition-studies',{name:'Appliance Exhibition',edition:'2027',urls:['https://example.com/event']});assert.equal(created.status,201);
  await queue.idle({timeoutMs:10000});
  const study=studies.get(created.data.id);assert.equal(study.companies.length,2);assert.equal(study.products.length,2);assert.equal(study.evidence.length,5);assert.equal(study.coverage.pending,0);assert.equal(study.coverage.missingCompanies,0);
  assert.ok(study.companies.some(c=>c.name==='Appliance Maker'));assert.ok(study.products.every(p=>p.exhibitionStatus==='company_product_not_confirmed_at_this_edition'));
  const response=await request('/api/v1/exhibition-studies/'+study.id+'/publish',{acceptPartial:true});assert.equal(response.status,201);assert.ok(response.data.findings>=4);
  let bundle=await store.bundle();assert.ok(bundle.findings.every(f=>f.decision==='pending'));assert.equal(bundle.reports.length,0);
  const first=bundle.findings[0];await store.review(first.id,first.edited_text,'accepted',first.revision);
  const report=await store.generateReport(response.data.projectId);assert.equal(report.snapshot.findings.length,1);
  const exported=await request('/api/v1/exhibition-studies/'+study.id+'/export');assert.equal(exported.data.companies.length,2);assert.ok(exported.data.facts.every(f=>f.sourceUrl&&f.evidenceId));
  const proof=await request('/api/v1/exhibition-studies/'+study.id+'/evidence/'+study.evidence[0].id);assert.ok(proof.data.text.includes('Total exhibitors: 2'));assert.equal(proof.data.finalUrl,'https://example.com/event');
 }finally{queue.stop();await new Promise(r=>server.close(r));}
});
