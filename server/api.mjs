import {sourcePolicy} from '../supabase/functions/_shared/source-policy.mjs';
import {createServer} from 'node:http';
import {pathToFileURL} from 'node:url';
import {createClient} from '@supabase/supabase-js';
import {extractionConfig} from '../supabase/functions/_shared/ai-extraction.mjs';
import {validateScope} from '../supabase/functions/_shared/research-validation.mjs';
export function apiServer({clientForToken,environment='development',origins=['http://127.0.0.1:5174','http://127.0.0.1:5175'],capabilities={}}){
 return createServer(async(req,res)=>{
  const origin=req.headers.origin;
  const send=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store',...(origin&&origins.includes(origin)?{'Access-Control-Allow-Origin':origin,Vary:'Origin'}:{})});res.end(JSON.stringify(data));};
  if(origin&&!origins.includes(origin))return send(403,{error:'Frontend origin is not allowed'});
  if(req.method==='OPTIONS'){res.setHeader('Access-Control-Allow-Headers','Authorization,Content-Type');res.setHeader('Access-Control-Allow-Methods','GET,POST,PATCH,OPTIONS');return send(200,{});}
  const path=new URL(req.url,'http://localhost').pathname;
  if(path==='/health'&&req.method==='GET')return send(200,{status:'ok',architecture:'host-api-cloud-supabase'});
  const token=req.headers.authorization?.match(/^Bearer (.+)$/i)?.[1];
  if(!token)return send(401,{error:'Authentication required'});
  try{
   const db=clientForToken(token);const auth=await db.auth.getUser(token);
   if(auth.error||!auth.data.user)return send(401,{error:'Invalid session'});
   const user=auth.data.user;
   const result=async promise=>{const r=await promise;if(r.error)throw r.error;return r.data;};
   let body={};if(['POST','PATCH'].includes(req.method)){
    let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>64000)return send(413,{error:'Request too large'});chunks.push(chunk);}
    try{body=JSON.parse(Buffer.concat(chunks).toString()||'{}');}catch{return send(400,{error:'Invalid JSON'});}
   }
   if(path==='/api/v1/capabilities'&&req.method==='GET')return send(200,{version:'host-v1',execution:'host-queue',environment,...capabilities});
   if(path==='/api/v1/workspace'&&req.method==='GET'){
    const names=['projects','sources','findings','review_events','reports'];const rows=await Promise.all(names.map(t=>result(db.from(t).select('*'))));
    return send(200,{projects:rows[0],sources:rows[1],findings:rows[2],audits:rows[3],reports:rows[4]});
   }
   if(path==='/api/v1/research-tasks'&&req.method==='POST'){
    const scope=Object.fromEntries(['title','question','segment','market','quarter','competitors','focus','source_urls'].map(k=>[k,body[k]]));
    try{validateScope(scope);}catch{return send(400,{error:'Invalid research scope'});}
    return send(201,await result(db.from('projects').insert({...scope,owner_id:user.id}).select().single()));
   }
   const run=path.match(/^\/api\/v1\/research-tasks\/([0-9a-f-]{36})\/run$/i);
   if(run&&req.method==='POST'){
    if(!['collect','research','extract'].includes(body.mode))return send(400,{error:'Invalid research mode'});
    if(body.mode!=='collect'&&!capabilities.ai)return send(409,{error:'AI extraction is not configured on the team host'});
    return send(202,await result(db.rpc('enqueue_research',{p_project:run[1],p_mode:body.mode,p_environment:environment})));
   }
   if(path==='/api/v1/research-jobs'&&req.method==='GET')return send(200,await result(db.from('research_jobs').select('id,project_id,environment,mode,state,priority,attempt,created_at,updated_at').eq('environment',environment).order('created_at',{ascending:false}).limit(100)));
   const review=path.match(/^\/api\/v1\/insights\/([0-9a-f-]{36})\/review$/i);
   if(review&&req.method==='PATCH')return send(200,await result(db.rpc('review_finding',{p_id:review[1],p_text:body.text,p_decision:body.decision,p_revision:body.revision})));
   if(path==='/api/v1/reports'&&req.method==='POST')return send(201,await result(db.rpc('generate_report',{p_project:body.project_id})));
   return send(404,{error:'Route not found'});
  }catch(e){const permitted=/Project not accessible|already queued|Saved extraction is unavailable|new research run|finding changed|Finding not accessible|Accept at least one|Supporting source|Invalid decision|Invalid finding wording/;return send(409,{error:permitted.test(e?.message||'')?e.message:'Operation failed. Check host configuration and database migrations.'});}
 });
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const url=process.env.SUPABASE_URL||process.env.VITE_SUPABASE_URL,key=process.env.SUPABASE_PUBLISHABLE_KEY||process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
 if(!url||!key)throw Error('Configure Supabase public URL and publishable key for the API.');
 const policy=sourcePolicy(k=>process.env[k]);
 const server=apiServer({environment:process.env.QUEUE_ENV||'development',origins:(process.env.APP_ORIGINS||'http://127.0.0.1:5174,http://127.0.0.1:5175').split(','),clientForToken:token=>createClient(url,key,{global:{headers:{Authorization:'Bearer '+token}},auth:{persistSession:false,autoRefreshToken:false}}),capabilities:{ai:!!extractionConfig(k=>process.env[k]),search:!!process.env.DEEPSEEK_API_KEY,allowed_domains:policy.restrictedDomains,default_source_urls:policy.defaultSourceUrls,discovery_mode:'additive',max_sources:5}});
 server.requestTimeout=15000;server.headersTimeout=10000;server.listen(Number(process.env.API_PORT||8787),process.env.API_BIND||'127.0.0.1',()=>console.log('Host API ready'));
}

