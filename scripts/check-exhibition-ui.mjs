// Browser contract test with intercepted APIs. No paid model/provider calls.
// Start Vite on 5193 (or set EXHIBITION_UI_BASE) before running this script.
import {chromium} from 'playwright-core';
import {existsSync} from 'node:fs';
import assert from 'node:assert/strict';
const executablePath=process.env.CHROME_PATH||['C:/Program Files/Google/Chrome/Application/chrome.exe','/usr/bin/google-chrome'].find(existsSync);
const browser=await chromium.launch({executablePath,headless:true});
const id='11111111-1111-4111-8111-111111111111';
let study=null;
try{
 const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/api/v1/**',async route=>{
  const req=route.request(),path=new URL(req.url()).pathname;let data={};let status=200;
  if(path.endsWith('/workspace'))data={projects:[],sources:[],findings:[],audits:[],reports:[]};
  else if(path.endsWith('/capabilities'))data={version:'fixture',agent_role:'admin',ai:true,search:true,allowed_domains:[],max_sources:5};
  else if(path.endsWith('/exhibition-studies')&&req.method()==='POST'){
   const body=req.postDataJSON();assert.equal(body.name,'Appliance Expo');assert.ok(body.urls[0].startsWith('https://'));
   study={id,name:body.name,edition:body.edition,companies:[],products:[],facts:[],evidence:[],gaps:[],pages:[],knownExhibitorTotal:null,coverage:{status:'collecting',discoveredPages:1,captured:0,pending:1,failed:0,missingCompanies:null}};data=study;status=201;
  }else if(path.endsWith('/exhibition-studies'))data={studies:study?[study]:[]};
  else if(path.endsWith('/exhibition-studies/'+id))data=study;
  else if(path.includes('/evidence/'))data={finalUrl:'https://example.com/exhibitors',method:'fixture-http',capturedAt:'2026-11-05',text:'Appliance Maker manufactures vacuum cleaners.',html:'<article>Public directory</article>'};
  else if(/events|tasks|sources|sessions/.test(path))data=[];
  await route.fulfill({status,contentType:'application/json',headers:{'Access-Control-Allow-Origin':'*'},body:JSON.stringify(data)});
 });
 await page.goto(process.env.EXHIBITION_UI_BASE||'http://127.0.0.1:5193/');
 await page.getByRole('button',{name:/^(Exhibition capture|展会全量研究)$/}).click();
 await page.getByLabel('展会名称 / Exhibition').fill('Appliance Expo');await page.getByLabel('届次 / Edition').fill('2027');await page.getByLabel('公开入口网址 / Entry URLs').fill('https://example.com/exhibitors');
 await page.getByRole('button',{name:'开始采集全部公开条目 / Collect first'}).click();
 const filter=page.getByRole('textbox',{name:'采集后筛选企业'});await filter.waitFor();assert.equal(await filter.isDisabled(),true);
 study.coverage={status:'frontier_exhausted',discoveredPages:1,captured:1,pending:0,failed:0,missingCompanies:0};study.knownExhibitorTotal=1;
 study.evidence=[{id,title:'Official exhibitor directory',url:'https://example.com/exhibitors',sha256:'fixture-sha',method:'fixture-http',capturedAt:'2026-11-05'}];
 study.companies=[{id,name:'Appliance Maker',relationship:'unclassified',evidence:[{evidenceId:id,quote:'Appliance Maker'}]}];
 await page.waitForFunction(()=>!document.querySelector('input[aria-label="采集后筛选企业"]')?.disabled);
 await page.getByText('Appliance Maker',{exact:true}).waitFor();
 await page.getByRole('button',{name:'查看原文、HTML、文件或截图'}).click();await page.getByText('Appliance Maker manufactures vacuum cleaners.',{exact:true}).waitFor();
 assert.equal(await page.getByRole('link',{name:'原始页面',exact:true}).getAttribute('href'),'https://example.com/exhibitors');assert.deepEqual(errors,[]);
 console.log('PASS: creates capture study; filtering blocked until settled; downstream exhibitor retained; evidence snapshot and original URL visible; no page errors. Intercepted APIs only.');
}finally{await browser.close();}
