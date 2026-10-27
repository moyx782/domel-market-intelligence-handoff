import {mkdirSync,writeFileSync} from 'node:fs';
const required=['SUPABASE_URL','SUPABASE_PUBLISHABLE_KEY','SUPABASE_SERVICE_ROLE_KEY','DEEPSEEK_API_KEY'];
const configured=Object.fromEntries(required.map(k=>[k,!!process.env[k]?.trim()&&!process.env[k].includes('YOUR_PROJECT')]));
const checks=[];
async function probe(name,url,headers={}){
 try{const r=await fetch(url,{headers,signal:AbortSignal.timeout(8000)});checks.push({name,status:r.status,ok:r.ok});return r;}catch{checks.push({name,ok:false,reason:'Cannot connect or request timed out'});}
}
await probe('host_api','http://127.0.0.1:'+(process.env.API_PORT||8787)+'/health');
const protectedResponse=await probe('api_rejects_anonymous','http://127.0.0.1:'+(process.env.API_PORT||8787)+'/api/v1/workspace');
if(protectedResponse)checks.at(-1).ok=protectedResponse.status===401;
if(configured.SUPABASE_URL&&configured.SUPABASE_PUBLISHABLE_KEY)await probe('cloud_auth_public_configuration',process.env.SUPABASE_URL+'/auth/v1/settings',{apikey:process.env.SUPABASE_PUBLISHABLE_KEY});
if(configured.SUPABASE_URL&&configured.SUPABASE_SERVICE_ROLE_KEY)await probe('queue_table_available',process.env.SUPABASE_URL+'/rest/v1/research_jobs?select=id&limit=0',{apikey:process.env.SUPABASE_SERVICE_ROLE_KEY,Authorization:'Bearer '+process.env.SUPABASE_SERVICE_ROLE_KEY});
const report={captured_at:new Date().toISOString(),configured,checks,ready:required.every(k=>configured[k])&&checks.every(c=>c.ok),limits:['Read-only checks only. No jobs claimed, no provider billing test, no migration applied.','Keys are never included in this record.']};
mkdirSync('evidence/host-readiness',{recursive:true});const path='evidence/host-readiness/'+new Date().toISOString().replace(/[:.]/g,'-')+'.json';writeFileSync(path,JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));console.log('Evidence: '+path);
