import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openExhibitionStudies,createExhibitionHandler,createExhibitionAnalysisHandler,buildExhibitionPagePrompt} from '../server/exhibition-study.mjs';
import {exhibitionRoutes} from '../server/exhibition-api.mjs';
import {openLocalStore} from '../server/local-store.mjs';

function setup(){const root=mkdtempSync(join(tmpdir(),'exhibition-test-'));const file=join(root,'studies.json'),artifactRoot=join(root,'evidence');const studies=openExhibitionStudies({file,artifactRoot});const study=studies.create({name:'Appliance Exhibition',edition:'2027',urls:['https://example.com/event']});return {root,file,artifactRoot,studies,study};}
const context=(s,p=s.pages[0])=>({task:{payload:{studyId:s.id,pageId:p.id}},signal:new AbortController().signal,update:()=>{}});
function capture(studies,s,page=s.pages[0],text='Official exhibition dates: 2027-04-01 to 2027-04-03. Read the complete source before approving any conclusion.'){
 studies.start(s.id,page.id);return studies.recordCapture(s.id,page.id,{ok:true,url:page.url,finalUrl:page.url,text,html:'<main>'+text+'</main>',title:'Official source',engine:'http',fetchedAt:'2026-11-05T00:00:00Z'});
}
test('public entry validation is atomic; IP/local entries are rejected',()=>{
 const {studies}=setup(),before=studies.list().length;
 assert.throws(()=>studies.create({name:'X',edition:'2027',urls:['https://example.com','https://127.0.0.1/']}));assert.equal(studies.list().length,before);
});
test('capture preserves raw source, URL, date, hash, and only imports supported facts',()=>{
 const {studies,study}=setup();const e=capture(studies,study);
 const s=studies.importPage(study.id,study.pages[0].id,{facts:[{field:'dates',value:'2027-04-01',quote:'2027-04-01',edition:'2027'},{field:'price',value:'1000',quote:'Fabricated price not in the source'}],directoryComplete:true});
 assert.equal(s.facts.length,1);assert.equal(s.facts[0].decision,'pending');assert.ok(e.text.includes(s.facts[0].quote));assert.equal(s.facts[0].sourceUrl,e.url);assert.ok(s.gaps.length);assert.equal(studies.artifact(s.id,e.id).text,e.text);assert.equal(e.sha256.length,64);
});
test('all 20 exhibitors including downstream appliances are queued, with pagination and no five-page cap',async()=>{
 const {studies,study}=setup(),jobs=[];
 const companies=Array.from({length:20},(_,i)=>({name:'Appliance Maker '+i,profileUrl:'https://example.com/company/'+i,quote:'Appliance Maker '+i}));
 const text=companies.map(c=>c.name).join('\n')+'\nTotal exhibitors: 20';
 const handler=createExhibitionHandler({studies,collector:{collect:async()=>({ok:true,url:study.pages[0].url,text,html:'<a href="/directory?page=2">Next page</a>'})},getAgentRuntime:async()=>async()=>({text:JSON.stringify({companies,links:[{url:'/directory?page=2',stage:'directory',quote:'Next page'},{url:'https://invented.org/no-link',stage:'directory',quote:'Next page'}],expectedTotal:{value:20,edition:'2027',quote:'Total exhibitors: 20'},directoryComplete:true})}),getQueue:()=>({create:async j=>jobs.push(j)})});
 await handler(context(study));const s=studies.get(study.id);
 assert.equal(s.companies.length,20);assert.equal(s.knownExhibitorTotal,20);assert.equal(jobs.length,21);assert.equal(s.pages.length,22);assert.ok(s.pages.some(p=>p.url.endsWith('page=2')));assert.ok(!s.pages.some(p=>p.url.includes('invented.org')));assert.ok(s.companies.every(c=>c.relationship==='unclassified'));assert.equal(s.companies[0].evidence[0].edition,'unknown');
});
test('product lineage, parameters, price conditions and exact source passages survive restart',()=>{
 const {studies,study,file,artifactRoot}=setup();capture(studies,study);
 studies.importPage(study.id,study.pages[0].id,{companies:[{name:'Appliance Maker',profileUrl:'https://example.com/company',quote:'Official exhibition'}],directoryComplete:true});
 let s=studies.get(study.id),company=s.companies[0],page=s.pages.find(p=>p.stage==='company');
 capture(studies,s,page,'Appliance Maker manufactures vacuum cleaners. Model VC1 has 48 V input and rated 600 W output. Price is USD 120 per unit for quantity 100, excluding tax and shipping.');
 studies.importPage(s.id,page.id,{products:[{name:'Vacuum cleaner',model:'VC1',company:'Appliance Maker',url:'https://example.com/product/vc1',quote:'Model VC1 has 48 V input'}]});
 s=studies.get(s.id);page=s.pages.find(p=>p.stage==='product');
 capture(studies,s,page,'Model VC1 has 48 V input and rated 600 W output. Price is USD 120 per unit for quantity 100, excluding tax and shipping.');
 studies.importPage(s.id,page.id,{facts:[{field:'voltage',value:'48',unit:'V',conditions:'rated input',quote:'48 V input'},{field:'price',value:'120',currency:'USD',priceBasis:'100 units, excluding tax and shipping',quote:'USD 120 per unit for quantity 100, excluding tax and shipping'}]});
 const restored=openExhibitionStudies({file,artifactRoot}).get(s.id);assert.equal(restored.products[0].companyId,company.id);assert.equal(restored.products[0].exhibitionStatus,'company_product_not_confirmed_at_this_edition');assert.equal(restored.facts.length,2);assert.equal(restored.facts[1].priceBasis,'100 units, excluding tax and shipping');assert.equal(restored.facts[0].subjectId,restored.products[0].id);
});
test('original screenshot/file bytes can be retrieved with provenance',()=>{
 const {studies,study}=setup();const bytes=Buffer.from('fixture image bytes');
 const e=studies.recordCapture(study.id,study.pages[0].id,{url:study.pages[0].url,text:'Actual readable screenshot OCR text.',engine:'ocr-browser',artifact:{buffer:bytes,mime:'image/png'}});
 const a=studies.artifact(study.id,e.id);assert.equal(a.binary.mime,'image/png');assert.equal(Buffer.from(a.binary.base64,'base64').toString(),bytes.toString());assert.equal(a.binary.sha256.length,64);assert.equal(a.requestedUrl,study.pages[0].url);
});
test('raw unparsed documents are retained as gaps without inventing extracted facts',async()=>{
 const {studies,study}=setup();let calls=0;
 const handler=createExhibitionHandler({studies,collector:{collect:async()=>({ok:true,url:study.pages[0].url,text:'',engine:'document-unparsed',artifact:{buffer:Buffer.from('%PDF fixture'),mime:'application/pdf'}})},getAgentRuntime:async()=>{calls++;},getQueue:()=>({})});
 await handler(context(study));const s=studies.get(study.id);assert.equal(calls,0);assert.equal(s.evidence.length,1);assert.equal(s.facts.length,0);assert.ok(s.gaps.some(g=>g.message.includes('OCR')));assert.equal(s.coverage.status,'partial');
});
test('failed collection is persisted for retry and never marked complete',async()=>{
 const {studies,study}=setup();const handler=createExhibitionHandler({studies,collector:{collect:async()=>({ok:false,error:{message:'HTTP 403'}})},getAgentRuntime:async()=>{},getQueue:()=>({})});
 await assert.rejects(handler(context(study)),/403/);const s=studies.get(study.id);assert.equal(s.coverage.failed,1);assert.equal(s.coverage.status,'partial');assert.match(s.pages[0].error,/403/);
});
test('long sources are fully segmented within Agent input limits and archived intact',async()=>{
 const {studies,study}=setup();const text=('Long source text containing a company catalogue and parameter descriptions. ').repeat(190);let calls=0;
 const handler=createExhibitionHandler({studies,collector:{collect:async()=>({ok:true,url:study.pages[0].url,text,html:''})},getAgentRuntime:async()=>async({message})=>{calls++;assert.ok(message.length<=12000);return {text:JSON.stringify({directoryComplete:true})};},getQueue:()=>({create:async()=>{}})});
 await handler(context(study));assert.ok(calls>=3);const s=studies.get(study.id);assert.equal(studies.artifact(s.id,s.evidence[0].id).text,text);
});
test('screening is blocked before collection and unsupported supply classifications stay unclassified',async()=>{
 const {studies,study}=setup();capture(studies,study);studies.importPage(study.id,study.pages[0].id,{companies:[{name:'Appliance Maker',profileUrl:'https://example.com/maker',quote:'Official exhibition'}],directoryComplete:true});
 let s=studies.get(study.id),c=s.companies[0];assert.throws(()=>studies.classify(s.id,c.id,{relationship:'potential_customer',factIds:[]}),/finish/);
 const p=s.pages.find(p=>p.stage==='company');capture(studies,s,p,'Appliance Maker manufactures vacuum cleaners with electric motors. This is a public product application description.');
 studies.importPage(s.id,p.id,{facts:[{field:'application',value:'vacuum cleaners',quote:'manufactures vacuum cleaners with electric motors'}]});
 s=studies.get(s.id);studies.classify(s.id,c.id,{relationship:'actual_customer',reason:'Not proven',factIds:s.facts.map(f=>f.id)});assert.equal(studies.get(s.id).companies[0].relationship,'unclassified');
 const handler=createExhibitionAnalysisHandler({studies,getAgentRuntime:async()=>async()=>({text:JSON.stringify({relationship:'potential_customer',reason:'Potential application fit, not a confirmed supplier relationship.',factIds:s.facts.map(f=>f.id)})})});
 await handler({task:{payload:{studyId:s.id}},signal:new AbortController().signal});assert.equal(studies.get(s.id).companies[0].relationship,'potential_customer');assert.equal(studies.get(s.id).facts.length,s.facts.length);
});
test('API role checks, capture-first guard, explicit partial acceptance and pending review import',async()=>{
 const {root,studies,study}=setup(),store=openLocalStore(join(root,'projects.json')),jobs=[];
 async function route(path,method='GET',body={},permit=true){let response;await exhibitionRoutes({path,method,body,studies,queue:{create:async j=>{jobs.push(j);return j;}},store,allowed:()=>permit,send:(status,data)=>{response={status,data};}});return response;}
 const base='/api/v1/exhibition-studies/'+study.id;
 assert.equal((await route(base,'GET',{},false)).status,403);assert.equal((await route(base+'/publish','POST',{acceptPartial:true})).status,409);
 capture(studies,study);studies.importPage(study.id,study.pages[0].id,{facts:[{field:'dates',value:'2027-04-01',quote:'Official exhibition dates: 2027-04-01 to 2027-04-03.'}],directoryComplete:true});
 assert.equal((await route(base+'/analyse','POST')).status,409);assert.equal((await route(base+'/analyse','POST',{acceptPartial:true})).status,202);
 const r=await route(base+'/publish','POST',{acceptPartial:true});assert.equal(r.status,201);assert.equal(r.data.findings,1);
 const workspace=await store.bundle();assert.equal(workspace.findings[0].decision,'pending');assert.equal(workspace.reports.length,0);
 assert.equal((await route(base+'/publish','POST',{acceptPartial:true})).data.projectId,r.data.projectId);
});

test('paused studies retain captured evidence and stop further handler calls until resumed',async()=>{
 const {studies,study}=setup();capture(studies,study);studies.importPage(study.id,study.pages[0].id,{directoryComplete:true});
 const next=studies.add(study.id,'https://example.com/next','directory');studies.pause(study.id,true);let collected=false;
 const handler=createExhibitionHandler({studies,collector:{collect:async()=>{collected=true;}},getAgentRuntime:async()=>{},getQueue:()=>({})});
 await assert.rejects(handler(context(studies.get(study.id),next)),/paused/);assert.equal(collected,false);assert.equal(studies.get(study.id).evidence.length,1);assert.equal(studies.get(study.id).coverage.failed,1);studies.pause(study.id,false);assert.equal(studies.get(study.id).paused,false);
});
test('retryable pages remain pending during queue backoff and fail only after attempts are exhausted',async()=>{
 const {studies,study}=setup();const handler=createExhibitionHandler({studies,collector:{collect:async()=>({ok:false,error:{message:'Network timeout'}})},getAgentRuntime:async()=>{},getQueue:()=>({})});
 const ctx=context(study);ctx.task.attempts=1;ctx.task.maxAttempts=3;await assert.rejects(handler(ctx),/timeout/);assert.equal(studies.get(study.id).coverage.pending,1);
 ctx.task.attempts=3;await assert.rejects(handler(ctx),/timeout/);assert.equal(studies.get(study.id).coverage.failed,1);
});
