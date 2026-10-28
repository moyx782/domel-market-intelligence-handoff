import {sourcePolicy,publicSourceUrl,publicAddress} from '../_shared/source-policy.mjs';
import {extractionConfig,extractCandidates} from '../_shared/ai-extraction.mjs';
import {collectResearch,extractSavedResearch,validateSavedExtraction} from '../_shared/research-workflow.mjs';
import {createDeepSeekSources} from '../_shared/deepseek-search.mjs';
import {validateScope,validateFindings} from '../_shared/research-validation.mjs';
import {createClient} from 'npm:@supabase/supabase-js@2.117.3';
import {DOMParser} from 'npm:linkedom@0.18.12';
const headers={'Access-Control-Allow-Origin':Deno.env.get('APP_ORIGIN')||'http://127.0.0.1:5175','Access-Control-Allow-Headers':'authorization, apikey, content-type, x-client-info','Access-Control-Allow-Methods':'POST, OPTIONS','Content-Type':'application/json'};
const response=(data:unknown,status=200,cors=headers)=>new Response(JSON.stringify(data),{status,headers:cors});
const admin=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,{auth:{persistSession:false}});
const env=(name:string)=>{const v=Deno.env.get(name);if(!v)throw Error('Server configuration missing: '+name);return v;};
const policy=()=>sourcePolicy((name:string)=>Deno.env.get(name));
const domains=()=>policy().restrictedDomains;
function eligible(raw:string){return new URL(publicSourceUrl(raw,domains()));}
async function checkPublicDns(url:URL){
 const records=await Promise.allSettled([Deno.resolveDns(url.hostname,'A'),Deno.resolveDns(url.hostname,'AAAA')]);
 const addresses=records.flatMap(r=>r.status==='fulfilled'?r.value:[]);
 if(!addresses.length||addresses.some(ip=>!publicAddress(ip)))throw Error('Source DNS must resolve only to public addresses.');
}
async function db<T>(promise:PromiseLike<{data:T;error:unknown}>){const {data,error}=await promise;if(error)throw error;return data;}
async function fetchText(raw:string){
 let url=eligible(raw);let res:Response|undefined;
 for(let i=0;i<4;i++){await checkPublicDns(url);res=await fetch(url,{redirect:'manual',signal:AbortSignal.timeout(12000),headers:{'User-Agent':'DomelResearchMVP/0.1'}});if(res.status>=300&&res.status<400){const dest=res.headers.get('location');if(!dest)throw Error('Redirect missing destination');url=eligible(new URL(dest,url).href);continue;}break;}
 if(!res||!res.ok)throw Error('Source HTTP '+res?.status);
 if(!(res.headers.get('content-type')||'').includes('text/html'))throw Error('Only HTML text pages are supported; PDF/OCR are outside this MVP.');
 if(Number(res.headers.get('content-length')||0)>2000000)throw Error('Page exceeds 2 MB limit.');
 const reader=res.body!.getReader();let bytes=0;const chunks:Uint8Array[]=[];
 try{while(true){const {value,done}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>2000000)throw Error('Page exceeds 2 MB limit.');chunks.push(value);}}finally{await reader.cancel();}
 const buf=new Uint8Array(bytes);let pos=0;for(const c of chunks){buf.set(c,pos);pos+=c.length;}
 const doc=new DOMParser().parseFromString(new TextDecoder().decode(buf),'text/html');
 if(!doc)throw Error('HTML parsing failed');
 const title=doc.querySelector('title')?.textContent?.trim()||url.hostname;
 const pub=doc.querySelector('meta[property="article:published_time"],meta[name="date"],meta[name="datePublished"]')?.getAttribute('content');
 doc.querySelectorAll('script,style,nav,header,footer,noscript,svg').forEach(e=>e.remove());
 const text=(doc.querySelector('main,article')||doc.body).textContent?.replace(/\s+/g,' ').trim().slice(0,24000)||'';
 if(text.length<120)throw Error('Not enough readable page text.');
 return {url:url.href,title,text,published_at:pub&&!isNaN(Date.parse(pub))?new Date(pub).toISOString():null};
}
const getAI=()=>extractionConfig((name:string)=>Deno.env.get(name));
async function extract(p:any,s:any){return extractCandidates(p,s,getAI(),validateFindings);}
async function execute(p:any,useAI:boolean,saved:any[]=[]){
 const aiReady=!!getAI();
 const deepseekKey=Deno.env.get('DEEPSEEK_API_KEY');
 const deepseek=deepseekKey?createDeepSeekSources({apiKey:deepseekKey,allowedDomains:domains(),allowUrl:(raw:string)=>eligible(raw).href}):null;
 const io={
  now:()=>Date.now(),aiReady,maxSources:5,defaultSourceUrls:policy().defaultSourceUrls,normalizeUrl:(raw:string)=>eligible(raw).href,notices:deepseek?.notices,
  stage:async(stage:string)=>db(admin.from('projects').update({stage,updated_at:new Date().toISOString()}).eq('id',p.id)),
  discover:async()=>{
   if(deepseek)return deepseek.discover(p);
   const key=Deno.env.get('TAVILY_API_KEY');
   if(!key)throw Error('Automatic discovery is not configured. Create a new project with public HTTPS source URLs.');
   const out=await fetch('https://api.tavily.com/search',{method:'POST',signal:AbortSignal.timeout(18000),headers:{'Content-Type':'application/json'},body:JSON.stringify({api_key:key,query:[p.question,p.segment,p.market,p.quarter,...p.competitors].join(' '),max_results:15,include_domains:domains(),search_depth:'basic'})});
   if(!out.ok)throw Error('Search provider failed (HTTP '+out.status+').');
   return ((await out.json()).results||[]).map((r:any)=>r.url);
  },
  fetchSource:deepseek?deepseek.fetchSource:fetchText,
  saveSource:async(source:any)=>{
   const id=crypto.randomUUID();
   await db(admin.from('sources').insert({...source,id,project_id:p.id,retrieved_at:new Date().toISOString(),competitor:'Source-level evidence'}));return id;
  },
  extract:async(project:any,source:any)=>{eligible(source.url);return extract(project,source);},
  saveFindings:async(source_id:string,fs:any[])=>db(admin.from('findings').insert(fs.map(f=>({project_id:p.id,source_id,competitor:f.competitor,field:f.field,original_text:f.text,edited_text:f.text,quote:f.quote})))),
  finish:async(r:any)=>db(admin.from('projects').update({status:r.status,stage:r.stage,errors:r.errors,updated_at:new Date().toISOString()}).eq('id',p.id))
 };
 if(saved.length)await extractSavedResearch(p,saved,io);else await collectResearch(p,io,useAI);
}
Deno.serve(async req=>{
 const origin=req.headers.get('Origin');
 const origins=(Deno.env.get('APP_ORIGINS')||Deno.env.get('APP_ORIGIN')||'http://127.0.0.1:5174,http://127.0.0.1:5175,https://domel-market-intelligence-yd-2026.aptdream17.chatgpt.site').split(',').map(s=>s.trim());
 const cors={...headers,'Access-Control-Allow-Origin':origin&&origins.includes(origin)?origin:origins[0],Vary:'Origin'};
 const reply=(data:unknown,status=200)=>response(data,status,cors);
 if(origin&&!origins.includes(origin))return reply({error:'Frontend origin is not allowed'},403);
 if(req.method==='OPTIONS')return new Response('ok',{headers:cors});
 if(req.method!=='POST')return reply({error:'Method not allowed'},405);
 try{
  const auth=req.headers.get('Authorization')||'';const token=auth.replace(/^Bearer\s+/i,'');if(!token)return reply({error:'Authentication required'},401);
  const {data:{user},error}=await admin.auth.getUser(token);if(error||!user)return reply({error:'Invalid session'},401);
  const body=await req.json();
  if(body.mode==='capabilities')return reply({version:'week6-2026-10-25',ai:!!getAI(),search:!!Deno.env.get('DEEPSEEK_API_KEY')||!!Deno.env.get('TAVILY_API_KEY'),allowed_domains:domains(),default_source_urls:policy().defaultSourceUrls,discovery_mode:'additive',max_sources:5});
  if(body.mode && !['collect','research','extract'].includes(body.mode))return reply({error:'Invalid research mode'},400);
  const resume=body.mode==='extract';
  const useAI=body.mode==='research'||resume;
  if(useAI&&!getAI())return reply({error:'AI extraction is awaiting API configuration. Choose Collect public sources instead.'},409);
  const p=await db(admin.from('projects').select('*').eq('id',body.project_id).eq('owner_id',user.id).single());
  if(!p)return reply({error:'Project not accessible'},404);
  let saved:any[]=[];
  if(resume){
   saved=await db(admin.from('sources').select('*').eq('project_id',p.id).order('retrieved_at',{ascending:true}).order('id',{ascending:true}));
   const existing=await db(admin.from('findings').select('id').eq('project_id',p.id).limit(1));
   try{validateSavedExtraction(p,saved,existing);}catch(e){return reply({error:e instanceof Error?e.message:'Saved extraction is not available'},409);}
  }
  if(!resume&&p.status!=='draft')return reply({error:'This project has already been run. Create a new project for a new research run.'},409);
  try{validateScope(p);}catch(e){return reply({error:e instanceof Error?e.message:'Invalid scope'},400);}
  const running=await db(admin.from('projects').update({status:'running',stage:resume?'Queued for saved-source extraction':'Queued for retrieval',updated_at:new Date().toISOString()}).eq('id',p.id).eq('status',p.status).eq('updated_at',p.updated_at).select('id'));
  if(!running.length)return reply({error:'Research is already running'},409);
  // Supabase background execution has finite runtime limits. Maximum five sources
  // per run is recommended for the Free plan; see README for worker scaling.
  EdgeRuntime.waitUntil(execute(p,useAI,saved));
  return reply({project_id:p.id,status:'running'},202);
 }catch{return reply({error:'Request failed. Verify project access and backend configuration.'},400);}
});

