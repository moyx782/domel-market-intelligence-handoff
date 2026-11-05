// Additive local API. Reads/writes are guarded by the existing role model.
export async function exhibitionRoutes({path,method,body,studies,queue,store,allowed,send}){
 if(!path.startsWith('/api/v1/exhibition-studies'))return false;
 if(!studies||!queue){send(503,{error:'Exhibition capture is not configured'});return true;}
 if(!allowed(method==='GET'?'business:read':'business:write')){send(403,{error:'This role cannot perform exhibition research'});return true;}
 const schedule=async s=>{for(const p of s.pages.filter(p=>p.state!=='captured'))await queue.create({kind:'exhibition.capture',projectId:s.id,sourceId:p.id,priority:1,payload:{studyId:s.id,pageId:p.id}});};
 try{
  if(path==='/api/v1/exhibition-studies'){
   if(method==='GET')send(200,{studies:studies.list()});
   else if(method==='POST'){const s=studies.create(body);await schedule(s);send(201,s);}
   else send(405,{error:'Method not allowed'});
   return true;
  }
  const match=path.match(/^\/api\/v1\/exhibition-studies\/([0-9a-f-]{36})(?:\/(resume|cancel|export|publish|analyse|evidence)(?:\/([0-9a-f-]{36}))?)?$/i);
  if(!match){send(404,{error:'Route not found'});return true;}
  const [,id,action,evidenceId]=match,s=studies.get(id);
  if(method==='GET'&&!action)send(200,s);
  else if(method==='GET'&&action==='export')send(200,s);
  else if(method==='GET'&&action==='evidence')send(200,studies.artifact(id,evidenceId));
  else if(method==='POST'&&action==='resume'){
   studies.pause(id,false);
   if(body.url)studies.add(id,body.url,body.stage||'directory',body.parentId);
   await schedule(studies.get(id));send(202,studies.get(id));
  }else if(method==='POST'&&action==='cancel'){
   studies.pause(id,true);
   for(const task of queue.list({projectId:id,limit:Number.MAX_SAFE_INTEGER}).filter(t=>['queued','running'].includes(t.state)))await queue.cancel(task.id);
   send(200,studies.get(id));
  }else if(method==='POST'&&action==='analyse'){
   if(s.coverage.pending||queue.list?.({projectId:id,kind:'exhibition.capture',limit:Number.MAX_SAFE_INTEGER}).some(t=>['queued','running'].includes(t.state)))throw Error('Wait until capture tasks finish before screening');
   if((s.coverage.failed||s.gaps.length||s.knownExhibitorTotal===null||s.coverage.missingCompanies>0)&&body.acceptPartial!==true)throw Error('Explicitly acknowledge incomplete coverage before analysing a partial snapshot');
   send(202,await queue.create({kind:'exhibition.analyse',projectId:id,priority:0,payload:{studyId:id}}));
  }else if(method==='POST'&&action==='publish'){
   if(s.coverage.pending||queue.list?.({projectId:id,kind:'exhibition.capture',limit:Number.MAX_SAFE_INTEGER}).some(t=>['queued','running'].includes(t.state)))throw Error('Wait until capture tasks finish before screening or publishing');
   if(s.projectId){send(200,{projectId:s.projectId});return true;}
   if((s.coverage.failed||s.gaps.length||s.coverage.missingCompanies>0||s.knownExhibitorTotal===null)&&body.acceptPartial!==true)throw Error('Coverage is incomplete or unverified. Review gaps and explicitly accept a partial snapshot');
   const project=await store.createProject({title:s.name+' '+s.edition,question:'Exhibition → exhibitors → products → parameters and prices. Capture all public entries before screening. Potential downstream appliance customers are included; no inferred supply relationships.',segment:s.name,market:'Defined in research brief',quarter:new Date().getFullYear()+'-Q'+(Math.floor(new Date().getMonth()/3)+1),competitors:['Research subject'],focus:['Research findings'],source_urls:[]});
   const job=await store.enqueue(project.id,'agent');await store.startJob(job.id);
   const subject=f=>{const p=s.products.find(p=>p.id===f.subjectId),c=s.companies.find(c=>c.id===(p?.companyId||f.subjectId));return [c?.name,p?.name,p?.model].filter(Boolean).join(' / ')||s.name;};
   const savedSources=s.evidence.map(e=>({id:e.id,url:e.url,title:e.title,text:e.text,published_at:null,retrieved_at:e.capturedAt,findings:s.facts.filter(f=>f.evidenceId===e.id&&f.quote.length>=30&&f.quote.length<=1200&&e.text.includes(f.quote)).map(f=>({competitor:'Research subject',field:'Research findings',text:[subject(f),f.field+': '+f.value,f.unit,f.conditions,f.currency,f.priceBasis,'Source edition: '+(f.sourceEdition||'unknown')].filter(Boolean).join(' | ').slice(0,1000),quote:f.quote}))}));
   const count=savedSources.reduce((n,s)=>n+s.findings.length,0);
   await store.completeJob(job.id,{status:'partial',stage:count?'Exhibition facts ready for human review':'No importable facts; inspect capture evidence',errors:[s.coverage.notice,...s.gaps.map(g=>g.url+': '+g.message)],sources:savedSources.length,findings:count},savedSources);
   studies.linkProject(id,project.id);send(201,{projectId:project.id,findings:count});
  }else send(405,{error:'Method not allowed'});
 }catch(error){send(409,{error:error.message});}
 return true;
}
