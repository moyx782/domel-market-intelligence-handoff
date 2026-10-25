// Shared orchestration. Real I/O is injected so failure paths can be tested.
export async function collectResearch(project, io, useAI = false) {
 const errors = []; let sources = 0, findings = 0;
 const started = io.now();
 try {
  if (useAI && !io.aiReady) throw Error('AI extraction is awaiting API configuration. Choose Collect public sources to save evidence without AI.');
  let urls = project.source_urls;
  if (!urls.length) { await io.stage('Discovering public sources'); urls = await io.discover(project); }
  const unique = [...new Set(urls)];
  const selected = unique.slice(0, io.maxSources ?? 15);
  if (selected.length < unique.length) errors.push(`Source limit reached: processing ${selected.length} of ${unique.length} URLs; coverage is incomplete.`);
  if (!selected.length) errors.push('No source URLs were found. Supply approved public HTML pages in a new project.');
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
   stage: useAI && findings ? 'Ready for evidence review' : sources ? 'Sources saved — AI extraction not completed' : 'No usable sources saved',
   errors, sources, findings
  };
  await io.finish(result); return result;
 } catch (error) {
  const result = {status:'failed',stage:'Research could not complete',errors:[...errors,error instanceof Error ? error.message : 'Unexpected research error'],sources,findings};
  await io.finish(result); return result;
 }
}
