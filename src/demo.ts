import type {Bundle,Project} from './types';
// crypto.randomUUID is only exposed in secure contexts (HTTPS or localhost).
// The LAN demo is served over plain HTTP, so keep a UUID v4 fallback.
export const uid=()=>{
 if(typeof crypto!=='undefined'&&typeof crypto.randomUUID==='function')return crypto.randomUUID();
 const bytes=new Uint8Array(16);
 if(typeof crypto!=='undefined'&&typeof crypto.getRandomValues==='function')crypto.getRandomValues(bytes);
 else for(let i=0;i<16;i++)bytes[i]=Math.floor(Math.random()*256);
 bytes[6]=(bytes[6]&0x0f)|0x40;
 bytes[8]=(bytes[8]&0x3f)|0x80;
 const hex=Array.from(bytes,byte=>byte.toString(16).padStart(2,'0')).join('');
 return hex.slice(0,8)+'-'+hex.slice(8,12)+'-'+hex.slice(12,16)+'-'+hex.slice(16,20)+'-'+hex.slice(20);
};
export function demoBundle():Bundle {
  const now=new Date().toISOString();
  const project:Project={id:'demo-project',owner_id:'demo-user',title:'EC motors · Quarterly competitor review',question:'How do competitors position their EC motor solutions for ventilation applications?',segment:'EC motors for HVAC',market:'European Union',quarter:'2026-Q3',competitors:['ebm-papst','Nidec','AMETEK'],focus:['Product portfolio','Technology','Market activity'],source_urls:[],status:'completed',stage:'Ready for evidence review',errors:['Illustrative fixture: sources were not retrieved and claims are not verified. Do not use for business decisions.'],created_at:now,updated_at:now};
  const sources=project.competitors.map((c,i)=>({id:'demo-source-'+i,project_id:project.id,competitor:c,url:['https://www.ebmpapst.com/','https://www.nidec.com/en/','https://www.ametek.com/'][i],title:c+' · Illustrative evidence fixture',published_at:null,retrieved_at:now,text:'DEMO FIXTURE — This passage is invented for interface testing, not quoted from the linked website. '+c+' describes motor solutions for industrial applications. Product specifications and quarterly activity require verification.'}));
  const findings=sources.map((s,i)=>({id:'demo-finding-'+i,project_id:project.id,source_id:s.id,competitor:s.competitor,field:project.focus[i],original_text:'Illustrative finding: '+s.competitor+' offers industrial motor solutions. Verify product fit and quarterly relevance.',edited_text:'Illustrative finding: '+s.competitor+' offers industrial motor solutions. Verify product fit and quarterly relevance.',quote:s.text,decision:'pending' as const,revision:1,reviewer_id:null,reviewed_at:null}));
  return {projects:[project],sources,findings,audits:[],reports:[]};
}
