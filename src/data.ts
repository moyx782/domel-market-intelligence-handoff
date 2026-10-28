import {createClient} from '@supabase/supabase-js';
import type {Bundle,Project,Decision,Report} from './types';
import {demoBundle,uid} from './demo';
import {reviewedFinding,reportSnapshot} from './rules.mjs';
import {passwordIntent} from './auth-flow.mjs';
export const initialPasswordSetup=passwordIntent(window.location.href);
if(initialPasswordSetup)sessionStorage.removeItem('domel.demo');
const url=import.meta.env.VITE_SUPABASE_URL,key=import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
export const supabase=url&&key?createClient(url,key):null;
const hostMode=import.meta.env.VITE_EXECUTION_MODE!=='legacy-edge';
const hostUrl=(import.meta.env.VITE_BACKEND_URL||'http://127.0.0.1:8787').replace(/\/$/,'');
async function hostRequest(path:string,method='GET',body?:unknown){
 const {data}=await supabase!.auth.getSession();
 if(!data.session)throw Error('Please sign in again.');
 let response:Response;
 try{response=await fetch(hostUrl+path,{method,signal:AbortSignal.timeout(20000),headers:{Authorization:'Bearer '+data.session.access_token,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});}catch{throw Error('Cannot connect to the team Backend API. Check that the host is running and VITE_BACKEND_URL is correct.');}
 const payload=await response.json();if(!response.ok)throw Error(payload.error||'Backend request failed');return payload;
}
const storage='domel.mvi.demo.v1';
export const readDemo=():Bundle=>{try{const saved=localStorage.getItem(storage);const b=saved?JSON.parse(saved):demoBundle();if(!['projects','sources','findings','audits','reports'].every(k=>Array.isArray(b[k])))throw Error('Invalid demo storage');return b;}catch{return demoBundle();}};
const saveDemo=(b:Bundle)=>{try{localStorage.setItem(storage,JSON.stringify(b));}catch{throw Error('Browser storage is unavailable or full. Changes were not saved. Enable local storage or use the live workspace.');}};
export async function load(demo:boolean):Promise<Bundle>{
 if(demo)return readDemo();
 if(!supabase)throw Error('Supabase is not configured.');
 if(hostMode)return hostRequest('/api/v1/workspace');
 const tables=['projects','sources','findings','review_events','reports'];
 const rs=await Promise.all(tables.map(t=>supabase!.from(t).select('*')));
 for(const r of rs)if(r.error)throw r.error;
 return {projects:rs[0].data!,sources:rs[1].data!,findings:rs[2].data!,audits:rs[3].data!,reports:rs[4].data!} as Bundle;
}
export async function createProject(p:Omit<Project,'id'|'created_at'|'updated_at'|'status'|'stage'|'errors'>,demo:boolean){
 const now=new Date().toISOString();const row={...p,id:uid(),created_at:now,updated_at:now,status:'draft',stage:'Not started',errors:[]};
 if(demo){const b=readDemo();b.projects.unshift(row);saveDemo(b);return row;}
 if(hostMode)return hostRequest('/api/v1/research-tasks','POST',p);
 const {data,error}=await supabase!.from('projects').insert(row).select().single();if(error)throw error;return data as Project;
}
export async function runResearch(id:string,demo:boolean,mode:'collect'|'research'|'extract'='collect'){
 if(demo){const b=readDemo(),p=b.projects.find(p=>p.id===id)!;p.status='completed';p.stage='Demo workflow completed';p.errors=['Demo mode does not perform web retrieval or AI extraction. This new project has no findings. Connect the live backend to run research.'];saveDemo(b);return;}
 if(hostMode){await hostRequest('/api/v1/research-tasks/'+id+'/run','POST',{mode});return;}
 const {data,error}=await supabase!.functions.invoke('research',{body:{project_id:id,mode}});if(error){let detail='Research request failed. Check the deployed function and its allowed origin.';try{const body=await error.context?.json();if(body?.error)detail=body.error;}catch{}throw Error(detail);}if(data?.error)throw Error(data.error);
}
export async function review(id:string,text:string,decision:Decision,actor:string,revision:number,demo:boolean){
 if(demo){const b=readDemo(),idx=b.findings.findIndex(f=>f.id===id),old=b.findings[idx];if(old.revision!==revision)throw Error('This finding changed. Refresh and try again.');const now=new Date().toISOString(),next=reviewedFinding(old,text,decision,actor,now);b.findings[idx]=next;b.audits.unshift({id:uid(),finding_id:id,actor_id:actor,action:old.edited_text!==next.edited_text?'edit':decision,old_text:old.edited_text,new_text:next.edited_text,decision:next.decision,created_at:now,revision:next.revision});saveDemo(b);return;}
 if(hostMode){await hostRequest('/api/v1/insights/'+id+'/review','PATCH',{text,decision,revision});return;}
 const {error}=await supabase!.rpc('review_finding',{p_id:id,p_text:text,p_decision:decision,p_revision:revision});if(error)throw error;
}
export async function generateReport(id:string,demo:boolean):Promise<Report>{
 if(demo){const b=readDemo(),p=b.projects.find(p=>p.id===id)!;if(!b.findings.some(f=>f.project_id===id&&f.decision==='accepted'))throw Error('Accept at least one finding before generating a report.');const row={id:uid(),project_id:id,version:b.reports.filter(r=>r.project_id===id).length+1,created_at:new Date().toISOString(),snapshot:reportSnapshot(p,b.findings,b.sources)};b.reports.unshift(row);saveDemo(b);return row;}
 if(hostMode)return hostRequest('/api/v1/reports','POST',{project_id:id});
 const {data,error}=await supabase!.rpc('generate_report',{p_project:id});if(error)throw error;return data as Report;
}

export async function backendCapabilities(){
 if(!supabase)throw Error('Supabase is not configured.');
 if(hostMode)return hostRequest('/api/v1/capabilities');
 const {data,error}=await supabase.functions.invoke('research',{body:{mode:'capabilities'}});
 if(error||!data?.version)throw Error('Backend check unavailable. Deploy the Week 6 research function and check your session.');
 return data as {version:string;ai:boolean;search:boolean;allowed_domains:string[];default_source_urls?:string[];discovery_mode?:string;max_sources:number};
}

export const usesHostBackend=hostMode;
export async function hostJobs(){return hostRequest("/api/v1/research-jobs");}

