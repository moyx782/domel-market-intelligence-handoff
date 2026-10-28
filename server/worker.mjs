import {sourcePolicy,publicSourceUrl} from '../supabase/functions/_shared/source-policy.mjs';
import {randomUUID} from 'node:crypto';
import {createClient} from '@supabase/supabase-js';
import {collectResearch,extractSavedResearch} from '../supabase/functions/_shared/research-workflow.mjs';
import {createDeepSeekSources} from '../supabase/functions/_shared/deepseek-search.mjs';
import {extractionConfig,extractCandidates} from '../supabase/functions/_shared/ai-extraction.mjs';
import {validateScope,validateFindings} from '../supabase/functions/_shared/research-validation.mjs';
const required=name=>{if(!process.env[name])throw Error('Missing host setting: '+name);return process.env[name];};
const boundedFetch=(url,options={})=>fetch(url,{...options,signal:options.signal?AbortSignal.any([options.signal,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000)});
const db=createClient(required('SUPABASE_URL'),required('SUPABASE_SERVICE_ROLE_KEY'),{global:{fetch:boundedFetch},auth:{persistSession:false,autoRefreshToken:false}});
const env=process.env.QUEUE_ENV||'development';
const call=async promise=>{const r=await promise;if(r.error)throw Error('Cloud database operation failed');return r.data;};
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let stopping=false;process.on('SIGINT',()=>{stopping=true;});process.on('SIGTERM',()=>{stopping=true;});
async function execute(job){
 let lost=false,beating=false;
 const timer=setInterval(async()=>{if(beating)return;beating=true;try{if(!await call(db.rpc('heartbeat_research',{p_job:job.id,p_token:job.lease_token})))lost=true;}catch{lost=true;}finally{beating=false;}},20000);
 try{
  const p=await call(db.from('projects').select('*').eq('id',job.project_id).single());validateScope(p);
  const {restrictedDomains:domains,defaultSourceUrls}=sourcePolicy(k=>process.env[k]);
  const allowUrl=raw=>publicSourceUrl(raw,domains);
  const adapter=createDeepSeekSources({apiKey:required('DEEPSEEK_API_KEY'),allowedDomains:domains,allowUrl,requestTimeoutMs:30000});
  const saved=[];let outcome;
  const config=extractionConfig(k=>process.env[k]);
  const io={now:()=>Date.now(),aiReady:!!config,maxSources:5,defaultSourceUrls,normalizeUrl:allowUrl,notices:adapter.notices,
   stage:async()=>{if(lost)throw Error('Worker lease lost');},discover:()=>adapter.discover(p),fetchSource:adapter.fetchSource,
   saveSource:async source=>{const id=randomUUID();saved.push({...source,id,retrieved_at:new Date().toISOString(),findings:[]});return id;},
   extract:async(project,source)=>{allowUrl(source.url);if(lost)throw Error('Worker lease lost');return extractCandidates(project,source,config,validateFindings);},
   saveFindings:async(id,findings)=>{let source=saved.find(s=>s.id===id);if(!source){source={id,findings:[]};saved.push(source);}source.findings.push(...findings);},
   finish:async result=>{outcome=result;}
  };
  if(job.mode==='extract')await extractSavedResearch(p,await call(db.from('sources').select('*').eq('project_id',p.id)),io);
  else await collectResearch(p,io,job.mode==='research');
  if(lost)throw Error('Worker lease lost');
  // Retry the same atomic commit, not provider calls, after a transient cloud error.
  for(let i=0;i<3;i++){try{await call(db.rpc('finish_research',{p_job:job.id,p_token:job.lease_token,p_result:outcome,p_sources:saved}));return;}catch{if(i===2)throw Error('Result commit failed');await delay(1000*(i+1));}}
 }finally{clearInterval(timer);}
}
console.log('Host worker started in environment '+env);
while(!stopping){try{const jobs=await call(db.rpc('claim_research',{p_environment:env}));if(jobs.length){try{await execute(jobs[0]);console.log('Job finished '+jobs[0].id);}catch{console.error('Job interrupted; lease recovery will retry it.');}}else await delay(2000);}catch{console.error('Queue unavailable; retrying.');await delay(5000);}}

