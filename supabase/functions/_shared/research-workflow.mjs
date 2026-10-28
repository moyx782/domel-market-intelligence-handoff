// Shared orchestration. Real I/O is injected so failure paths can be tested.
export async function collectResearch(project, io, useAI = false) {
 const errors = []; let sources = 0, findings = 0;
 const started = io.now();
 try {
  if (useAI && !io.aiReady) throw Error('AI extraction is awaiting API configuration. Choose Collect public sources to save evidence without AI.');
  let discovered=[];
  if (io.discover) {
   await io.stage('Discovering additional public sources');
   try { discovered=await io.discover(project); }
   catch(error) { errors.push(`Automatic discovery failed: ${error instanceof Error ? error.message : 'Search unavailable'}. Provided and default URLs will still be processed.`); }
  }
  const canonical=raw=>{try{const u=new URL(raw);u.hash='';return u.href;}catch{return raw;}};
  const seen=new Set();
  const pools=[project.source_urls||[],io.defaultSourceUrls||[],discovered].map(urls=>{
   const domains=new Map();
   for(const raw of urls){
    let url;
    try{url=io.normalizeUrl?io.normalizeUrl(raw):canonical(raw);}
    catch(error){errors.push(`Excluded source URL: ${error instanceof Error?error.message:'Invalid URL'}`);continue;}
    if(seen.has(url))continue;seen.add(url);
    let host;try{host=new URL(url).hostname;}catch{host=url;}
    if(!domains.has(host))domains.set(host,[]);domains.get(host).push(url);
   }
   const ordered=[];
   while(domains.size)for(const [host,queue] of domains){ordered.push(queue.shift());if(!queue.length)domains.delete(host);}
   return ordered;
  });
  // Round-robin across user, default and discovered URLs, then across domains
  // within each pool. Neither a long preference list nor one host crowds out search.
  const unique=[];
  while(pools.some(pool=>pool.length))for(const pool of pools)if(pool.length)unique.push(pool.shift());
  const selected = unique.slice(0, io.maxSources ?? 15);
  if (selected.length < unique.length) errors.push(`Source limit reached: processing ${selected.length} of ${unique.length} URLs; coverage is incomplete.`);
  if (!selected.length) errors.push('No source URLs were found. Supply public HTTPS pages or check automatic search configuration.');
  for (const [i, url] of selected.entries()) {
   if (io.now() - started > 85000) { errors.push('Execution time limit reached. Remaining pages were not retrieved.'); break; }
   try {
    await io.stage(`Retrieving source ${i + 1} of ${selected.length}`);
    const source = await io.fetchSource(url);
    const sourceId = await io.saveSource(source); sources++;
    if (!source.published_at) errors.push(`Publication date unknown: ${source.url}. Quarter relevance has not been verified.`);
    if (useAI) {
     await io.stage(`Extracting candidates from source ${i + 1}`);
     const candidates = await io.extract(project, source);
     if (!candidates.length) errors.push(`No supported in-scope findings: ${source.url}`);
     else { await io.saveFindings(sourceId, candidates); findings += candidates.length; }
    }
   } catch (error) { errors.push(`${url}: ${error instanceof Error ? error.message : 'Source processing failed'}`); }
  }
  if (io.notices) errors.push(...io.notices);
  if (!useAI) errors.push('Source collection only. AI extraction has not run; collected pages are not approved findings and their market/quarter relevance needs human verification.');
  const result = {
   status: useAI && findings ? (errors.length ? 'partial' : 'completed') : sources ? 'partial' : 'failed',
   stage: useAI && findings ? 'Ready for evidence review' : sources ? 'Sources saved �� AI extraction not completed' : 'No usable sources saved',
   errors, sources, findings
  };
  await io.finish(result); return result;
 } catch (error) {
  const result = {status:'failed',stage:'Research could not complete',errors:[...errors,error instanceof Error ? error.message : 'Unexpected research error'],sources,findings};
  await io.finish(result); return result;
 }
}

export function validateSavedExtraction(project,sources,existingFindings) {
 if(!['partial','failed','completed'].includes(project.status))throw Error('Finish source collection before extracting saved sources.');
 if(existingFindings.length)throw Error('This project already has candidate findings. Review them or create a new research project.');
 if(!sources.length)throw Error('No saved sources are available for extraction.');
 if(sources.some(s=>s.project_id!==project.id))throw Error('Source does not belong to this project.');
}
export async function extractSavedResearch(project,saved,io) {
 // Use saved IDs as work keys: two URLs may redirect to the same final URL.
 // Neither network retrieval nor source insertion is called on this path.
 const byId=new Map(saved.map(s=>[s.id,s]));
 const prior=(project.errors||[]).filter(e=>!e.startsWith('Source collection only.'));
 return collectResearch({...project,source_urls:saved.map(s=>s.id)}, {
  ...io,
  notices:[...prior.map(e=>'Prior collection notice: '+e),...(io.notices||[])],
  stage:stage=>io.stage(stage.replace('Retrieving source','Reading saved source')),
  discover:null,defaultSourceUrls:[],normalizeUrl:undefined,
  fetchSource:async id=>{const s=byId.get(id);if(!s)throw Error('Saved source unavailable.');return s;},
  saveSource:async source=>source.id,
 },true);
}

